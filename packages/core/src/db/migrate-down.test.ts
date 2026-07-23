import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient, type DbClient } from './client';
import { migrateDown } from './migrate-down';
import { getMigrationStatus, hasPendingMigrations } from './migrate-status';
import { migrate } from './migrate';

// T1.5.3 — `pnpm migrate:down` reverts exactly one step, newest first,
// using the .down.sql pairs T1.2.6 created. Only 001_events.sql and
// 002_events_indexes.sql HAVE a .down.sql pair (003/004/005 do not, by
// design — see docs/plan/01-data-model.md's S1.2/S1.3), so "newest
// first" here means: walk backward from the newest APPLIED sql
// migration and revert the first one that actually has a .down.sql
// file, which after a fresh `migrate()` is 002_events_indexes.sql.
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
    expect(reverted).toBe('002_events_indexes.sql');

    const statusAfterDown = await getMigrationStatus(client.pool);
    const pendingRows = statusAfterDown.filter((row) => row.appliedAt === 'PENDING');
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]?.filename).toBe('002_events_indexes.sql');
    expect(pendingRows[0]?.flavor).toBe('sql');
    expect(hasPendingMigrations(statusAfterDown)).toBe(true);

    // The two indexes 002 creates are genuinely gone post-down.
    const indexesAfterDown = await client.pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('events_tenant_link_occurred_at_idx', 'events_tenant_occurred_at_idx')
    `);
    expect(indexesAfterDown.rows).toHaveLength(0);

    await migrate(client.pool, client.db);

    const statusAfterReMigrate = await getMigrationStatus(client.pool);
    expect(hasPendingMigrations(statusAfterReMigrate)).toBe(false);

    const indexesAfterReMigrate = await client.pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('events_tenant_link_occurred_at_idx', 'events_tenant_occurred_at_idx')
    `);
    expect(indexesAfterReMigrate.rows).toHaveLength(2);
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
});
