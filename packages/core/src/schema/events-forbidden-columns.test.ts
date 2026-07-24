import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T1.2.5 [INV-4][INV-6][security] — the absence of an ip and a
// classification column IS the entire enforcement mechanism for
// invariants 4 and 6: a careless worker cannot store a verdict or a raw
// IP because there is nowhere to put one. This test is not a nice-to-have
// — it is what keeps that absence from being quietly undone by a future
// migration, and it proves itself real by actually adding a forbidden
// column in a throwaway transaction and asserting the detector names it.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

const FORBIDDEN_COLUMN_NAMES = [
  'ip',
  'ip_address',
  'remote_addr',
  'client_ip',
  'classification',
  'verdict',
  'is_bot',
  'is_human',
] as const;

async function findForbiddenColumns(pool: Pool, tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = ANY($2)
    `,
    [tableName, FORBIDDEN_COLUMN_NAMES],
  );
  return result.rows.map((row) => row.column_name);
}

describe('events has no ip or classification column (T1.2.5) [INV-4][INV-6][security]', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('the parent events table has none of the forbidden columns', async () => {
    const forbidden = await findForbiddenColumns(handle.pool, 'events');
    expect(forbidden).toEqual([]);
  });

  it('a partition of events also has none of the forbidden columns — checked separately, per the acceptance criterion', async () => {
    await handle.pool.query(`
      CREATE TABLE events_t125_partition PARTITION OF events
      FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')
    `);

    const forbidden = await findForbiddenColumns(handle.pool, 'events_t125_partition');
    expect(forbidden).toEqual([]);
  });

  it('genuinely fails, naming the column, when a forbidden column is added — in a throwaway transaction, always rolled back', async () => {
    const client = await handle.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE events ADD COLUMN ip inet');

      const result = await client.query<{ column_name: string }>(
        `
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = ANY($1)
        `,
        [FORBIDDEN_COLUMN_NAMES],
      );
      const forbidden = result.rows.map((row) => row.column_name);

      expect(forbidden).toContain('ip');
    } finally {
      // Always rolled back — this transaction must never actually leave
      // the forbidden column in place, even if an assertion above threw.
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the forbidden column really was rolled back — the throwaway transaction left no trace', async () => {
    const forbidden = await findForbiddenColumns(handle.pool, 'events');
    expect(forbidden).toEqual([]);
  });
});
