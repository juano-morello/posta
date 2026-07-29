import path from 'node:path';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  links,
  newId,
  runSqlMigrations,
  user,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from '../batch/flush';
import { runReplayCli, type ReplayCliDeps, type ReplayCliResult } from './replay';

// T3.6.6 (E3, S3.6) [INV-7] — the epic's headline test: "truncate an
// events PARTITION and rebuild it from R2." This is the full-scale
// integration proof that invariant 7 ("the R2 NDJSON log is the source of
// truth for events; Postgres is a rebuildable projection") is real, not
// decoration.
//
// --- What this file proves that replay-driver.test.ts (T3.6.3) does NOT
// -----------------------------------------------------------------------
//
// replay-driver.test.ts already proves row-for-row rebuild at DRIVER
// scale: it seeds events, flushes them through the real live pipeline,
// snapshots every row, `TRUNCATE TABLE events` (the WHOLE table, safe only
// because it's a private per-test container), replays via
// `replayEventLog` directly, and asserts byte-identical output. That is a
// real, valuable proof — but it structurally cannot prove two things this
// task's own plan text asks for: "truncate that partition ONLY" (a whole-
// table TRUNCATE proves nothing about partition isolation — there is no
// neighbour left standing to check) and "runs posta replay" (T3.6.4's real
// CLI entrypoint, not the lower-level driver function replay-driver.test.ts
// calls). This file closes both gaps:
//
//   1. Two REAL monthly partitions are created via the real SQL function
//      (`create_events_partition`, T1.3.1) — a target month and the month
//      immediately after it — and events are flushed into BOTH through the
//      real live pipeline (`createFlushBatch`), so there is real,
//      distinguishable control data sitting in a neighbour partition for
//      the whole test.
//   2. Only the TARGET partition is truncated, by its real leaf-partition
//      name (`TRUNCATE TABLE events_YYYY_MM`) — never `TRUNCATE TABLE
//      events`. The partition is asserted genuinely empty (`SELECT count(*)
//      FROM ONLY events_YYYY_MM`) BEFORE replay ever runs — load-bearing,
//      not decorative: a rebuild test that would also pass against a
//      partition that was never truncated proves nothing (see this file's
//      own sabotage-and-revert note below, where skipping exactly this
//      check was shown to let a broken truncate slip through unnoticed).
//   3. Rebuild runs through `runReplayCli` (T3.6.4's actual `posta replay`
//      CLI entrypoint — parseReplayArgs + the real `--from`/`--to`/
//      `--tenant` flags), not `replayEventLog` called directly.
//   4. After replay: the target partition is asserted byte-identical to
//      its own pre-truncation snapshot AND physically placed there (via
//      `tableoid`, never `events_default`), while the ADJACENT partition
//      is asserted COMPLETELY untouched — byte-identical to ITS OWN
//      pre-truncation snapshot, never truncated, never replayed into
//      (`--from`/`--to` is scoped to exactly the target month, so
//      `eventPrefixes` structurally never even emits a prefix pointing at
//      the neighbour month).
//
// Constraint that must survive: replay reuses the already-logged
// `dest_host` verbatim and never calls `enrich()`/
// `resolveDestinationsByLinkIds()`/`flushBatch` at replay time — already
// guaranteed by construction (`runReplayCli` only ever calls
// `replayEventLog`, which only ever calls `toNewEventRow`/
// `insertEventsBatch`) and already proven by replay-driver.test.ts's own
// [INV-7] staleness test and replay.test.ts's structural AST guard. This
// file does not re-prove that; it never calls `flushBatch` during the
// "replay" step, only during the initial seeding step, so it cannot
// accidentally route around that guarantee either.
//
// --- Sabotage-and-revert (RED phase) --------------------------------
//
// Before settling on the final assertions below, the TRUNCATE line was
// temporarily pointed at the WRONG partition (`ADJACENT_PARTITION` instead
// of `TARGET_PARTITION`) and the suite was run for real against live
// Postgres/MinIO. Two things were observed:
//
//   - `expect(targetCountAfterTruncate).toBe(0)` failed loudly (actual:
//     TARGET_EVENT_COUNT) — exactly the discriminating signal this
//     assertion exists to provide.
//   - With that assertion additionally commented out (simulating "skip
//     the emptiness check"), the row-equality assertion further down
//     (`expect(postReplayTargetRows).toEqual(preTruncationTargetRows)`)
//     STILL PASSED — because the target partition was never actually
//     truncated, and `insertEventsBatch`'s own `ON CONFLICT DO NOTHING`
//     (invariant 8) made the subsequent replay a silent no-op against
//     already-present rows. This is precisely the "a rebuild test that
//     would also pass against a partition that was never truncated proves
//     nothing" failure mode the plan's own instructions warn about — and
//     it is why the emptiness assertion is load-bearing, not decorative.
//     The adjacent-partition-untouched assertion failed correctly in this
//     sabotaged run too (the wrong partition WAS wiped and never
//     replayed back, so it came back empty instead of matching its own
//     pre-truncation snapshot).
//
// Both the TRUNCATE target and the assertion were reverted to the correct
// values below before this suite was left in its final state.
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

