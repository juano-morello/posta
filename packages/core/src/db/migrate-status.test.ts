import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbClient, runDrizzleMigrations, type DbClient } from './client';
import { getMigrationStatus, hasPendingMigrations } from './migrate-status';
import { migrate } from './migrate';

// T1.5.2 — `pnpm migrate:status` reports both migration flavors in one
// table (filename, flavor, applied_at | PENDING) so CI (T1.5.4) can gate
// on `hasPendingMigrations()` directly instead of parsing printed output.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const CONTAINER_POOL_MAX = 5;

describe('migrate-status (T1.5.2)', () => {
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

  it('a half-migrated database (drizzle applied, sql not yet) lists the sql files as PENDING', async () => {
    await runDrizzleMigrations(client.db);

    const rows = await getMigrationStatus(client.pool);

    const drizzleRows = rows.filter((row) => row.flavor === 'drizzle');
    const sqlRows = rows.filter((row) => row.flavor === 'sql');

    expect(drizzleRows.length).toBeGreaterThan(0);
    for (const row of drizzleRows) {
      expect(row.appliedAt).not.toBe('PENDING');
    }

    expect(sqlRows.length).toBeGreaterThan(0);
    for (const row of sqlRows) {
      expect(row.appliedAt).toBe('PENDING');
    }

    expect(hasPendingMigrations(rows)).toBe(true);
  });

  it('after pnpm migrate applies both flavors, nothing is pending', async () => {
    await migrate(client.pool, client.db);

    const rows = await getMigrationStatus(client.pool);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.appliedAt).not.toBe('PENDING');
    }
    expect(hasPendingMigrations(rows)).toBe(false);
  });
});
