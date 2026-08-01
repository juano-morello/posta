import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { Pool, QueryResult } from 'pg';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  destHost,
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
import { replayEventLog } from './replay-driver';

// T3.6.3 [E3, S3.6][INV-7][INV-8] — "replay feeds records through the live
// insert path." This suite proves the driver-level version of the epic's
// "done when" clause: rebuilding a truncated slice of `events` from R2
// produces row-for-row-identical output, WITHOUT ever re-resolving a
// link's destination or re-running enrich() against replayed history
// (docs/plan/IMPLEMENTATION-NOTES.md's T3.3.2 forward-note, and
// packages/core/src/r2/ndjson.ts's own header on streamEventLog). T3.6.6
// is the full-scale "truncate a real partition, replay a real month"
// integration test — this is that same proof at the small, driver-level
// scale this task actually owns.
//
// --- On this file's own "no drifting INSERT" test, and the plan's verify
// text ("no INSERT INTO events string literal exists anywhere in the repo
// outside apps/worker/src/batch/flush.ts") ---------------------------
//
// Investigated before writing anything below: taken completely literally,
// this clause is ALREADY false on a clean tree, for reasons that have
// nothing to do with this task. `grep -rn "INSERT INTO events"` finds the
// literal string in five PRE-EXISTING, unrelated test fixtures
// (packages/core/src/db/default-partition.test.ts,
// sql-migrate-down.test.ts, partitions-bootstrap.test.ts,
// partition-boundaries.test.ts, apps/worker/src/partitions/
// default-partition-alert.test.ts) — raw SQL used to seed rows directly
// for PARTITION-BOUNDARY testing, none of it anywhere near flush.ts. And
// the exception the clause carves out ("outside flush.ts") doesn't match
// reality either: flush.ts itself contains ZERO occurrences of that
// literal — it calls `insertEventsBatch`, and the actual
// `db.insert(events).values(...).onConflictDoNothing(...)` call (a
// Drizzle query-builder call, never a raw SQL string) lives in
// packages/core/src/db/events.ts, a different file the clause never
// names. So the clause cannot be satisfied as literally written; this
// mirrors the same category of stale verify text this epic already hit
// at T3.3.2 (the "exactly one statement per flush" prose, amended after
// a two-statement design was found correct) and T3.6.2 (the absolute-RSS
// ceiling, amended to a growth-based metric) — both resolved by amending
// the PROSE, not the code, after a human decision.
//
// What the clause is actually protecting against — spelled out in the
// surrounding prose ("a parallel restore implementation drifts from the
// real one and you find out on the day you need it") — is real, and
// checkable: nobody outside packages/core/src/db/events.ts should ever
// construct a SECOND `.insert(events)` call. The scan below asserts
// exactly that, which is what the task's own "if there's a sensible,
// literal, non-strained reading... implementing that is fine" clause
// invites. Reported to the user rather than silently substituted; see
// this task's final report.
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
// uses 2050-2057) — this worktree's MinIO bucket is shared with
// concurrent sibling agents, and this random, wide window keeps a
// same-day collision vanishingly unlikely, matching the precedent those
// files already establish. Unlike reconciliation.test.ts, replayEventLog
// itself does NOT filter records by tenant_id while streaming (tenant
// filtering is T3.6.4's job, not this driver's) — so, belt and braces,
// every assertion below that could be affected by a hypothetical
// same-window collision is scoped to THIS test's own tenantId when
// reading Postgres back, never a raw total.
const FIXTURE_DAY_MS = Date.UTC(2090, 0, 1) + Math.floor(Math.random() * 2920) * ONE_DAY_MS;
const FIXTURE_HOUR_OFFSET = 6;
const FIXTURE_OCCURRED_AT = new Date(FIXTURE_DAY_MS + FIXTURE_HOUR_OFFSET * ONE_HOUR_MS).toISOString();

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const INSTAGRAM_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.114 (iPhone14,3; iOS 17_4; en_US; en-US; scale=3.00; 1284x2778; 498540814)';
const PIXEL_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36';

const REPLAY_BATCH_SIZE = 5; // deliberately smaller than TOTAL_EVENTS below, to prove batching

