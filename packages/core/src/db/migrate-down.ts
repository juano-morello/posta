import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { createDbClient } from './client';
import { downSqlMigration } from './sql-migrate';

// T1.5.3 — `pnpm migrate:down` reverts exactly one step, newest first,
// using the .down.sql pairs T1.2.6 created. This ONLY ever reads/writes
// _posta_sql_migrations — it never looks at, and never touches,
// drizzle.__drizzle_migrations. Drizzle-kit's own tooling (`pnpm
// --filter @posta/core db:migrate`'s underlying CLI has its own down
// story) owns drizzle rollbacks; the two flavors must never disagree
// about who applied — or reverted — what.
const DEFAULT_SQL_MIGRATIONS_DIR = path.join(__dirname, '../../migrations/sql');

export interface MigrateDownOptions {
  readonly sqlMigrationsDir?: string;
  readonly force?: boolean;
}

function downFilenameFor(filename: string): string {
  return filename.replace(/\.sql$/, '.down.sql');
}

/**
 * Not every applied sql migration has a `.down.sql` pair (003/004/005
 * don't — see the plan). "Newest first" means: walk backward from the
 * newest APPLIED migration and revert the first one that actually has a
 * pair on disk, rather than assuming the single newest migration is
 * always revertible.
 */
async function findNewestRevertibleMigration(
  pool: Pool,
  migrationsDir: string,
): Promise<string | undefined> {
  const tableExists = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_posta_sql_migrations'
    ) AS exists
  `);
  if (!tableExists.rows[0]?.exists) return undefined;

  const applied = await pool.query<{ filename: string }>(
    `SELECT filename FROM _posta_sql_migrations ORDER BY filename DESC`,
  );

  for (const row of applied.rows) {
    const downPath = path.join(migrationsDir, downFilenameFor(row.filename));
    if (existsSync(downPath)) return row.filename;
  }
  return undefined;
}

/**
 * Reverts the newest revertible hand-written SQL migration and returns
 * its filename. Throws if no applied sql migration has a `.down.sql`
 * pair (including the case where none have ever been applied at all).
 */
export async function migrateDown(pool: Pool, options: MigrateDownOptions = {}): Promise<string> {
  const migrationsDir = options.sqlMigrationsDir ?? DEFAULT_SQL_MIGRATIONS_DIR;
  const filename = await findNewestRevertibleMigration(pool, migrationsDir);

  if (!filename) {
    throw new Error(
      'migrateDown: nothing to revert — no applied hand-written SQL migration has a ' +
        '.down.sql pair on disk.',
    );
  }

  await downSqlMigration(pool, filename, {
    migrationsDir,
    ...(options.force !== undefined ? { force: options.force } : {}),
  });

  return filename;
}

// Exported so migrate-down.test.ts can exercise the real CLI entrypoint
// directly.
export async function main(): Promise<void> {
  const client = createDbClient();

  // Capture-both-combine-if-both-fail, same pattern as seed-asn.ts's
  // main() (S1.4 review) — a pool.end() failure must never replace a
  // real migrateDown() error.
  let downError: unknown;
  let reverted: string | undefined;
  try {
    reverted = await migrateDown(client.pool);
  } catch (error) {
    downError = error;
  }

  let closeError: unknown;
  try {
    await client.closeDb();
  } catch (error) {
    /* v8 ignore next -- pool.end() genuinely failing is impractical to
     * trigger in a real integration test; see migrate.ts's identical
     * annotation for the full reasoning (same deferred class of gap as
     * the S1.3 review's queue-cleanup double-failure branch). */
    closeError = error;
  }

  /* v8 ignore next 6 -- requires BOTH migrateDown() and closeDb() to
   * fail in the same run. */
  if (downError && closeError) {
    const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
    throw new Error(
      `migrate:down: failed with "${describe(downError)}", then closing the db pool also ` +
        `failed with "${describe(closeError)}".`,
    );
  }
  if (downError) throw downError;
  if (closeError) throw closeError;

  console.log(`migrate:down: reverted ${reverted}`);
}

// `require.main` is the test runner's own entry module under vitest,
// never this file — pure CLI-bootstrap wiring, same reasoning as
// migrate.ts's own guard.
/* v8 ignore start */
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('migrate:down: failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
/* v8 ignore stop */
