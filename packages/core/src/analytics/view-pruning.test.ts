import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T4.1.5 [E4, S4.1] — events_classified (T4.1.1,
// packages/core/migrations/sql/006_events_classified.sql) is a plain SQL
// VIEW, never MATERIALIZED, over the monthly-partitioned `events` table
// (001_events.sql) plus its (tenant_id, link_id, occurred_at DESC) index
// (002_events_indexes.sql, T1.2.3). A well-formed simple view SHOULD be
// transparent to the planner — Postgres "folds"/inlines a simple view's
// query into the outer query at plan time, so predicates on the outer
// WHERE push straight down into the base table scan exactly as if
// `events` had been queried directly. That is an assumption, not a given:
// this suite proves it against a REAL testcontainers Postgres rather than
// taking it on faith, because the failure mode is silent and expensive —
// a view that blocks pruning turns every dashboard query into a full
// history table scan with no error, no crash, just a slow query that
// looks identical to a correct one until someone reads the plan.
//
// Reuses the SAME partition-bootstrapping this repo already has, rather
// than hand-writing `CREATE TABLE ... PARTITION OF`:
// 005_bootstrap_partitions.sql (T1.3.3, applied by runSqlMigrations below)
// creates FOUR monthly partitions on every fresh migrate — the current
// month plus the next three — via 003_partition_fn.sql's
// create_events_partition(). This suite uses three of those four
// (current, +1, +2) as its "three consecutive monthly partitions"; it
// does not need to create a fifth.
//
// The EXPLAIN plan is asserted against, not the query RESULT — this is a
// plan-shape test, in the same family as
// packages/core/src/db/partition-boundaries.test.ts's own "prunes to the
// matching partition only" case and
// packages/core/src/schema/events-indexes.test.ts's "uses an Index Scan"
// case, both of which query `events` directly. This file is the one that
// proves the SAME properties survive going through `events_classified`.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

const TENANT_ID = 'tenant-view-pruning';
const LINK_ID = 'link-view-pruning';
const OTHER_TENANT_ID = 'tenant-view-pruning-other';
// The PARENT-level (logical) index name from 002_events_indexes.sql —
// this name only ever exists on the parent `events` table's catalog
// entry. Postgres does NOT propagate this literal name to each
// partition's own physical index (it can't: index names share one
// namespace per schema, so every partition would collide on the same
// name) — instead it auto-generates a per-partition name from the
// partition's own table name plus the indexed columns, e.g.
// `events_2026_09_tenant_id_link_id_occurred_at_idx`. The EXPLAIN plan
// below reports THAT generated name, never this one, so this constant is
// a lookup key (via pg_inherits, see `targetPartitionIndexName` below),
// not something ever expected to appear in a plan node directly.
const PARENT_TARGET_INDEX_NAME = 'events_tenant_link_occurred_at_idx';
// Same story, decoy data: with only a handful of rows Postgres's
// cost-based planner has no reason to prefer the 3-column
// (tenant_id, link_id, occurred_at) index over the cheaper-per-tuple
// 2-column (tenant_id, occurred_at) one — both cost about the same when
// there's nothing to filter. Seeding enough same-tenant/different-link
// decoy rows (below, plus an ANALYZE) gives the 3-column index a real,
// measurable selectivity advantage: verified empirically against the
// live testcontainer that this count is comfortably enough to tip the
// planner's choice.
const DECOY_ROW_COUNT = 300;

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `01T415EVENT${String(eventCounter).padStart(14, '0')}`;
}

/** A JSON EXPLAIN plan node — only the fields this test actually reads. */
interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

interface ExplainJsonRow {
  readonly 'QUERY PLAN': readonly [{ readonly Plan: PlanNode }];
}

/** Depth-first flatten of the plan tree — every node, parent and child alike. */
function flattenPlan(node: PlanNode): PlanNode[] {
  const children = node.Plans ?? [];
  return [node, ...children.flatMap(flattenPlan)];
}

function monthStart(monthsFromNow: number): { year: number; monthIndex: number } {
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
  return { year: target.getUTCFullYear(), monthIndex: target.getUTCMonth() };
}

function dateStringFor(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
}

/** Matches 003_partition_fn.sql's own naming: `'events_' || to_char(v_start, 'YYYY_MM')`. */
function partitionNameFor(year: number, monthIndex: number): string {
  return `events_${year}_${String(monthIndex + 1).padStart(2, '0')}`;
}

