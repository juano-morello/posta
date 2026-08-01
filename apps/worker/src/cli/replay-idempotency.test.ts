import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  eventPrefixes,
  links,
  newId,
  runSqlMigrations,
  user,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from '../batch/flush';
import { replayWithReport, EXIT_OK } from './replay-report';
import path from 'node:path';

// T3.6.7 (E3, S3.6) [INV-8] — "replay over a fully-populated range changes
// nothing." This is the safety proof that makes replay something an
// operator can run when they are UNSURE whether they need it: a range
// that is already fully, correctly populated must come out of a replay
// pass byte-for-byte identical, on both a first AND a second run, with
// the reconciliation report itself saying "everything was already there"
// (rowsInserted: 0, rowsSkipped === recordsParsed).
//
// --- Which replay entry point this targets, and why -------------------
//
// Two independent replay code paths exist in this codebase:
//   (1) replayEventLog/runReplayCli (replay-driver.ts/replay.ts) — the
//       operator-facing `posta replay` CLI. Its result type carries only
//       `recordsRead`/`batchesWritten`; it has no "skipped" or "parsed"
//       vocabulary at all.
//   (2) replayWithReport (replay-report.ts, T3.6.5) — a self-contained
//       reconciliation-report module, its OWN read/batch/insert loop
//       (built from the same `streamEventLog`/`toNewEventRow` primitives
//       path (1) uses, but via `insertEventsBatchWithCounts`, a distinct
//       function from path (1)'s `insertEventsBatch` — same statement,
//       with a `RETURNING event_id` clause added so "inserted" can be
//       told apart from "skipped by ON CONFLICT"). Its result type
//       (`ReplayReport`) carries exactly `recordsParsed`/`rowsInserted`/
//       `rowsSkipped`/`reconciled`.
// This task's own plan text — "the report showing skipped equal to
// parsed" — is `replayWithReport`'s own vocabulary, not path (1)'s (which
// has neither field), so this suite targets `replayWithReport`.
//
// replay-driver.test.ts (T3.6.3) already has an idempotency test of its
// own ("replay is idempotent — running it again over the same, now-
// populated range inserts nothing new for this tenant"), but that test
// exercises ONLY path (1) (replayEventLog/insertEventsBatch). Path (2)
// (replayWithReport/insertEventsBatchWithCounts) has never had its own
// idempotency proven until this file — genuinely non-duplicate coverage,
// not a restatement of T3.6.3's own test.
//
// --- retryWithSplit / batch-id-gap dormancy (T3.4.4) -------------------
//
// Independently re-confirmed via `grep -rn "retryWithSplit(" apps/worker/
// src/ | grep -v '\.test\.ts'`: the only non-test, non-comment call site
// is `retryWithSplit`'s own recursive self-call inside split-retry.ts.
// Nothing in app.module.ts, flush.ts's production wiring, or the live
// accumulator→flush path this suite's own seeding step (createFlushBatch)
// exercises ever calls it. The known "a batch retried through
// retryWithSplit mints a NEW R2 key per attempt" gap (flush.ts's own
// comment, ~line 116) therefore cannot organically surface here, or
// anywhere else in the live path today — this suite does not attempt to
// manufacture it (out of scope for this task).
//
// --- Constraint that must survive replay ------------------------------
//
// replayWithReport never calls enrich(), resolveDestinationsByLinkIds, or
// flushBatch during either replay pass (see replay-report.ts's own
// header) — only this suite's OWN seeding step calls flushBatch, once,
// before either replay pass runs.

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

// A random UTC day in a window no other test in this repo uses (checked
// against replay-report.test.ts's own claimed-window list: 2026,
// ~2033-2041, 2050-2057, 2090-2098, 2110-2126, 2130-2137, 2140-2147,
// 2150-2157, 2160-2168 — this file claims 2170-2178, previously unused).
// This worktree's MinIO bucket is shared with concurrent sibling
// agents/tests, so a random, wide, previously-unused window keeps a
// same-day collision vanishingly unlikely, same precedent those files
// already establish.
const FIXTURE_DAY_MS = Date.UTC(2170, 0, 1) + Math.floor(Math.random() * 2920) * ONE_DAY_MS;
const FIXTURE_HOUR_OFFSET = 9;
const FIXTURE_OCCURRED_AT = new Date(FIXTURE_DAY_MS + FIXTURE_HOUR_OFFSET * ONE_HOUR_MS).toISOString();
const DAY_INSTANT = new Date(FIXTURE_DAY_MS).toISOString();

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TOTAL_EVENTS = 9;

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

