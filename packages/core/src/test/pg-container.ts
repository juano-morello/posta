import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDbClient, runDrizzleMigrations, type DbClient } from '../db/client';

// T1.1.2 — the shared testcontainers Postgres 16 harness every integration
// test in E1-E4 reuses, instead of each test file booting its own
// container. Boots the SAME image docker-compose.yml and CI's postgres
// service pin (postgres:16-alpine), applies every drizzle migration
// through the T1.1.1 programmatic migrator, and hands back { db, url,
// stop } — never a mock, a real Postgres for every integration test that
// calls this.

const POSTGRES_IMAGE = 'postgres:16-alpine';
// A container serves exactly one test file's queries, sequentially — no
// horizontal-scaling concern here, unlike the real api pool. Still
// explicit rather than left to the pg driver default, same rule as
// T1.1.1's createDbClient.
const CONTAINER_POOL_MAX = 5;

export interface PgContainerHandle {
  readonly db: DbClient['db'];
  readonly url: string;
  /** Closes the db pool, then stops and removes the container. */
  stop(): Promise<void>;
}

/**
 * Boots a fresh Postgres 16 container, migrates it, and returns a handle.
 * Callers own the handle's lifecycle: always call `stop()` (typically from
 * an `afterAll`), or the container and its pool outlive the test run.
 */
export async function startPgContainer(): Promise<PgContainerHandle> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGRES_IMAGE,
  ).start();
  const url = container.getConnectionUri();

  const client = createDbClient({ connectionString: url, max: CONTAINER_POOL_MAX });
  await runDrizzleMigrations(client.db);

  return {
    db: client.db,
    url,
    async stop(): Promise<void> {
      await client.closeDb();
      await container.stop();
    },
  };
}
