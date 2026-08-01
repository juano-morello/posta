import { DeleteObjectsCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  eventPrefixes,
  insertEventsBatch,
  links,
  newId,
  runSqlMigrations,
  user,
  type DbClient,
  type NewEvent,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from '../batch/flush';
import {
  buildReplayReport,
  replayWithReport,
  EXIT_OK,
  EXIT_RECONCILIATION_MISMATCH,
  ReplayReportBatchSizeError,
  type ReplayCounts,
} from './replay-report';
import path from 'node:path';

// T3.6.5 (E3, S3.6) [INV-7][INV-8] — this suite proves the plan's own
// verify text for replay's reconciliation report: (1) the
// `inserted + skipped = parsed` arithmetic holds on a clean range, (2) a
// half-populated range (some rows already present in Postgres BEFORE
// replay runs) reports a genuinely non-zero `rowsSkipped`, and (3) a
// forced mismatch (arithmetic that does not add up) causes a non-zero
// exit — proved directly against `buildReplayReport`'s own pure
// reconciliation arithmetic, with fabricated counts, since the real
// pipeline below can never organically produce a mismatch (rowsInserted/
// rowsSkipped are derived by partitioning recordsParsed batch by batch —
// see replay-report.ts's own header for why that identity holds by
// construction on today's code path).
//
// (1) and (2) run against REAL Postgres (testcontainers) and the REAL
// shared MinIO instance — same discipline replay-driver.test.ts and
// replay.test.ts already establish, no mocked DB anywhere in this file.

const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// A random UTC day in a window no other test in this repo uses (checked:
// flush.test.ts/coupled-writes.test.ts use 2026, default-partition.test.ts
// uses 2031, stream-read.test.ts uses ~2033±8y, reconciliation.test.ts
// (worker batch reconciliation, unrelated to this file) uses 2050-2057,
// replay-driver.test.ts uses 2090-2098, replay.test.ts uses 2110-2126) —
// this worktree's MinIO bucket is shared with concurrent sibling
// agents/tests, so a random, wide, previously-unused window keeps a
// same-day collision vanishingly unlikely, same precedent those files
// already establish.
const FIXTURE_DAY_MS = Date.UTC(2140, 0, 1) + Math.floor(Math.random() * 2920) * ONE_DAY_MS;
const FIXTURE_HOUR_OFFSET = 7;
const FIXTURE_OCCURRED_AT = new Date(FIXTURE_DAY_MS + FIXTURE_HOUR_OFFSET * ONE_HOUR_MS).toISOString();
const DAY_INSTANT = new Date(FIXTURE_DAY_MS).toISOString();

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function buildCaptureEvent(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: FIXTURE_OCCURRED_AT,
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: DESKTOP_CHROME_UA,
    referer: null,
    accept: null,
    accept_language: null,
    sec_fetch_site: null,
    sec_fetch_mode: null,
    sec_fetch_dest: null,
    sec_fetch_user: null,
    sec_purpose: null,
    sec_ch_ua: null,
    sec_ch_ua_mobile: null,
    sec_ch_ua_platform: null,
    purpose: null,
    x_purpose: null,
    x_moz: null,
    country: null,
    asn: null,
    visitor_hash: null,
    ...overrides,
  };
}

async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

async function seedLink(
  handle: PgContainerHandle,
  tenantId: string,
  slug: string,
  destination: string,
): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({ id: linkId, tenantId, slug, destination });
  return linkId;
}

async function countTenantRows(handle: PgContainerHandle, tenantId: string): Promise<number> {
  const result = await handle.pool.query('SELECT event_id FROM events WHERE tenant_id = $1', [tenantId]);
  return result.rows.length;
}

/** Builds a minimal, directly-insertable `NewEvent` for the SAME
 * (event_id, occurred_at) pair a `CaptureEvent` fixture carries — used
 * ONLY to simulate "a row already present before replay runs" (the
 * half-populated-range scenario). Deliberately NOT `toNewEventRow`
 * (apps/worker/src/batch/flush.ts): that function's input is a
 * `LoggedEvent` (`CaptureEvent & EnrichmentResult`), and this test never
 * runs real enrichment over these fixtures — it only needs the primary
 * key (`event_id`, `occurred_at`) and the NOT NULL columns to match, so
 * `insertEventsBatch`'s own ON CONFLICT target collides with what replay
 * later tries to insert for the same row. Row CONTENT is not asserted
 * anywhere in this file; only that it exists and conflicts correctly. */
