import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

// T1.2.1 — drizzle-kit cannot emit `PARTITION BY` (S1.2's events table
// needs it), so this is a SEPARATE, hand-written SQL migration runner —
// entirely independent of drizzle-kit's own migration machinery
// (packages/core/src/db/client.ts's runDrizzleMigrations). Reads
// `migrationsDir`/NNN_name.sql in filename order, applies each inside its
// own transaction, and tracks (filename, checksum, applied_at) in
// `_posta_sql_migrations`. Re-running is a no-op (matching checksum);
// editing an already-applied file is drift, and a checksum mismatch is a
// hard error naming the file — never a silent skip, and never a silent
// re-apply.

const TRACKING_TABLE = '_posta_sql_migrations';

export interface SqlMigrateOptions {
  readonly migrationsDir: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checksumOf(sqlContent: string): string {
  return createHash('sha256').update(sqlContent).digest('hex');
}

/**
 * Migration files only — `.sql`, never `.down.sql` (T1.2.6's rollback
 * pairs live in the same directory, and must never be picked up here as
 * if they were forward migrations). Sorted lexicographically, which is
 * exactly filename order for the `NNN_name.sql` numbering convention.
 */
function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
}

async function ensureTrackingTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies every migration file in `options.migrationsDir` that has not
 * already been applied (by filename), inside its own transaction. A file
 * whose checksum no longer matches what was recorded when it was applied
 * throws immediately, naming the file — this is the enforcement
 * mechanism for "an edited applied migration is drift": there is no path
 * that silently re-applies it or silently ignores the edit.
 */
export async function runSqlMigrations(pool: Pool, options: SqlMigrateOptions): Promise<void> {
  await ensureTrackingTable(pool);

  const files = listMigrationFiles(options.migrationsDir);

  for (const filename of files) {
    const fullPath = path.join(options.migrationsDir, filename);
    const content = readFileSync(fullPath, 'utf8');
    const checksum = checksumOf(content);

    const existing = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM ${TRACKING_TABLE} WHERE filename = $1`,
      [filename],
    );

    const appliedRow = existing.rows[0];
    if (appliedRow) {
      if (appliedRow.checksum !== checksum) {
        throw new Error(
          `Migration "${filename}" has already been applied, but its content has changed ` +
            `since then (checksum mismatch). An applied migration must never be edited — add ` +
            `a NEW migration file instead.`,
        );
      }
      continue; // already applied, matching checksum — no-op
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(content);
      await client.query(
        `INSERT INTO ${TRACKING_TABLE} (filename, checksum) VALUES ($1, $2)`,
        [filename, checksum],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to apply migration "${filename}": ${describeError(error)}`);
    } finally {
      client.release();
    }
  }
}