function buildCaptureEvent(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: FIXTURE_OCCURRED_AT,
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: null,
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

async function updateLinkDestination(
  handle: PgContainerHandle,
  linkId: string,
  destination: string,
): Promise<void> {
  await handle.pool.query('UPDATE links SET destination = $1 WHERE id = $2', [destination, linkId]);
}

/** Every one of the 31 `events` columns, exactly as Postgres names them
 * (snake_case) — the same column list flush.test.ts's own
 * EVENTS_COLUMN_COUNT names. `occurred_at` normalizes to an ISO string
 * (pg's own driver returns a `Date` for `timestamptz`) so two snapshots
 * taken minutes apart compare with plain `toEqual`, never a
 * timezone-sensitive raw `Date` comparison. */
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
  const result = await handle.pool.query(
    'SELECT * FROM events WHERE tenant_id = $1 ORDER BY event_id',
    [tenantId],
  );
  return result.rows.map((row) => ({
    ...row,
    occurred_at: new Date(row.occurred_at).toISOString(),
  }));
}

interface QuerySpyCall {
  readonly text: string;
}

/** Intercepts every SQL statement `pool.query()` issues — same mechanism
 * (and same rationale) as flush.test.ts's own `spyOnPoolQueries`. Reused
 * here, not reimplemented from scratch with different semantics, to keep
 * "how do we count real INSERT statements" a single, already-reviewed
 * mechanism in this codebase. */
function spyOnPoolQueries(pool: Pool): { calls: QuerySpyCall[]; restore(): void } {
  const originalQuery = pool.query.bind(pool) as (
    textOrConfig: string | { text: string },
    params?: unknown[],
  ) => Promise<QueryResult>;
  const calls: QuerySpyCall[] = [];

  const spied = (textOrConfig: string | { text: string }, params?: unknown[]): Promise<QueryResult> => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    calls.push({ text });
    return originalQuery(textOrConfig, params);
  };

  pool.query = spied as unknown as Pool['query'];

  return {
    calls,
    restore() {
      pool.query = originalQuery as unknown as Pool['query'];
    },
  };
}

function insertEventsStatements(calls: readonly QuerySpyCall[]): QuerySpyCall[] {
  return calls.filter((call) => /^\s*insert\s+into\s+"?events"?/i.test(call.text));
}

