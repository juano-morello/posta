import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T1.2.3 — parent-level indexes for tenant+link event queries, created on
// the PARENT `events` table so Postgres propagates them to every
// partition, existing and future — partitions created later (T1.3.1)
// inherit them automatically, with no per-partition copy needed. This
// test creates a partition with raw SQL (T1.3.1 automates that; this
// story only needs one to exist) and verifies against a REAL
// testcontainers Postgres that the indexes actually propagated, and that
// a tenant+link+occurred_at range query's plan both uses an index and
// prunes to only the matching partition.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

const JULY_PARTITION = 'events_y2026m07';
const AUGUST_PARTITION = 'events_y2026m08';

describe('events parent-level indexes (T1.2.3)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    await handle.pool.query(`
      CREATE TABLE ${JULY_PARTITION} PARTITION OF events
      FOR VALUES FROM ('2026-07-01') TO ('2026-08-01')
    `);
    await handle.pool.query(`
      CREATE TABLE ${AUGUST_PARTITION} PARTITION OF events
      FOR VALUES FROM ('2026-08-01') TO ('2026-09-01')
    `);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('both parent indexes are attached to the partition via pg_inherits', async () => {
    const result = await handle.pool.query<{ parent_index: string; child_table: string }>(`
      SELECT p.relname AS parent_index, c2.relname AS child_table
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_index idx ON idx.indexrelid = c.oid
      JOIN pg_class c2 ON c2.oid = idx.indrelid
      WHERE p.relname IN ('events_tenant_link_occurred_at_idx', 'events_tenant_occurred_at_idx')
        AND c2.relname = $1
    `, [JULY_PARTITION]);

    const parentIndexes = result.rows.map((row) => row.parent_index).sort();
    expect(parentIndexes).toEqual(
      ['events_tenant_link_occurred_at_idx', 'events_tenant_occurred_at_idx'].sort(),
    );
  });

  it('EXPLAIN of a tenant+link+occurred_at range query uses an Index Scan and prunes to only the matching partition', async () => {
    // A near-empty table never picks an index on cost alone — disabling
    // seqscan is the standard way to assert an index WOULD be used
    // (same technique as links.test.ts's T1.1.5 EXPLAIN assertion).
    await handle.pool.query('SET enable_seqscan = off');

    const result = await handle.pool.query<{ 'QUERY PLAN': string }>(`
      EXPLAIN SELECT event_id FROM events
      WHERE tenant_id = 'tenant-x' AND link_id = 'link-x'
        AND occurred_at >= '2026-07-01' AND occurred_at < '2026-07-15'
    `);
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Index Scan/i);
    expect(plan).toContain(JULY_PARTITION);
    // The real substance of this test: tenant_id must appear in an
    // "Index Cond" line — a search condition the index itself applies —
    // not merely in a post-scan "Filter" line. Verified against the PK
    // (event_id, occurred_at) ALONE, before this migration existed, this
    // exact query produced `Index Cond: (occurred_at ...)` with tenant_id
    // AND link_id both pushed into a post-scan Filter instead (the PK's
    // leading column is event_id, not tenant_id, so it can't use either
    // as a search condition) — this assertion is what tells the two
    // cases apart. The planner is free to pick EITHER of the two new
    // indexes depending on its own cost estimate; both make tenant_id
    // sargable, which is the property that actually matters here.
    expect(plan).toMatch(/Index Cond:.*tenant_id/i);
    // Partition pruning: the July-only range must never touch August's
    // partition.
    expect(plan).not.toContain(AUGUST_PARTITION);

    await handle.pool.query('SET enable_seqscan = on');
  });
});