function buildPreInsertedRow(captureEvent: CaptureEvent): NewEvent {
  return {
    eventId: captureEvent.event_id,
    occurredAt: new Date(captureEvent.occurred_at),
    tenantId: captureEvent.tenant_id,
    linkId: captureEvent.link_id,
    slug: captureEvent.slug,
    visitorHash: captureEvent.visitor_hash,
    httpMethod: captureEvent.http_method,
    userAgent: captureEvent.user_agent,
    referer: captureEvent.referer,
    accept: captureEvent.accept,
    acceptLanguage: captureEvent.accept_language,
    secFetchSite: captureEvent.sec_fetch_site,
    secFetchMode: captureEvent.sec_fetch_mode,
    secFetchDest: captureEvent.sec_fetch_dest,
    secFetchUser: captureEvent.sec_fetch_user,
    secPurpose: captureEvent.sec_purpose,
    secChUa: captureEvent.sec_ch_ua,
    secChUaMobile: captureEvent.sec_ch_ua_mobile,
    secChUaPlatform: captureEvent.sec_ch_ua_platform,
    purpose: captureEvent.purpose,
    xPurpose: captureEvent.x_purpose,
    xMoz: captureEvent.x_moz,
    country: captureEvent.country,
    asn: captureEvent.asn,
    browser: null,
    browserVersion: null,
    os: null,
    deviceType: null,
    sourcePlatform: 'direct',
    isInApp: false,
    destHost: null,
  };
}

// ---------------------------------------------------------------------
// buildReplayReport — pure arithmetic, no containers. Proves the
// reconciliation guard itself: a consistent count set reconciles and
// exits 0, an inconsistent one (fabricated on purpose — see this file's
// own header) never does.
// ---------------------------------------------------------------------
describe('buildReplayReport (T3.6.5) — the reconciliation guard [plan: "inserted + skipped = parsed asserted before exit"]', () => {
  it('reconciles and exits 0 when inserted + skipped = parsed, with zero rejections', () => {
    const counts: ReplayCounts = {
      objectsRead: 3,
      recordsParsed: 10,
      rowsInserted: 7,
      rowsSkipped: 3,
      rejectionReasons: [],
    };

    const report = buildReplayReport(counts);

    expect(report.reconciled).toBe(true);
    expect(report.exitCode).toBe(EXIT_OK);
    expect(report.rowsRejected).toBe(0);
  });

  it('reconciles when inserted + skipped = parsed even alongside a non-zero, separately-tracked rejected count', () => {
    const counts: ReplayCounts = {
      objectsRead: 2,
      recordsParsed: 5,
      rowsInserted: 5,
      rowsSkipped: 0,
      rejectionReasons: [{ reason: 'tenant_id: Invalid input', count: 2 }],
    };

    const report = buildReplayReport(counts);

    expect(report.reconciled).toBe(true);
    expect(report.exitCode).toBe(EXIT_OK);
    expect(report.rowsRejected).toBe(2);
  });

  it('[forced mismatch] does NOT reconcile and exits non-zero when inserted + skipped != parsed', () => {
    const counts: ReplayCounts = {
      objectsRead: 4,
      recordsParsed: 40,
      rowsInserted: 30,
      rowsSkipped: 5, // 30 + 5 = 35, not 40 — 5 rows unaccounted for
      rejectionReasons: [],
    };

    const report = buildReplayReport(counts);

    expect(report.reconciled).toBe(false);
    expect(report.exitCode).toBe(EXIT_RECONCILIATION_MISMATCH);
    expect(report.exitCode).not.toBe(EXIT_OK);
  });

  it('[forced mismatch] a surplus (inserted + skipped > parsed) is equally a mismatch, not just a deficit', () => {
    const counts: ReplayCounts = {
      objectsRead: 1,
      recordsParsed: 10,
      rowsInserted: 8,
      rowsSkipped: 8, // 16 != 10
      rejectionReasons: [],
    };

    const report = buildReplayReport(counts);

    expect(report.reconciled).toBe(false);
    expect(report.exitCode).toBe(EXIT_RECONCILIATION_MISMATCH);
  });
});