describe('replayEventLog (T3.6.3) — feeds R2-archived records through the live insert path [INV-7][INV-8]', () => {
  let pg: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  const r2CreatedKeys: string[] = [];

  let tenantId: string;
  let linkStable: string; // untouched destination throughout
  let linkEdited: string; // destination changed AFTER capture/flush, before replay
  const ORIGINAL_STABLE_DEST = 'https://Shop.Example.com/promo-a';
  const ORIGINAL_EDITED_DEST = 'https://Original.Example.org/landing-b';
  const POST_CAPTURE_EDITED_DEST = 'https://Edited.Example.net/new-landing-b';

  let stalenessEventId: string;
  let preTruncationRows: PgEventRow[];
  let rowsAfterTruncate: PgEventRow[];
  let postReplayRows: PgEventRow[];
  let insertCallCount: number;
  let replaySummary: { recordsRead: number; batchesWritten: number };

  const TOTAL_EVENTS = 13; // 12 profile events on linkStable + 1 staleness event on linkEdited

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantId = await seedTenant(pg);
    linkStable = await seedLink(pg, tenantId, 'promo-a', ORIGINAL_STABLE_DEST);
    linkEdited = await seedLink(pg, tenantId, 'landing-b', ORIGINAL_EDITED_DEST);

    const profiles = [
      { userAgent: DESKTOP_CHROME_UA, referer: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com' },
      { userAgent: INSTAGRAM_IN_APP_UA, referer: null },
      { userAgent: null, referer: null },
      { userAgent: PIXEL_CHROME_UA, referer: 'https://www.tiktok.com/@someone/video/123' },
    ] as const;

    const stableEvents: CaptureEvent[] = Array.from({ length: 12 }, (_, index) => {
      const profile = profiles[index % profiles.length]!;
      return buildCaptureEvent({
        tenant_id: tenantId,
        link_id: linkStable,
        slug: 'promo-a',
        user_agent: profile.userAgent,
        referer: profile.referer,
      });
    });

    const stalenessEvent = buildCaptureEvent({
      tenant_id: tenantId,
      link_id: linkEdited,
      slug: 'landing-b',
      user_agent: DESKTOP_CHROME_UA,
      referer: null,
    });
    stalenessEventId = stalenessEvent.event_id;

    const allEvents = [...stableEvents, stalenessEvent];
    expect(allEvents).toHaveLength(TOTAL_EVENTS);

    // --- REAL LIVE PATH: the same flushBatch T3.3.2/T3.4.6 built, real
    // Postgres, real MinIO. dest_host for BOTH links is resolved and
    // logged HERE, against each link's destination as it stood at flush
    // time — this is the value invariant 7 says must never change on
    // replay.
    const flushBatch: FlushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });
    const batchId = newId();
    r2CreatedKeys.push(eventBatchKey(batchId, FIXTURE_OCCURRED_AT));
    await flushBatch(allEvents, batchId);

    // Pre-truncation snapshot — what a correct replay must reproduce
    // exactly, byte for byte, column for column.
    preTruncationRows = await fetchEventRows(pg, tenantId);
    expect(preTruncationRows).toHaveLength(TOTAL_EVENTS);

    // --- THE ANTI-STALENESS SETUP: edit linkEdited's destination AFTER
    // capture/flush already happened — invariant 3 (307-never-301) exists
    // precisely because this is normal, expected operator behavior. A
    // replay that re-resolves destinations at REPLAY time would now
    // record the EDITED host against old history.
    await updateLinkDestination(pg, linkEdited, POST_CAPTURE_EDITED_DEST);

    // --- TRUNCATE: this is the driver-scale version of T3.6.6's own
    // "truncate an events partition and rebuild it from R2." A private,
    // per-test Postgres testcontainer makes a full TRUNCATE safe here —
    // nothing else in this process ever shares this container.
    await pg.pool.query('TRUNCATE TABLE events');
    rowsAfterTruncate = await fetchEventRows(pg, tenantId);
    expect(rowsAfterTruncate).toHaveLength(0); // sanity: truncation genuinely happened

    // --- REPLAY: streams the SAME R2 log back through insertEventsBatch,
    // via toNewEventRow — never flushBatch, never enrich(), never
    // resolveDestinationsByLinkIds. batchSize smaller than TOTAL_EVENTS so
    // the querySpy below can prove multiple, batched INSERTs occur.
    const dayInstant = new Date(FIXTURE_DAY_MS).toISOString();
    const prefixes = eventPrefixes(dayInstant, dayInstant);
    expect(prefixes).toHaveLength(24);

    const querySpy = spyOnPoolQueries(pg.pool);
    replaySummary = await replayEventLog({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      prefixes,
      batchSize: REPLAY_BATCH_SIZE,
    });
    insertCallCount = insertEventsStatements(querySpy.calls).length;
    querySpy.restore();

    postReplayRows = await fetchEventRows(pg, tenantId);
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

  it('[INV-7] replayed rows are byte-identical to the pre-truncation, live-written snapshot — same count, same values, every column', () => {
    expect(postReplayRows).toHaveLength(preTruncationRows.length);
    expect(postReplayRows).toEqual(preTruncationRows);
  });

  it('[INV-7] the anti-staleness constraint: the replayed row for the edited link keeps the ORIGINALLY-logged dest_host, never the link\'s current (edited) destination', () => {
    const replayedRow = postReplayRows.find((row) => row.event_id === stalenessEventId);
    expect(replayedRow).toBeDefined();
    expect(replayedRow?.dest_host).toBe(destHost(ORIGINAL_EDITED_DEST));
    expect(replayedRow?.dest_host).not.toBe(destHost(POST_CAPTURE_EDITED_DEST));
  });

  it('[INV-8] replay batches inserts — multiple statements for 13 records at batchSize 5, never one giant INSERT and never one per row', () => {
    expect(insertCallCount).toBe(Math.ceil(TOTAL_EVENTS / REPLAY_BATCH_SIZE));
    expect(insertCallCount).toBeGreaterThan(1);
    expect(insertCallCount).toBeLessThan(TOTAL_EVENTS);
  });

  it('reports a summary consistent with what it actually read and wrote for this run\'s own records', () => {
    // >= , not === : replayEventLog does not filter by tenant while
    // streaming (see this file's own header) — a same-window collision
    // with a concurrent sibling test would only ever ADD records, never
    // remove this run's own 13.
    expect(replaySummary.recordsRead).toBeGreaterThanOrEqual(TOTAL_EVENTS);
    expect(replaySummary.batchesWritten).toBe(insertCallCount);
  });

  it('replay is idempotent — running it again over the same, now-populated range inserts nothing new for this tenant [INV-8]', async () => {
    const dayInstant = new Date(FIXTURE_DAY_MS).toISOString();
    const prefixes = eventPrefixes(dayInstant, dayInstant);

    await replayEventLog({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      prefixes,
      batchSize: REPLAY_BATCH_SIZE,
    });

    const rowsAfterSecondReplay = await fetchEventRows(pg, tenantId);
    expect(rowsAfterSecondReplay).toEqual(postReplayRows);
  });
});