/** Every one of the 31 `events` columns, exactly as Postgres names them
 * (snake_case) — same shape replay-driver.test.ts's own `PgEventRow`/
 * `fetchEventRows` and truncate-and-restore.test.ts's own
 * `PgEventRow`/`fetchPartitionRows` already establish. `occurred_at`
 * normalizes to an ISO string (pg's driver returns a `Date` for
 * `timestamptz`) so two snapshots taken minutes apart compare with plain
 * `toEqual`, never a timezone-sensitive raw `Date` comparison. */
interface PgEventRow {
  readonly event_id: string;
  readonly occurred_at: string;
  readonly tenant_id: string;
  readonly link_id: string;
  readonly slug: string;
  readonly visitor_hash: string | null;
  readonly http_method: string | null;
  readonly user_agent: string | null;
  readonly referer: string | null;
  readonly accept: string | null;
  readonly accept_language: string | null;
  readonly sec_fetch_site: string | null;
  readonly sec_fetch_mode: string | null;
  readonly sec_fetch_dest: string | null;
  readonly sec_fetch_user: string | null;
  readonly sec_purpose: string | null;
  readonly sec_ch_ua: string | null;
  readonly sec_ch_ua_mobile: string | null;
  readonly sec_ch_ua_platform: string | null;
  readonly purpose: string | null;
  readonly x_purpose: string | null;
  readonly x_moz: string | null;
  readonly country: string | null;
  readonly asn: number | null;
  readonly browser: string | null;
  readonly browser_version: string | null;
  readonly os: string | null;
  readonly device_type: string | null;
  readonly source_platform: string | null;
  readonly is_in_app: boolean | null;
  readonly dest_host: string | null;
}

async function fetchEventRows(handle: PgContainerHandle, tenantId: string): Promise<PgEventRow[]> {
  const result = await handle.pool.query('SELECT * FROM events WHERE tenant_id = $1 ORDER BY event_id', [
    tenantId,
  ]);
  return result.rows.map((row) => ({
    ...row,
    occurred_at: new Date(row.occurred_at).toISOString(),
  }));
}

async function countTenantRows(handle: PgContainerHandle, tenantId: string): Promise<number> {
  const result = await handle.pool.query('SELECT event_id FROM events WHERE tenant_id = $1', [tenantId]);
  return result.rows.length;
}