// ---------------------------------------------------------------------
// replayWithReport — batchSize upper bound [review round, database-
// reviewer finding: `ReplayReportOptions.batchSize` had NO runtime
// ceiling, even though its own doc comment claimed it carried "the SAME
// 500-row ceiling" replay.ts's own `--batch-size` flag enforces]. No real
// Postgres/R2 needed: an oversized batchSize must be rejected BEFORE
// either is ever touched, so `db`/`r2Client` are Proxies that throw the
// instant any property on them is read — if the guard did not run first,
// `countObjectsUnderPrefixes`/`streamEventLog` would dereference one of
// these Proxies before the guard's own error ever fires, and the
// assertion below (which checks for `ReplayReportBatchSizeError`
// specifically, not just "rejects") would catch that ordering violation
// too. Same "cast-through-unknown fake stands in for both, never
// dereferenced by this code path" precedent replay.test.ts's own
// "runReplayCli — bad arguments" describe block already establishes for
// the identical class of guard on replay.ts's own --batch-size flag.
// ---------------------------------------------------------------------
describe("replayWithReport (T3.6.5) — batchSize upper bound [review round, database-reviewer finding]", () => {
  function untouchableR2Client(): S3Client {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(
            `replayWithReport must not touch r2Client.${String(prop)} before validating batchSize`,
          );
        },
      },
    ) as unknown as S3Client;
  }

  function untouchableDb(): DbClient['db'] {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`replayWithReport must not touch db.${String(prop)} before validating batchSize`);
        },
      },
    ) as unknown as DbClient['db'];
  }

  it('rejects a batchSize over the 500-row ceiling with a named ReplayReportBatchSizeError, before touching R2 or Postgres', async () => {
    await expect(
      replayWithReport({
        db: untouchableDb(),
        r2Client: untouchableR2Client(),
        r2Bucket: 'unused-bucket',
        prefixes: ['unused-prefix/'],
        batchSize: 501,
      }),
    ).rejects.toThrow(ReplayReportBatchSizeError);
  });

  it('names the offending value (501) and the 500-row limit in the error message', async () => {
    await expect(
      replayWithReport({
        db: untouchableDb(),
        r2Client: untouchableR2Client(),
        r2Bucket: 'unused-bucket',
        prefixes: ['unused-prefix/'],
        batchSize: 501,
      }),
    ).rejects.toThrow(/batchSize 501 exceeds the maximum of 500/);
  });
});