// --- Investigation of the plan's verify clause ("no INSERT INTO events
// string literal exists anywhere in the repo outside flush.ts") — see
// this file's own header for the full finding. Implements the
// substantively equivalent, defensible check instead: nobody but
// packages/core/src/db/events.ts constructs a real `.insert(events)`
// Drizzle call. Directory-walk pattern mirrors no-verdict.test.ts's own
// scanTreeForVerdictVocabulary (excluded dirs, .ts/.tsx only, skip
// .d.ts) — but detection itself is a real AST walk via the TypeScript
// compiler API (same `typescript` package no-verdict.test.ts already
// uses), not a text/regex scan. A first draft here used a plain regex
// and immediately self-detected on this file's OWN prose (this exact
// paragraph, and this file's header above, both discuss
// `.insert(events)`/`enrich()` in comments) — precisely the "words used
// in prose vs. real code" trap no-verdict.test.ts's own header warns
// about. Parsing the real AST and only inspecting genuine
// CallExpression nodes makes a comment or a docstring structurally
// invisible to this scan, the same way it is to no-verdict.test.ts's.
const EXPECTED_SOLE_INSERT_EVENTS_OWNER = path.join('packages', 'core', 'src', 'db', 'events.ts');
const SCAN_ROOTS = ['apps/api/src', 'apps/worker/src', 'packages/core/src', 'packages/contracts/src'] as const;
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.next', '.turbo', '.git', 'coverage']);

function isScannableSourceFile(fileName: string): boolean {
  return (
    (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) &&
    !fileName.endsWith('.d.ts') &&
    !fileName.endsWith('.test.ts')
  );
}

/** True if `sourceText` contains a real CallExpression shaped
 * `<anything>.insert(events)` — a Drizzle-style call whose single
 * argument is the bare `events` identifier (the table object,
 * packages/core/src/schema/events.ts). Only a genuine syntax node
 * counts; a comment or string containing the same characters does not,
 * because `ts.forEachChild` never descends into trivia. */
function containsInsertEventsCall(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'insert' &&
      node.arguments.length > 0 &&
      ts.isIdentifier(node.arguments[0]!) &&
      node.arguments[0]!.text === 'events'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/** True if `sourceText` contains a real CallExpression invoking a bare
 * identifier named `functionName` — e.g. `enrich(...)` or
 * `resolveDestinationsByLinkIds(...)`. Same AST-only discipline as
 * {@link containsInsertEventsCall}: a comment mentioning the function by
 * name (this file's own header does, repeatedly) is not a call and is
 * never flagged. */
function containsBareCallTo(sourceText: string, fileName: string, functionName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === functionName) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function findInsertEventsCallSites(rootDir: string, scanRoots: readonly string[]): string[] {
  const matches: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new Error(`Failed to read directory "${dir}": ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !isScannableSourceFile(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      const sourceText = readFileSync(fullPath, 'utf8');
      if (containsInsertEventsCall(sourceText, relativePath)) {
        matches.push(relativePath);
      }
    }
  }

  for (const root of scanRoots) {
    walk(path.join(rootDir, root));
  }

  return matches;
}

describe('no drifting INSERT implementation — insertEventsBatch stays the ONE real events INSERT [T3.6.3 verify-clause investigation]', () => {
  it('exactly one production source file constructs `.insert(events)` — packages/core/src/db/events.ts, and no other, including the new replay driver', () => {
    const matches = findInsertEventsCallSites(process.cwd(), SCAN_ROOTS);

    expect(matches).toEqual([EXPECTED_SOLE_INSERT_EVENTS_OWNER]);
  });

  it('replay-driver.ts itself contains no `.insert(events)` call of its own', () => {
    const filePath = 'apps/worker/src/cli/replay-driver.ts';
    const source = readFileSync(path.join(process.cwd(), filePath), 'utf8');
    expect(containsInsertEventsCall(source, filePath)).toBe(false);
  });
});

describe('replay-driver.ts never re-derives destination or enrichment — reuses the live mapping only [T3.6.3]', () => {
  it('calls the real insertEventsBatch and toNewEventRow, and calls neither enrich() nor resolveDestinationsByLinkIds', () => {
    const filePath = 'apps/worker/src/cli/replay-driver.ts';
    const source = readFileSync(path.join(process.cwd(), filePath), 'utf8');

    expect(containsBareCallTo(source, filePath, 'insertEventsBatch')).toBe(true);
    expect(containsBareCallTo(source, filePath, 'toNewEventRow')).toBe(true);
    expect(containsBareCallTo(source, filePath, 'enrich')).toBe(false);
    expect(containsBareCallTo(source, filePath, 'resolveDestinationsByLinkIds')).toBe(false);
  });
});