// A random UTC MONTH in an 8-year window no other test in this repo uses
// (checked against every sibling fixture window: flush.test.ts/
// coupled-writes.test.ts 2026, default-partition.test.ts 2031,
// stream-read.test.ts ~2033-2041, reconciliation.test.ts 2050-2057,
// replay-driver.test.ts 2090-2097, replay.test.ts 2110-2117 and
// 2119-2126, e2e-pg-outage.test.ts 2130-2137, e2e-r2-outage.test.ts /
// replay-report.test.ts 2140-2147, replay-report.test.ts's own second
// window 2150-2157) — this worktree's MinIO bucket is shared with
// concurrent sibling agents/tests, so a wide, previously-unused window
// keeps a same-month collision with any OTHER test file vanishingly
// unlikely, matching the precedent those files already establish. Every
// Postgres assertion below reads from a private per-test testcontainer
// (nothing outside this file's own beforeAll ever touches it), so the
// only theoretical collision risk left is a concurrent run of THIS SAME
// file picking the identical month at random — the same class of
// accepted, vanishingly-unlikely risk every sibling file above already
// lives with.
const FIXTURE_BASE_YEAR = 2160;
const FIXTURE_MONTH_SPAN = 96; // 8 years
const targetMonthOffset = Math.floor(Math.random() * FIXTURE_MONTH_SPAN);
const TARGET_MONTH_START = new Date(Date.UTC(FIXTURE_BASE_YEAR, targetMonthOffset, 1));
const TARGET_YEAR = TARGET_MONTH_START.getUTCFullYear();
const TARGET_MONTH = TARGET_MONTH_START.getUTCMonth(); // 0-indexed

// The month immediately AFTER the target — the real neighbour partition
// this test proves stays untouched. `Date.UTC` normalizes a month-index
// overflow (e.g. TARGET_MONTH === 11) into the correct following January,
// so this needs no manual carry arithmetic.
const ADJACENT_MONTH_START = new Date(Date.UTC(TARGET_YEAR, TARGET_MONTH + 1, 1));
const ADJACENT_YEAR = ADJACENT_MONTH_START.getUTCFullYear();
const ADJACENT_MONTH = ADJACENT_MONTH_START.getUTCMonth();

function zeroPad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `events_YYYY_MM` — exactly `create_events_partition`'s own naming
 * scheme (packages/core/migrations/sql/003_partition_fn.sql:
 * `'events_' || to_char(v_start, 'YYYY_MM')`). */
function partitionName(year: number, month0: number): string {
  return `events_${year}_${zeroPad(month0 + 1, 2)}`;
}

/** `YYYY-MM-01` — the date literal `create_events_partition(p_month date)`
 * expects (any day within the target month works; it truncates to the
 * month itself). */
function monthStartDateLiteral(year: number, month0: number): string {
  return `${year}-${zeroPad(month0 + 1, 2)}-01`;
}

const TARGET_PARTITION = partitionName(TARGET_YEAR, TARGET_MONTH);
const ADJACENT_PARTITION = partitionName(ADJACENT_YEAR, ADJACENT_MONTH);

