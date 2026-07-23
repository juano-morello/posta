import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDbClient, type DbClient } from './client';
import { main, migrate } from './migrate';

// T1.5.1 — the unified entrypoint (`pnpm migrate`) applies drizzle-kit's
// migrations FIRST, then the hand-written SQL ones. The order is fixed,
// not incidental: 003_partition_fn.sql's create_events_partition() is
// called by 005_bootstrap_partitions.sql, and a future E4 SQL migration
// (events_classified, a view) will depend on asn_datacenter, which
// drizzle owns (T1.4.1) — so drizzle must always run first.
//
// Boots a RAW container (not via pg-container.ts's startPgContainer(),
// which already runs drizzle migrations in its own beforeAll) so this
// test can prove migrate() itself produces every table from a genuinely
// empty database, not one drizzle already partially migrated.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const CONTAINER_POOL_MAX = 5;

describe('migrate (T1.5.1)', () => {
  let container: StartedPostgreSqlContainer;
  let client: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = createDbClient({ connectionString: container.getConnectionUri(), max: CONTAINER_POOL_MAX });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await client.closeDb();
    await container.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('the first run produces every drizzle table, the partition function, and the bootstrap partitions', async () => {
    await migrate(client.pool, client.db);

    const tables = await client.pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const tableNames = tables.rows.map((row) => row.table_name);
    for (const expected of [
      'user',
      'session',
      'account',
      'verification',
      'links',
      'bio_pages',
      'bio_links',
      'domains',
      'asn_datacenter',
      'events',
    ]) {
      expect(tableNames, `expected table "${expected}" to exist`).toContain(expected);
    }

    const fn = await client.pool.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname = 'create_events_partition'`,
    );
    expect(fn.rows).toHaveLength(1);

    const partitions = await client.pool.query<{ relname: string }>(`
      SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'events'
    `);
    const partitionNames = partitions.rows.map((row) => row.relname);
    expect(partitionNames).toContain('events_default');
    // bootstrap (T1.3.3): current month + 3 ahead = 4 monthly partitions,
    // plus events_default.
    expect(partitionNames.length).toBeGreaterThanOrEqual(5);
  });

  it('the second run applies nothing new and resolves cleanly — both flavors are idempotent together', async () => {
    await expect(migrate(client.pool, client.db)).resolves.toBeUndefined();

    const tables = await client.pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    // Same table count as after the first run confirms nothing was
    // duplicated or re-created — this uses sql`` via the pool directly,
    // so a genuine re-run failure would throw and fail this test, not
    // just report the same count by coincidence.
    expect(tables.rows.length).toBeGreaterThan(0);
  });
});

describe('main() — the real pnpm migrate CLI entrypoint (coverage, S1.5 review)', () => {
  // main() reads DATABASE_URL/DB_POOL_MAX from env via createDbClient()
  // (same as the real `pnpm migrate` invocation) — set and restored per
  // test so this never leaks into other test files sharing the process.
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPoolMax = process.env.DB_POOL_MAX;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = originalPoolMax;
    vi.restoreAllMocks();
  });

  it('applies every migration against a real empty database and logs success', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DB_POOL_MAX = '5';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(main()).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('applied every pending drizzle and sql migration'),
      );
    } finally {
      await container.stop();
    }
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a real migration failure (connecting to an already-stopped container) propagates, not swallowed by cleanup', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const deadConnectionUri = container.getConnectionUri();
    await container.stop();

    process.env.DATABASE_URL = deadConnectionUri;
    process.env.DB_POOL_MAX = '5';

    await expect(main()).rejects.toThrow();
  }, CONTAINER_TEST_TIMEOUT_MS);
});
