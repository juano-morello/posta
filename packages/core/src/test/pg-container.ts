import type { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDbClient, runDrizzleMigrations, type DbClient } from '../db/client';

// T1.1.2 — the shared testcontainers Postgres 16 harness every integration
// test in E1-E4 reuses, instead of each test file booting its own
// container. Boots the SAME image docker-compose.yml and CI's postgres
// service pin (postgres:16-alpine), applies every drizzle migration
// through the T1.1.1 programmatic migrator, and hands back { db, pool,
// url, stop } — never a mock, a real Postgres for every integration test
// that calls this.

const POSTGRES_IMAGE = 'postgres:16-alpine';
// A container serves exactly one test file's queries, sequentially — no
// horizontal-scaling concern here, unlike the real api pool. Still
// explicit rather than left to the pg driver default, same rule as
// T1.1.1's createDbClient.
const CONTAINER_POOL_MAX = 5;

export interface PgContainerHandle {
  readonly db: DbClient['db'];
  /** The raw `pg` Pool underneath `db` — T1.2.1's hand-written SQL
   * migration runner operates on this directly (BEGIN/COMMIT/ROLLBACK,
   * arbitrary multi-statement SQL), which is pg.Pool's native domain,
   * not drizzle's query-builder layer. */
  readonly pool: Pool;
  readonly url: string;
  /** Closes the db pool, then stops and removes the container. */
  stop(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Closes the db pool AND stops the container, unconditionally attempting
 * both even if the first fails — a plain `await closeDb(); await
 * container.stop();` sequence would leak the container whenever
 * `closeDb()` throws, since the second call would never run. If both
 * fail, both messages are reported (never just the first, silently
 * dropping the second).
 */
async function closeClientAndContainer(
  client: DbClient,
  container: StartedPostgreSqlContainer,
): Promise<void> {
  let closeError: unknown;
  try {
    await client.closeDb();
  } catch (error) {
    closeError = error;
  }

  let stopError: unknown;
  try {
    await container.stop();
  } catch (error) {
    stopError = error;
  }

  if (closeError && stopError) {
    throw new Error(
      `Failed to clean up the testcontainers Postgres: closeDb() failed with ` +
        `"${describeError(closeError)}", then container.stop() failed with ` +
        `"${describeError(stopError)}".`,
    );
  }
  if (closeError) throw closeError;
  if (stopError) throw stopError;
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

  try {
    await runDrizzleMigrations(client.db);
  } catch (error) {
    // The container booted successfully but migrations failed BEFORE any
    // handle (and its stop()) reached the caller — without this, the
    // container leaks, since nothing else in this function's caller ever
    // gets a chance to stop it. Cleanup here is best-effort (the
    // migration failure is the error that actually gets thrown; a
    // secondary cleanup failure would otherwise mask it).
    await closeClientAndContainer(client, container).catch(() => undefined);
    throw new Error(
      `Failed to run drizzle migrations against the testcontainers Postgres at ${url}: ` +
        describeError(error),
    );
  }

  return {
    db: client.db,
    pool: client.pool,
    url,
    stop: () => closeClientAndContainer(client, container),
  };
}