// A single instant, deep in the middle of each month (day 15, noon UTC —
// nowhere near a month boundary), shared by every event flushed into that
// month's batch. `eventBatchKey` keys the R2 object off the FIRST event's
// `occurred_at` (flush.ts's own `putEventBatch` call) — sharing one instant
// per batch is what guarantees the whole batch's R2 object lands under
// that month's own `dt=.../hour=.../` prefix, matching every sibling
// fixture's identical convention (replay-driver.test.ts, replay.test.ts).
const TARGET_OCCURRED_AT = new Date(Date.UTC(TARGET_YEAR, TARGET_MONTH, 15, 12, 0, 0)).toISOString();
const ADJACENT_OCCURRED_AT = new Date(
  Date.UTC(ADJACENT_YEAR, ADJACENT_MONTH, 15, 12, 0, 0),
).toISOString();

// The replay range handed to `posta replay --from/--to`: the first instant
// of the target month through the first instant of its LAST day —
// `eventPrefixes` (T3.6.1) walks whole UTC calendar days between these two,
// so this covers every day of the target month and, by construction, NOT
// one day of the adjacent month (see that function's own header on why it
// only ever over-covers within the days it's given, never crosses into a
// day outside [from, to]).
const REPLAY_FROM = new Date(Date.UTC(TARGET_YEAR, TARGET_MONTH, 1)).toISOString();
const REPLAY_TO = new Date(Date.UTC(TARGET_YEAR, TARGET_MONTH + 1, 0)).toISOString(); // day 0 of next month = last day of this one

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const PIXEL_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36';