function isoAt(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day, 12)).toISOString();
}

const MONTH_0 = monthStart(0);
const MONTH_1 = monthStart(1);
const MONTH_2 = monthStart(2);

const MONTH_1_START = dateStringFor(MONTH_1.year, MONTH_1.monthIndex);
const MONTH_2_START = dateStringFor(MONTH_2.year, MONTH_2.monthIndex);

const MONTH_0_PARTITION = partitionNameFor(MONTH_0.year, MONTH_0.monthIndex);
const MONTH_1_PARTITION = partitionNameFor(MONTH_1.year, MONTH_1.monthIndex);
const MONTH_2_PARTITION = partitionNameFor(MONTH_2.year, MONTH_2.monthIndex);

describe('events_classified preserves partition pruning and index usage (T4.1.5)', () => {
  let handle: PgContainerHandle;
  let rootPlan: PlanNode;
  let allNodes: PlanNode[];
  /** The MONTH_1 partition's own physical index inherited from
   * PARENT_TARGET_INDEX_NAME — resolved dynamically (never hardcoded)
   * because Postgres auto-generates this name per partition; see the
   * comment on PARENT_TARGET_INDEX_NAME above. */
  let targetPartitionIndexName: string;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    // Same technique as partitions.test.ts's "both parent indexes are
    // attached to the new partition" case and events-indexes.test.ts's
    // pg_inherits join, but resolving the CHILD index's own relname
    // (there: just confirming a parent/child link exists at all).
    const childIndexResult = await handle.pool.query<{ relname: string }>(
      `
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_index idx ON idx.indexrelid = c.oid
      JOIN pg_class c2 ON c2.oid = idx.indrelid
      WHERE p.relname = $1 AND c2.relname = $2
    `,
      [PARENT_TARGET_INDEX_NAME, MONTH_1_PARTITION],
    );
    const resolvedIndexName = childIndexResult.rows[0]?.relname;
    if (!resolvedIndexName) {
      throw new Error(
        `Could not resolve ${MONTH_1_PARTITION}'s own physical index inherited from ` +
          `${PARENT_TARGET_INDEX_NAME} — has 002_events_indexes.sql changed?`,
      );
    }
    targetPartitionIndexName = resolvedIndexName;

    // A handful of rows spread across three consecutive monthly
    // partitions (all four already exist courtesy of 005's bootstrap —
    // see header). Same tenant_id/link_id in every row so the query
    // target (month 1) genuinely has matching data, plus one
    // different-tenant row in month 1 itself, proving the index/pruning
    // assertions below hold even when the target partition isn't
    // tenant-homogeneous.
    async function insertEvent(occurredAtIso: string, tenantId: string): Promise<void> {
      await handle.pool.query(
        `INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug, user_agent)
         VALUES ($1, $2, $3, $4, 'slug-view-pruning', 'Mozilla/5.0 (view pruning fixture)')`,
        [nextEventId(), occurredAtIso, tenantId, LINK_ID],
      );
    }

    await insertEvent(isoAt(MONTH_0.year, MONTH_0.monthIndex, 10), TENANT_ID);
    await insertEvent(isoAt(MONTH_1.year, MONTH_1.monthIndex, 5), TENANT_ID);
    await insertEvent(isoAt(MONTH_1.year, MONTH_1.monthIndex, 20), TENANT_ID);
    await insertEvent(isoAt(MONTH_1.year, MONTH_1.monthIndex, 12), OTHER_TENANT_ID);
    await insertEvent(isoAt(MONTH_2.year, MONTH_2.monthIndex, 15), TENANT_ID);

    // Same tenant as the target rows, but each a DIFFERENT link_id — this
    // is what gives the 3-column index its selectivity advantage (see
    // DECOY_ROW_COUNT above): a 2-column (tenant_id, occurred_at) index
    // scan would have to fetch all of these and Filter out every one by
    // link_id, while the 3-column index's Index Cond excludes them
    // directly. One set-based INSERT (generate_series), not a JS loop —
    // 300 individual round trips would be needlessly slow. Spread across
    // days 1-27 of the month (every real month has at least 28 days) so
    // these decoys stay inside MONTH_1's range without ever overflowing
    // into MONTH_2.
    await handle.pool.query(
      `
      INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug, user_agent)
      SELECT
        'decoy-view-pruning-' || i,
        $1::date + ((i % 27) || ' days')::interval + interval '12 hours',
        $2,
        'link-decoy-' || i,
        'slug-view-pruning-decoy',
        'Mozilla/5.0 (decoy)'
      FROM generate_series(1, $3) AS i
    `,
      [MONTH_1_START, TENANT_ID, DECOY_ROW_COUNT],
    );
    // The planner only picks the more selective index over a cost
    // estimate — a freshly-inserted table's statistics are stale (or
    // absent) until analyzed, which would leave the cost estimate
    // computed above meaningless.
    await handle.pool.query('ANALYZE events');

    // A near-empty table never picks an index scan on cost alone — this
    // is the standard technique this repo already uses to assert an
    // index WOULD be used (partition-boundaries.test.ts,
    // events-indexes.test.ts): disable seqscan so the planner is forced
    // toward whatever index-based plan it considers cheapest, rather
    // than defaulting to a full scan simply because the table is tiny.
    await handle.pool.query('SET enable_seqscan = off');

    const result = await handle.pool.query<ExplainJsonRow>(`
      EXPLAIN (FORMAT JSON) SELECT * FROM events_classified
      WHERE tenant_id = '${TENANT_ID}' AND link_id = '${LINK_ID}'
        AND occurred_at >= '${MONTH_1_START}' AND occurred_at < '${MONTH_2_START}'
    `);

    await handle.pool.query('SET enable_seqscan = on');

    const plan = result.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
    if (!plan) {
      throw new Error('EXPLAIN (FORMAT JSON) returned no plan to assert against');
    }
    rootPlan = plan;
    allNodes = flattenPlan(rootPlan);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('sanity check: three consecutive monthly partitions actually exist (reused from the T1.3.3 bootstrap)', async () => {
    const result = await handle.pool.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'events'
    `);
    const partitionNames = result.rows.map((row) => row.relname);

    expect(partitionNames).toContain(MONTH_0_PARTITION);
    expect(partitionNames).toContain(MONTH_1_PARTITION);
    expect(partitionNames).toContain(MONTH_2_PARTITION);
  });

  it('partition pruning: only the partition covering the requested one-month range is scanned', () => {
    const scannedEventPartitions = new Set(
      allNodes
        .map((node) => node['Relation Name'])
        .filter((name): name is string => typeof name === 'string')
        .filter((name) => /^events_\d{4}_\d{2}$/.test(name)),
    );

    expect(scannedEventPartitions.size).toBe(1);
    expect(scannedEventPartitions).toEqual(new Set([MONTH_1_PARTITION]));
    expect(scannedEventPartitions.has(MONTH_0_PARTITION)).toBe(false);
    expect(scannedEventPartitions.has(MONTH_2_PARTITION)).toBe(false);
  });

  it('the plan uses an Index/Bitmap Index Scan on events_tenant_link_occurred_at_idx, not a Seq Scan on events', () => {
    const indexNodesOnTargetIndex = allNodes.filter(
      (node) => node['Index Name'] === targetPartitionIndexName,
    );

    expect(indexNodesOnTargetIndex.length).toBeGreaterThan(0);
    for (const node of indexNodesOnTargetIndex) {
      expect(node['Node Type']).toMatch(/Index Scan/);
    }

    const seqScansOnEvents = allNodes.filter(
      (node) =>
        node['Node Type'] === 'Seq Scan' &&
        typeof node['Relation Name'] === 'string' &&
        /^events(_\d{4}_\d{2})?$/.test(node['Relation Name']),
    );
    expect(seqScansOnEvents).toEqual([]);
  });

  it('the view is inlined — no Subquery Scan node wraps it, predicates reach the base table scan directly', () => {
    const subqueryScanNodes = allNodes.filter((node) => node['Node Type'] === 'Subquery Scan');
    expect(subqueryScanNodes).toEqual([]);
  });

  it('the query still returns exactly the two matching rows (both tenant + month scoped) through the view', async () => {
    const result = await handle.pool.query<{ classification: string }>(
      `SELECT classification FROM events_classified
       WHERE tenant_id = $1 AND link_id = $2
         AND occurred_at >= $3 AND occurred_at < $4`,
      [TENANT_ID, LINK_ID, `${MONTH_1_START}T00:00:00Z`, `${MONTH_2_START}T00:00:00Z`],
    );

    expect(result.rows).toHaveLength(2);
  });
});
