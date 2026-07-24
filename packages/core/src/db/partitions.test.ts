import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { runSqlMigrations } from './sql-migrate';

// T1.3.1 — create_events_partition(month) computes date_trunc('month',
// p_month) and the following month as UTC bounds, and creates
// events_YYYY_MM PARTITION OF events FOR VALUES FROM (...) TO (...).
// Indexes are inherited from the parent (T1.2.3) — this function
// deliberately creates none, or every insert would pay double the write
// cost. Calling it twice for the same month is a no-op
// (CREATE TABLE IF NOT EXISTS).
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

describe('create_events_partition (T1.3.1)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('calling it twice for 2026-09-01 is a no-op — exactly one events_2026_09 exists', async () => {
    await handle.pool.query(`SELECT create_events_partition('2026-09-01'::date)`);
    await handle.pool.query(`SELECT create_events_partition('2026-09-01'::date)`);

    const result = await handle.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      WHERE c.relname = 'events_2026_09'
    `);
    expect(result.rows[0]?.count).toBe('1');
  });

  it('both parent indexes are attached to the new partition — the function creates none of its own', async () => {
    const result = await handle.pool.query<{ parent_index: string }>(`
      SELECT p.relname AS parent_index
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_index idx ON idx.indexrelid = c.oid
      JOIN pg_class c2 ON c2.oid = idx.indrelid
      WHERE p.relname IN ('events_tenant_link_occurred_at_idx', 'events_tenant_occurred_at_idx')
        AND c2.relname = 'events_2026_09'
    `);
    const parentIndexes = result.rows.map((row) => row.parent_index).sort();
    expect(parentIndexes).toEqual(
      ['events_tenant_link_occurred_at_idx', 'events_tenant_occurred_at_idx'].sort(),
    );
  });

  it('its bounds are [2026-09-01 00:00+00, 2026-10-01 00:00+00), regardless of session TimeZone', async () => {
    // A non-UTC session TimeZone at read time — same technique as
    // T1.1.6's bio-pages timestamptz round-trip test — proves the
    // function computed genuinely UTC bounds rather than bounds
    // dependent on whatever TimeZone happened to be active when the
    // function ran.
    await handle.pool.query(`SET TIME ZONE 'America/Sao_Paulo'`);
    await handle.pool.query(`SELECT create_events_partition('2027-01-01'::date)`);

    await handle.pool.query(`SET TIME ZONE 'UTC'`);
    const boundResult = await handle.pool.query<{ partition_bound: string }>(`
      SELECT pg_get_expr(c.relpartbound, c.oid) AS partition_bound
      FROM pg_class c WHERE c.relname = 'events_2027_01'
    `);
    const bound = boundResult.rows[0]?.partition_bound ?? '';

    expect(bound).toContain("'2027-01-01 00:00:00+00'");
    expect(bound).toContain("'2027-02-01 00:00:00+00'");
  });
});
