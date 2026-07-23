import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { ensurePartitionsAhead } from './partitions';
import { runSqlMigrations } from './sql-migrate';

// T1.3.3 — 005_bootstrap_partitions.sql calls create_events_partition for
// date_trunc('month', now()) and the next three months (computed at
// MIGRATION-RUN time, not a fixed date baked into the file, so it stays
// correct whenever it actually runs). ensurePartitionsAhead(months = 3)
// in TypeScript wraps the SAME "current + N months ahead" policy, so
// T1.3.4's scheduled job and this bootstrap migration share one
// definition of "3 months ahead" instead of two independently hardcoded
// loops that could drift apart.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');
const MONTHLY_PARTITION_PATTERN = /^events_\d{4}_\d{2}$/;

async function listEventsPartitions(handle: PgContainerHandle): Promise<string[]> {
  const result = await handle.pool.query<{ relname: string }>(`
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'events'
  `);
  return result.rows.map((row) => row.relname);
}

describe('bootstrap partitions on migrate (T1.3.3)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a fresh migrate produces exactly 4 monthly partitions plus events_default', async () => {
    const partitionNames = await listEventsPartitions(handle);

    const monthlyPartitions = partitionNames.filter((name) => MONTHLY_PARTITION_PATTERN.test(name));
    expect(monthlyPartitions).toHaveLength(4);
    expect(partitionNames).toContain('events_default');
  });

  it('an insert dated 2 months out lands in its own monthly partition, not events_default', async () => {
    const twoMonthsOut = new Date();
    twoMonthsOut.setUTCMonth(twoMonthsOut.getUTCMonth() + 2, 15); // mid-month, avoids boundary edge cases

    await handle.pool.query(
      `INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
       VALUES ($1, $2, 'tenant-x', 'link-x', 'slug-x')`,
      ['01T133EVENT00000000000000', twoMonthsOut.toISOString()],
    );

    const result = await handle.pool.query<{ tableoid: string }>(
      `SELECT tableoid::regclass::text AS tableoid FROM events WHERE event_id = $1`,
      ['01T133EVENT00000000000000'],
    );

    expect(result.rows[0]?.tableoid).toMatch(MONTHLY_PARTITION_PATTERN);
    expect(result.rows[0]?.tableoid).not.toBe('events_default');

    const defaultCount = await handle.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ONLY events_default`,
    );
    expect(defaultCount.rows[0]?.count).toBe('0');
  });

  it('ensurePartitionsAhead(months) creates further-out partitions on demand — shared with T1.3.4', async () => {
    await ensurePartitionsAhead(handle.pool, 6);

    const partitionNames = await listEventsPartitions(handle);
    const monthlyPartitions = partitionNames.filter((name) => MONTHLY_PARTITION_PATTERN.test(name));

    // The bootstrap migration already created 4 (current + 3); asking for
    // 6 months ahead must grow that to at least 7 (current + 6),
    // proving ensurePartitionsAhead genuinely creates new partitions
    // rather than being a no-op past the bootstrap's own count.
    expect(monthlyPartitions.length).toBeGreaterThanOrEqual(7);
  });

  it('ensurePartitionsAhead is idempotent — calling it again with the same months creates nothing new', async () => {
    const before = (await listEventsPartitions(handle)).sort();

    await ensurePartitionsAhead(handle.pool, 6);

    const after = (await listEventsPartitions(handle)).sort();
    expect(after).toEqual(before);
  });
});

describe('ensurePartitionsAhead error context (silent-failure review, batch 1)', () => {
  let handle: PgContainerHandle;
  let partialMigrationsDir: string;

  beforeAll(async () => {
    handle = await startPgContainer();

    // A REAL failure, not a mock: apply only 001/002 (the events table +
    // its indexes), deliberately WITHOUT 003_partition_fn.sql — so
    // create_events_partition() genuinely does not exist, and
    // ensurePartitionsAhead's first pool.query() call fails for real.
    partialMigrationsDir = mkdtempSync(path.join(tmpdir(), 'posta-partial-migrations-'));
    mkdirSync(partialMigrationsDir, { recursive: true });
    copyFileSync(
      path.join(MIGRATIONS_DIR, '001_events.sql'),
      path.join(partialMigrationsDir, '001_events.sql'),
    );
    copyFileSync(
      path.join(MIGRATIONS_DIR, '002_events_indexes.sql'),
      path.join(partialMigrationsDir, '002_events_indexes.sql'),
    );
    await runSqlMigrations(handle.pool, { migrationsDir: partialMigrationsDir });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    rmSync(partialMigrationsDir, { recursive: true, force: true });
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('names the specific month it failed on, not just a bare Postgres error', async () => {
    await expect(ensurePartitionsAhead(handle.pool, 3)).rejects.toThrow(
      /ensurePartitionsAhead: failed to create the partition for \d{4}-\d{2}-01 \(offset 0 of 0-3\)/,
    );
  });
});
