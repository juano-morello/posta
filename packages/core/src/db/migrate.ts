import path from 'node:path';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { createDbClient, runDrizzleMigrations } from './client';
import { runSqlMigrations } from './sql-migrate';

// T1.5.1 — the single entrypoint (`pnpm migrate`) for BOTH migration
// flavors. The order is fixed and asserted (migrate.test.ts), not
// incidental: 005_bootstrap_partitions.sql calls the function
// 003_partition_fn.sql creates, and a future SQL migration (E4's
// events_classified view) will depend on asn_datacenter, which drizzle
// owns — so drizzle-kit's migrations must always apply first.
const DEFAULT_SQL_MIGRATIONS_DIR = path.join(__dirname, '../../migrations/sql');

export interface MigrateOptions {
  readonly drizzleMigrationsFolder?: string;
  readonly sqlMigrationsDir?: string;
}

export async function migrate(
  pool: Pool,
  db: NodePgDatabase,
  options: MigrateOptions = {},
): Promise<void> {
  await runDrizzleMigrations(db, options.drizzleMigrationsFolder);
  await runSqlMigrations(pool, {
    migrationsDir: options.sqlMigrationsDir ?? DEFAULT_SQL_MIGRATIONS_DIR,
  });
}

// Exported so migrate.test.ts can exercise the real CLI entrypoint (env
// var driven createDbClient() + the capture-both-combine cleanup logic)
// directly, not just the underlying migrate() function — the whole
// reason coverage of this function matters is that error-handling
// logic, which migrate() alone never touches.
export async function main(): Promise<void> {
  const client = createDbClient();

  // [S1.5 review, silent-failure-hunter CRITICAL] A plain `finally {
  // await client.closeDb(); }` would let a closeDb() failure REPLACE a
  // real migrate() error if both throw — the same class of bug already
  // fixed in pg-container.ts's closeClientAndContainer(), seed-asn.ts's
  // main(), migrate-down.ts's main(), and seed.ts's main(). Capture
  // both, combine if both fail, never silently drop the primary error.
  let migrateError: unknown;
  try {
    await migrate(client.pool, client.db);
  } catch (error) {
    migrateError = error;
  }

  let closeError: unknown;
  try {
    await client.closeDb();
  } catch (error) {
    /* v8 ignore next -- pool.end() genuinely failing (not just the
     * connection never establishing) is impractical to trigger in a
     * real integration test without mocking; same class of deferred
     * gap as the S1.3 review's queue-cleanup double-failure branch. */
    closeError = error;
  }

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  /* v8 ignore next 5 -- requires BOTH migrate() and closeDb() to fail
   * in the same run; see the closeError branch above for why that
   * combination is impractical to construct for real. */
  if (migrateError && closeError) {
    throw new Error(
      `migrate: failed with "${describe(migrateError)}", then closing the db pool also failed ` +
        `with "${describe(closeError)}".`,
    );
  }
  if (migrateError) throw migrateError;
  if (closeError) throw closeError;

  console.log('migrate: applied every pending drizzle and sql migration');
}

// Only run main() when executed directly (`node dist/db/migrate.js` /
// `pnpm migrate`), not when imported by migrate.test.ts or migrate-
// status.ts (T1.5.2) reusing MigrateOptions/DEFAULT_SQL_MIGRATIONS_DIR's
// sibling helpers. `require.main` is the test runner's own entry module
// under vitest, never this file — this guard can never be true in a
// test process, so it is pure CLI-bootstrap wiring (the same class of
// thing vitest.config.ts's coverage already excludes for apps/*/src/
// main.ts) rather than testable logic; main() itself is fully covered
// above.
/* v8 ignore start */
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('migrate: failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
/* v8 ignore stop */