// ---------------------------------------------------------------------
// replayWithReport — real Postgres + real MinIO. One beforeAll drives
// three scenarios at once (matching replay-driver.test.ts's own
// "one real fixture, many assertions" shape): a clean batch (proves the
// arithmetic on ordinary data), a subset pre-inserted directly into
// Postgres before replay runs (proves non-zero `rowsSkipped`), and one
// hand-written malformed NDJSON object alongside the real batch (proves
// `rowsRejected`, with a reason, and that a rejected record is excluded
// from `recordsParsed` — i.e. never silently counted as if it were a
// normal skip).
// ---------------------------------------------------------------------
describe('replayWithReport (T3.6.5) — real reconciliation against Postgres + MinIO [INV-7][INV-8]', () => {
  let pg: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  const r2CreatedKeys: string[] = [];

  let tenantId: string;
  let linkId: string;
  const TOTAL_EVENTS = 10;
  const PRE_INSERTED_COUNT = 4; // simulates "a half-populated range"

  let stdoutLines: string[];
  let stderrLines: string[];
  let report: Awaited<ReturnType<typeof replayWithReport>>;

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantId = await seedTenant(pg);
    linkId = await seedLink(pg, tenantId, 'promo', 'https://Shop.Example.com/promo');

    const events: CaptureEvent[] = Array.from({ length: TOTAL_EVENTS }, () =>
      buildCaptureEvent({ tenant_id: tenantId, link_id: linkId, slug: 'promo' }),
    );

    // --- REAL LIVE PATH: writes the batch to BOTH R2 (what replay reads)
    // and Postgres (about to be truncated) — same flushBatch the live
    // path uses, same precedent replay-driver.test.ts/replay.test.ts
    // already set.
    const flushBatch: FlushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });
    const batchId = newId();
    r2CreatedKeys.push(eventBatchKey(batchId, FIXTURE_OCCURRED_AT));
    await flushBatch(events, batchId);

    // --- ONE HAND-WRITTEN MALFORMED OBJECT, alongside the real batch:
    // valid JSON (streamEventLog's own contract only throws on a line
    // that fails to PARSE — see that function's own docstring), but
    // missing `tenant_id`, which ReplayRecordSchema requires. This is
    // what "rejected" means in this module — see replay-report.ts's own
    // header for why a truly unparseable line is explicitly NOT this
    // module's concern (streamEventLog already throws loudly for that,
    // unchanged).
    const malformedRecord = {
      event_id: newId(),
      occurred_at: FIXTURE_OCCURRED_AT,
      // tenant_id deliberately omitted
      link_id: linkId,
      slug: 'promo',
      source_platform: 'direct',
      is_in_app: false,
    };
    const malformedBatchId = newId();
    const malformedKey = eventBatchKey(malformedBatchId, FIXTURE_OCCURRED_AT);
    r2CreatedKeys.push(malformedKey);
    await r2Client.send(
      new PutObjectCommand({
        Bucket: REAL_R2_CONFIG.bucket,
        Key: malformedKey,
        Body: `${JSON.stringify(malformedRecord)}\n`,
        ContentType: 'application/x-ndjson',
      }),
    );

    // --- TRUNCATE: a private, per-test Postgres testcontainer makes a
    // full TRUNCATE safe here — nothing else in this process shares it.
    await pg.pool.query('TRUNCATE TABLE events');
    expect(await countTenantRows(pg, tenantId)).toBe(0); // sanity

    // --- HALF-POPULATE: insert a SUBSET of the same rows directly,
    // bypassing replay entirely, so ON CONFLICT triggers for exactly
    // PRE_INSERTED_COUNT of them once replay runs — simulating "a
    // half-populated range" (some rows already present before replay).
    const preInsertedRows = events.slice(0, PRE_INSERTED_COUNT).map(buildPreInsertedRow);
    await insertEventsBatch(pg.db, preInsertedRows);
    expect(await countTenantRows(pg, tenantId)).toBe(PRE_INSERTED_COUNT); // sanity

    // --- REPLAY WITH REPORT: batchSize smaller than TOTAL_EVENTS and
    // progressEveryRecords=1 so progress lines are deterministically
    // provable without depending on wall-clock timing (see
    // replay-report.ts's own header on why a record-count trigger, not a
    // timer, drives progress in this module).
    stdoutLines = [];
    stderrLines = [];
    const dayInstant = DAY_INSTANT;
    const prefixes = eventPrefixes(dayInstant, dayInstant);
    expect(prefixes).toHaveLength(24);

    report = await replayWithReport({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      prefixes,
      batchSize: 3,
      progressEveryRecords: 1,
      stdout: (line: string) => stdoutLines.push(line),
      stderr: (line: string) => stderrLines.push(line),
    });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: REAL_R2_CONFIG.bucket,
          Delete: { Objects: r2CreatedKeys.map((key) => ({ Key: key })) },
        }),
      );
    }
    r2Client.destroy();
    await pg.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('[1] counts every R2 object under the range — the real batch object AND the hand-written malformed one', () => {
    expect(report.objectsRead).toBeGreaterThanOrEqual(2);
  });

  it('[1] parses exactly the valid records — the malformed one is excluded from recordsParsed, never silently counted', () => {
    expect(report.recordsParsed).toBe(TOTAL_EVENTS);
  });

  it('[2] a half-populated range reports a genuinely non-zero rowsSkipped, matching the pre-inserted subset exactly', () => {
    expect(report.rowsSkipped).toBe(PRE_INSERTED_COUNT);
    expect(report.rowsSkipped).toBeGreaterThan(0);
  });

  it('[1] the remaining rows are actually inserted — rowsInserted covers exactly what was not already present', () => {
    expect(report.rowsInserted).toBe(TOTAL_EVENTS - PRE_INSERTED_COUNT);
  });

  it('[1] the core arithmetic holds on this run: inserted + skipped = parsed, and the report says so', () => {
    expect(report.rowsInserted + report.rowsSkipped).toBe(report.recordsParsed);
    expect(report.reconciled).toBe(true);
    expect(report.exitCode).toBe(EXIT_OK);
  });

  it('reports exactly one rejected row, with a reason naming the missing field', () => {
    expect(report.rowsRejected).toBe(1);
    expect(report.rejectionReasons).toHaveLength(1);
    expect(report.rejectionReasons[0]?.count).toBe(1);
    expect(report.rejectionReasons[0]?.reason).toMatch(/tenant_id/);
  });

  it('every row that should exist in Postgres for this tenant actually does, after replay', async () => {
    expect(await countTenantRows(pg, tenantId)).toBe(TOTAL_EVENTS);
  });

  it('emits at least one progress line to stderr, naming objects read, records parsed, and elapsed time', () => {
    expect(stderrLines.length).toBeGreaterThan(0);
    const progressLine = stderrLines.find((line) => line.includes('progress'));
    expect(progressLine).toBeDefined();
    expect(progressLine).toMatch(/objects read: \d+/);
    expect(progressLine).toMatch(/records parsed: \d+/);
    expect(progressLine).toMatch(/elapsed: \d+ms/);
  });

  it('never writes progress lines to stdout — stdout carries only the final report', () => {
    const progressOnStdout = stdoutLines.find((line) => line.includes('progress'));
    expect(progressOnStdout).toBeUndefined();
  });

  it('prints a final report to stdout naming every metric this task requires: objects read, records parsed, rows inserted, rows skipped, rows rejected', () => {
    const joined = stdoutLines.join('\n');
    expect(joined).toMatch(/objects read: \d+/);
    expect(joined).toMatch(/records parsed: 10/);
    expect(joined).toMatch(/rows inserted: 6/);
    expect(joined).toMatch(/rows skipped \(already present\): 4/);
    expect(joined).toMatch(/rows rejected: 1/);
    expect(joined).toMatch(/reconciliation OK/);
  });
});