describe('replayWithReport (T3.6.7) — replay over a fully-populated range changes nothing [INV-8]', () => {
  let pg: PgContainerHandle;
  let r2Client: S3Client;
  const r2CreatedKeys: string[] = [];

  let tenantId: string;
  let linkId: string;

  let preReplayRows: PgEventRow[];
  let firstReport: Awaited<ReturnType<typeof replayWithReport>>;
  let rowsAfterFirstReplay: PgEventRow[];
  let secondReport: Awaited<ReturnType<typeof replayWithReport>>;
  let rowsAfterSecondReplay: PgEventRow[];

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantId = await seedTenant(pg);
    linkId = await seedLink(pg, tenantId, 'promo', 'https://Shop.Example.com/promo');

    const events: CaptureEvent[] = Array.from({ length: TOTAL_EVENTS }, () =>
      buildCaptureEvent({ tenant_id: tenantId, link_id: linkId, slug: 'promo' }),
    );

    // --- SEED, via the REAL live path: this is the ONLY place flushBatch
    // (and therefore enrich()/resolveDestinationsByLinkIds) is ever
    // called in this file. Writes to both R2 (what replay reads) and
    // Postgres — this test never truncates, so the range stays fully
    // populated for both replay passes below.
    const flushBatch: FlushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });
    const batchId = newId();
    r2CreatedKeys.push(eventBatchKey(batchId, FIXTURE_OCCURRED_AT));
    await flushBatch(events, batchId);

    expect(await countTenantRows(pg, tenantId)).toBe(TOTAL_EVENTS); // sanity: the range starts fully populated

    preReplayRows = await fetchEventRows(pg, tenantId);
    expect(preReplayRows).toHaveLength(TOTAL_EVENTS);

    const prefixes = eventPrefixes(DAY_INSTANT, DAY_INSTANT);
    expect(prefixes).toHaveLength(24);

    // --- FIRST REPLAY PASS over the intact range.
    firstReport = await replayWithReport({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      prefixes,
      batchSize: 4, // smaller than TOTAL_EVENTS, so this run genuinely batches
      stdout: () => undefined,
      stderr: () => undefined,
    });
    rowsAfterFirstReplay = await fetchEventRows(pg, tenantId);

    // --- SECOND REPLAY PASS over the SAME, still-intact range.
    secondReport = await replayWithReport({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      prefixes,
      batchSize: 4,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    rowsAfterSecondReplay = await fetchEventRows(pg, tenantId);
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

  // --- fixture sanity: the "0 inserted / N skipped" result must be
  // meaningful, not a trivial empty-range pass.
  it('sanity: the fixture range actually has a genuinely non-zero number of records to reconcile against', () => {
    expect(firstReport.recordsParsed).toBeGreaterThan(0);
    expect(firstReport.recordsParsed).toBe(TOTAL_EVENTS);
  });

  // --- FIRST PASS arithmetic: everything already present via
  // ON CONFLICT DO NOTHING.
  it('[first pass] inserts nothing — every row was already present before this replay ran', () => {
    expect(firstReport.rowsInserted).toBe(0);
  });

  it('[first pass] skips exactly as many rows as were parsed — none rejected, none newly inserted', () => {
    expect(firstReport.rowsSkipped).toBe(firstReport.recordsParsed);
    expect(firstReport.rowsSkipped).toBe(TOTAL_EVENTS);
    expect(firstReport.rowsRejected).toBe(0);
  });

  it('[first pass] reconciles and exits OK', () => {
    expect(firstReport.reconciled).toBe(true);
    expect(firstReport.exitCode).toBe(EXIT_OK);
  });

  // --- FIRST PASS content proof: not just arithmetic — every column of
  // every row, byte-identical before and after. This is the check that
  // would catch a hypothetical bug where a "skip" quietly overwrote a
  // column with the freshly-parsed (but supposedly identical) value
  // instead of truly no-op'ing.
  it('[first pass] every row is byte-identical, column for column, to the pre-replay snapshot', () => {
    expect(rowsAfterFirstReplay).toHaveLength(preReplayRows.length);
    expect(rowsAfterFirstReplay).toEqual(preReplayRows);
  });

  it('[first pass] row count in Postgres is unchanged — no net inserts, no net deletes', async () => {
    expect(await countTenantRows(pg, tenantId)).toBe(TOTAL_EVENTS);
  });

  // --- SECOND PASS: identical arithmetic, proving idempotency holds
  // across repeated runs, not just once.
  it('[second pass] inserts nothing and skips exactly what was parsed, same as the first pass', () => {
    expect(secondReport.rowsInserted).toBe(0);
    expect(secondReport.rowsSkipped).toBe(secondReport.recordsParsed);
    expect(secondReport.recordsParsed).toBe(TOTAL_EVENTS);
    expect(secondReport.rowsRejected).toBe(0);
  });

  it('[second pass] reconciles and exits OK', () => {
    expect(secondReport.reconciled).toBe(true);
    expect(secondReport.exitCode).toBe(EXIT_OK);
  });

  it('[second pass] every row is STILL byte-identical, column for column, to the original pre-replay snapshot', () => {
    expect(rowsAfterSecondReplay).toHaveLength(preReplayRows.length);
    expect(rowsAfterSecondReplay).toEqual(preReplayRows);
    expect(rowsAfterSecondReplay).toEqual(rowsAfterFirstReplay);
  });

  it('[second pass] row count in Postgres is still unchanged after two full replay passes', async () => {
    expect(await countTenantRows(pg, tenantId)).toBe(TOTAL_EVENTS);
  });
});
