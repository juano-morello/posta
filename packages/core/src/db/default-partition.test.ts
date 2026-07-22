import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { runSqlMigrations } from './sql-migrate';

// T1.3.2 — `CREATE TABLE events_default PARTITION OF events DEFAULT`.
// This is what turns "inserts start failing at midnight on the 1st" into
// "inserts keep working and something beeps" (T1.3.5 wires the beep).
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

describe('events_default partition (T1.3.2)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    // A couple of ordinary monthly partitions, so the test can prove the
    // far-future row falls through to events_default rather than
    // (incorrectly) landing in one of these.
    await handle.pool.query(`SELECT create_events_partition('2026-01-01'::date)`);
    await handle.pool.query(`SELECT create_events_partition('2026-02-01'::date)`);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('an event dated five years out lands in events_default, leaving the monthly partitions empty', async () => {
    await handle.pool.query(`
      INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
      VALUES ('01T132EVENT00000000000000', '2031-07-22T00:00:00Z', 'tenant-x', 'link-x', 'slug-x')
    `);

    const defaultCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ONLY events_default`,
    );
    expect(defaultCount.rows[0]?.count).toBe('1');

    const januaryCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ONLY events_2026_01`,
    );
    expect(januaryCount.rows[0]?.count).toBe('0');

    const februaryCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ONLY events_2026_02`,
    );
    expect(februaryCount.rows[0]?.count).toBe('0');
  });
});
