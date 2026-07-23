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

async function main(): Promise<void> {
  const client = createDbClient();
  try {
    await migrate(client.pool, client.db);
    console.log('migrate: applied every pending drizzle and sql migration');
  } finally {
    await client.closeDb();
  }
}

// Only run main() when executed directly (`node dist/db/migrate.js` /
// `pnpm migrate`), not when imported by migrate.test.ts or migrate-
// status.ts (T1.5.2) reusing MigrateOptions/DEFAULT_SQL_MIGRATIONS_DIR's
// sibling helpers.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('migrate: failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