function buildCaptureEvent(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: TARGET_OCCURRED_AT,
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

/** Every one of the 31 `events` columns, exactly as Postgres names them —
 * same shape and same `occurred_at` ISO-string normalization technique as
 * replay-driver.test.ts's own `PgEventRow`/`fetchEventRows`, so two
 * snapshots taken minutes apart (pre-truncation vs. post-replay) compare
 * with plain `toEqual` rather than a timezone-sensitive raw `Date`. */
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

/** Reads every row physically stored in ONE leaf partition, ordered for a
 * stable `toEqual` comparison — same `FROM ONLY <partition>` technique
 * partitions.test.ts/default-partition.test.ts already use to prove a row
 * landed (or didn't land) in a specific partition. `partition` is always
 * one of this file's own two computed constants (`TARGET_PARTITION`/
 * `ADJACENT_PARTITION`), never external input, so directly interpolating
 * the identifier here (Postgres has no parameter placeholder for a table
 * name) is safe. */
async function fetchPartitionRows(handle: PgContainerHandle, partition: string): Promise<PgEventRow[]> {
  const result = await handle.pool.query(`SELECT * FROM ONLY ${partition} ORDER BY event_id`);
  return result.rows.map((row) => ({
    ...row,
    occurred_at: new Date(row.occurred_at).toISOString(),
  }));
}

async function countPartitionRows(handle: PgContainerHandle, partition: string): Promise<number> {
  const result = await handle.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ONLY ${partition}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** `tableoid::regclass::text` for every row belonging to one link — the
 * same physical-placement technique partition-boundaries.test.ts's own
 * `tableoidFor` uses, scoped by `link_id` here (rather than a single
 * `event_id`) since this file wants ALL of one link's rows checked at
 * once. Queries the PARENT `events` table, not a specific partition — the
 * whole point is discovering which partition Postgres itself routed each
 * row into, which `FROM ONLY <partition>` would beg the question of. */
async function tableoidsForLink(handle: PgContainerHandle, linkId: string): Promise<string[]> {
  const result = await handle.pool.query<{ tableoid: string }>(
    `SELECT tableoid::regclass::text AS tableoid FROM events WHERE link_id = $1 ORDER BY event_id`,
    [linkId],
  );
  return result.rows.map((row) => row.tableoid);
}

describe('truncate-and-restore (T3.6.6) — truncate a real events partition and rebuild it via the real posta replay CLI [INV-7]', () => {
  let pg: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  const r2CreatedKeys: string[] = [];

  let tenantId: string;
  let targetLinkId: string;
  let adjacentLinkId: string;

  const TARGET_EVENT_COUNT = 6;
  const ADJACENT_EVENT_COUNT = 4;

  let preTruncationTargetRows: PgEventRow[];
  let preTruncationAdjacentRows: PgEventRow[];
  let targetCountAfterTruncate: number;
  let adjacentCountAfterTruncate: number;

  let replayResult: ReplayCliResult;
  let replayStderrLines: string[];
  let postReplayTargetRows: PgEventRow[];
  let postReplayAdjacentRows: PgEventRow[];
  let postReplayTargetTableoids: string[];

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

    // --- Explicitly create BOTH monthly partitions via the real SQL
    // function (T1.3.1). Without this, events dated into either month
    // would silently land in `events_default` instead (see
    // default-partition.test.ts) — this is the mechanism this whole test
    // needs a REAL partition (not the default catch-all) to exist for.
    await pg.pool.query('SELECT create_events_partition($1::date)', [
      monthStartDateLiteral(TARGET_YEAR, TARGET_MONTH),
    ]);
    await pg.pool.query('SELECT create_events_partition($1::date)', [
      monthStartDateLiteral(ADJACENT_YEAR, ADJACENT_MONTH),
    ]);

    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantId = await seedTenant(pg);
    targetLinkId = await seedLink(pg, tenantId, 'target-promo', 'https://Target.Example.com/promo');
    adjacentLinkId = await seedLink(pg, tenantId, 'adjacent-promo', 'https://Adjacent.Example.org/promo');

    const targetEvents: CaptureEvent[] = Array.from({ length: TARGET_EVENT_COUNT }, (_, index) =>
      buildCaptureEvent({
        tenant_id: tenantId,
        link_id: targetLinkId,
        slug: 'target-promo',
        occurred_at: TARGET_OCCURRED_AT,
        user_agent: index % 2 === 0 ? DESKTOP_CHROME_UA : PIXEL_CHROME_UA,
        referer: index % 3 === 0 ? 'https://www.instagram.com/' : null,
      }),
    );
    const adjacentEvents: CaptureEvent[] = Array.from({ length: ADJACENT_EVENT_COUNT }, () =>
      buildCaptureEvent({
        tenant_id: tenantId,
        link_id: adjacentLinkId,
        slug: 'adjacent-promo',
        occurred_at: ADJACENT_OCCURRED_AT,
        user_agent: DESKTOP_CHROME_UA,
      }),
    );

    // --- REAL LIVE PATH: the same flushBatch T3.3.2/T3.4.6 built, real
    // Postgres, real MinIO — writes BOTH months' worth of control data
    // through the exact same pipeline production traffic uses. This is
    // never called again after this point: the "replay" step below goes
    // through runReplayCli only, never flushBatch/enrich() again.
    const flushBatch: FlushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });
    const targetBatchId = newId();
    const adjacentBatchId = newId();
    r2CreatedKeys.push(eventBatchKey(targetBatchId, TARGET_OCCURRED_AT));
    r2CreatedKeys.push(eventBatchKey(adjacentBatchId, ADJACENT_OCCURRED_AT));
    await flushBatch(targetEvents, targetBatchId);
    await flushBatch(adjacentEvents, adjacentBatchId);

    // --- Pre-truncation snapshots of BOTH partitions — what a correct
    // truncate+rebuild must reproduce exactly for the target, and leave
    // completely alone for the adjacent one.
    preTruncationTargetRows = await fetchPartitionRows(pg, TARGET_PARTITION);
    preTruncationAdjacentRows = await fetchPartitionRows(pg, ADJACENT_PARTITION);
    expect(preTruncationTargetRows).toHaveLength(TARGET_EVENT_COUNT);
    expect(preTruncationAdjacentRows).toHaveLength(ADJACENT_EVENT_COUNT);

    // --- TRUNCATE ONLY the target partition, by its real leaf-partition
    // name — never `TRUNCATE TABLE events`. No `ONLY` keyword: this
    // codebase's own existing TRUNCATE precedent (replay-driver.test.ts,
    // replay.test.ts, replay-report.test.ts, sql-migrate-down.test.ts) never
    // uses it, and for a LEAF partition with no children of its own, `TRUNCATE
    // TABLE x` and `TRUNCATE TABLE ONLY x` are equivalent regardless — matching
    // the established style is preferred over introducing a new one with no
    // behavioral difference.
    await pg.pool.query(`TRUNCATE TABLE ${TARGET_PARTITION}`);

    // Load-bearing, not decorative (see this file's own sabotage-and-revert
    // note above): a rebuild test that would also pass against a partition
    // that was never truncated proves nothing, so the emptiness is asserted
    // for real BEFORE replay ever runs.
    targetCountAfterTruncate = await countPartitionRows(pg, TARGET_PARTITION);
    adjacentCountAfterTruncate = await countPartitionRows(pg, ADJACENT_PARTITION);

    // --- REPLAY via the REAL `posta replay` CLI entrypoint (T3.6.4),
    // never the lower-level driver directly. `--from`/`--to` scope the
    // range to exactly the target month (see REPLAY_FROM/REPLAY_TO's own
    // comment); `--tenant` scopes it to this test's own tenant, a defense
    // against a same-month R2 collision with a concurrent sibling run of
    // this SAME file inserting extra rows into this private container.
    replayStderrLines = [];
    const deps: ReplayCliDeps = {
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      stdout: () => undefined,
      stderr: (line: string) => replayStderrLines.push(line),
    };
    replayResult = await runReplayCli(
      ['--from', REPLAY_FROM, '--to', REPLAY_TO, '--tenant', tenantId],
      deps,
    );

    postReplayTargetRows = await fetchPartitionRows(pg, TARGET_PARTITION);
    postReplayAdjacentRows = await fetchPartitionRows(pg, ADJACENT_PARTITION);
    postReplayTargetTableoids = await tableoidsForLink(pg, targetLinkId);
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

  it('sanity: the TRUNCATE genuinely emptied the target partition BEFORE replay ran — a rebuild test that would also pass against a never-truncated partition proves nothing', () => {
    expect(targetCountAfterTruncate).toBe(0);
  });

  it('sanity: truncating the target partition did not touch the adjacent partition\'s row count', () => {
    expect(adjacentCountAfterTruncate).toBe(ADJACENT_EVENT_COUNT);
  });

  it('replay completed successfully via the real posta replay CLI, reading and writing this run\'s own records', () => {
    expect(replayResult.exitCode).toBe(0);
    expect(replayResult.summary).toBeDefined();
    expect(replayResult.summary?.recordsRead).toBeGreaterThanOrEqual(TARGET_EVENT_COUNT);
    expect(replayResult.summary?.batchesWritten).toBe(1);
    expect(replayStderrLines).toHaveLength(0);
  });

  it('[INV-7] the rebuilt target partition is byte-for-byte identical to the pre-truncation snapshot — every column, same count, same order', () => {
    expect(postReplayTargetRows).toHaveLength(TARGET_EVENT_COUNT);
    expect(postReplayTargetRows).toEqual(preTruncationTargetRows);
  });

  it('every rebuilt row physically landed in the target partition itself (tableoid), never events_default or any other partition', () => {
    expect(postReplayTargetTableoids).toHaveLength(TARGET_EVENT_COUNT);
    for (const tableoid of postReplayTargetTableoids) {
      expect(tableoid).toBe(TARGET_PARTITION);
    }
  });

  it('[INV-7] the adjacent partition is completely untouched — byte-for-byte identical to ITS OWN pre-truncation snapshot, never truncated, never replayed into', () => {
    expect(postReplayAdjacentRows).toHaveLength(ADJACENT_EVENT_COUNT);
    expect(postReplayAdjacentRows).toEqual(preTruncationAdjacentRows);
  });

  it('no extras in either partition after rebuild — exact counts, not "at least"', async () => {
    expect(await countPartitionRows(pg, TARGET_PARTITION)).toBe(TARGET_EVENT_COUNT);
    expect(await countPartitionRows(pg, ADJACENT_PARTITION)).toBe(ADJACENT_EVENT_COUNT);
  });
});
