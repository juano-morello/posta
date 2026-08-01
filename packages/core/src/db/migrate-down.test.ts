import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDbClient, type DbClient } from './client';
import { main, migrateDown } from './migrate-down';
import { getMigrationStatus, hasPendingMigrations } from './migrate-status';
import { migrate } from './migrate';

// T1.5.3 — `pnpm migrate:down` reverts exactly one step, newest first,
// using the .down.sql pairs T1.2.6 created. Only 001_events.sql,
// 002_events_indexes.sql, 006_events_classified.sql (T4.1.1),
// 007_roles_reader.sql (T4.2.2), and (since T4.2.3) 008_roles_writer.sql
// HAVE a .down.sql pair (003/004/005 do not, by design — see
// docs/plan/01-data-model.md's S1.2/S1.3), so "newest first" here means:
// walk backward from the newest APPLIED sql migration and revert the
// first one that actually has a .down.sql file, which after a fresh
// `migrate()` is 008_roles_writer.sql — the posta_worker role grant,
// being the newest SQL migration on disk, not 007_roles_reader.sql as it
// was before T4.2.3 added a migration after it.
// Drizzle migrations are never touched — this only ever reads/writes
// _posta_sql_migrations, never drizzle.__drizzle_migrations.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const CONTAINER_POOL_MAX = 5;

describe('migrateDown (T1.5.3)', () => {
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

  it('migrates, downs once, reports exactly one pending file, re-migrates cleanly', async () => {
    await migrate(client.pool, client.db);

    const reverted = await migrateDown(client.pool);
    expect(reverted).toBe('008_roles_writer.sql');

    const statusAfterDown = await getMigrationStatus(client.pool);
    const pendingRows = statusAfterDown.filter((row) => row.appliedAt === 'PENDING');
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]?.filename).toBe('008_roles_writer.sql');
    expect(pendingRows[0]?.flavor).toBe('sql');
    expect(hasPendingMigrations(statusAfterDown)).toBe(true);

    // posta_worker (T4.2.3) is genuinely gone post-down — its down.sql
    // revokes its grant then DROP ROLEs it. posta_app (T4.2.2) and
    // events_classified (T4.1.1) are untouched: migrateDown reverts
    // exactly one step, and 008 is the newest revertible migration now,
    // not 007.
    const workerRoleAfterDown = await client.pool.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'posta_worker'`,
    );
    expect(workerRoleAfterDown.rows).toEqual([]);

    const readerRoleAfterDown = await client.pool.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'posta_app'`,
    );
    expect(readerRoleAfterDown.rows).toHaveLength(1);

    const viewAfterDown = await client.pool.query<{ exists: string | null }>(
      `SELECT to_regclass('events_classified')::text AS exists`,
    );
    expect(viewAfterDown.rows[0]?.exists).toBe('events_classified');

    await migrate(client.pool, client.db);

    const statusAfterReMigrate = await getMigrationStatus(client.pool);
    expect(hasPendingMigrations(statusAfterReMigrate)).toBe(false);

    const roleAfterReMigrate = await client.pool.query<{ has_privilege: boolean }>(
      `SELECT has_table_privilege('posta_worker', 'events', 'INSERT') AS has_privilege`,
    );
    expect(roleAfterReMigrate.rows[0]?.has_privilege).toBe(true);
  });

  it('refuses when there is nothing revertible (no sql migrations applied at all)', async () => {
    const freshContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    const freshClient = createDbClient({
      connectionString: freshContainer.getConnectionUri(),
      max: CONTAINER_POOL_MAX,
    });

    try {
      await expect(migrateDown(freshClient.pool)).rejects.toThrow(/nothing (to revert|revertible)/i);
    } finally {
      await freshClient.closeDb();
      await freshContainer.stop();
    }
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('refuses when applied migrations exist but NONE of them have a .down.sql pair on disk', async () => {
    // A different code path than "nothing applied at all" above: the
    // tracking table exists and has rows, but none of THOSE rows have a
    // .down.sql file — 003_partition_fn.sql, 004_default_partition.sql,
    // and 005_bootstrap_partitions.sql are exactly this case for real
    // (see this file's own header comment). Deleting 001/002/006/007/008's
    // tracking rows after a full migrate() reproduces "only non-revertible
    // migrations are tracked as applied" without needing a contrived
    // fixture — 003/004/005 genuinely have no .down.sql pair today.
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const testClient = createDbClient({ connectionString: container.getConnectionUri(), max: CONTAINER_POOL_MAX });

    try {
      await migrate(testClient.pool, testClient.db);
      await testClient.pool.query(
        `DELETE FROM _posta_sql_migrations WHERE filename IN ` +
          `('001_events.sql', '002_events_indexes.sql', '006_events_classified.sql', ` +
          `'007_roles_reader.sql', '008_roles_writer.sql')`,
      );

      await expect(migrateDown(testClient.pool)).rejects.toThrow(/nothing (to revert|revertible)/i);
    } finally {
      await testClient.closeDb();
      await container.stop();
    }
  }, CONTAINER_TEST_TIMEOUT_MS);
});

describe('main() — the real pnpm migrate:down CLI entrypoint (coverage, S1.5 review)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPoolMax = process.env.DB_POOL_MAX;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = originalPoolMax;
    vi.restoreAllMocks();
  });

  it('reverts the newest revertible migration against a real fully-migrated database', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const setupClient = createDbClient({ connectionString: container.getConnectionUri(), max: 5 });
    await migrate(setupClient.pool, setupClient.db);
    await setupClient.closeDb();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DB_POOL_MAX = '5';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(main()).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reverted 008_roles_writer.sql'));
    } finally {
      await container.stop();
    }
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a real migrateDown() failure (nothing applied) propagates, not swallowed by cleanup', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DB_POOL_MAX = '5';

    try {
      await expect(main()).rejects.toThrow(/nothing (to revert|revertible)/i);
    } finally {
      await container.stop();
    }
  }, CONTAINER_TEST_TIMEOUT_MS);
});