// ---------------------------------------------------------------------
// A second, independent real-Postgres run proving a genuinely CLEAN
// range (nothing pre-inserted, nothing malformed) reconciles with
// rowsSkipped exactly 0 — the plan's own "(1) the arithmetic holds on a
// clean range" wording, read literally (the describe block above already
// proves the arithmetic holds; this one specifically proves a clean
// range's skipped count is zero, not just non-negative).
// ---------------------------------------------------------------------
describe('replayWithReport (T3.6.5) — a genuinely clean range [plan: "asserts the arithmetic holds on a clean range"]', () => {
  let pg: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  const r2CreatedKeys: string[] = [];
  let report: Awaited<ReturnType<typeof replayWithReport>>;

  const CLEAN_FIXTURE_DAY_MS = Date.UTC(2150, 0, 1) + Math.floor(Math.random() * 2920) * ONE_DAY_MS;
  const CLEAN_FIXTURE_OCCURRED_AT = new Date(CLEAN_FIXTURE_DAY_MS + 3 * ONE_HOUR_MS).toISOString();
  const CLEAN_TOTAL_EVENTS = 6;

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    const tenantId = await seedTenant(pg);
    const linkId = await seedLink(pg, tenantId, 'clean', 'https://Shop.Example.org/clean');

    const events: CaptureEvent[] = Array.from({ length: CLEAN_TOTAL_EVENTS }, () =>
      buildCaptureEvent({
        tenant_id: tenantId,
        link_id: linkId,
        slug: 'clean',
        occurred_at: CLEAN_FIXTURE_OCCURRED_AT,
      }),
    );

    const flushBatch: FlushBatch = createFlushBatch({ db: pg.db, r2Client, r2Bucket: REAL_R2_CONFIG.bucket });
    const batchId = newId();
    r2CreatedKeys.push(eventBatchKey(batchId, CLEAN_FIXTURE_OCCURRED_AT));
    await flushBatch(events, batchId);

    // TRUNCATE and never pre-insert anything — a genuinely clean range.
    await pg.pool.query('TRUNCATE TABLE events');

    const dayInstant = new Date(CLEAN_FIXTURE_DAY_MS).toISOString();
    report = await replayWithReport({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      prefixes: eventPrefixes(dayInstant, dayInstant),
      stdout: () => undefined,
      stderr: () => undefined,
    });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: REAL_R2_CONFIG.bucket,
          Delete: { Objects: r2CreatedKeys.map((key) => ({ Key: key })) },
        }),
      );
    }
    r2Client.destroy();
    await pg.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a clean range inserts everything, skips nothing, rejects nothing, and reconciles', () => {
    expect(report.recordsParsed).toBe(CLEAN_TOTAL_EVENTS);
    expect(report.rowsInserted).toBe(CLEAN_TOTAL_EVENTS);
    expect(report.rowsSkipped).toBe(0);
    expect(report.rowsRejected).toBe(0);
    expect(report.reconciled).toBe(true);
    expect(report.exitCode).toBe(EXIT_OK);
  });
});
