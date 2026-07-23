import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { createDbClient } from './client';

// T1.5.2 — `pnpm migrate:status` reports BOTH migration flavors in one
// table: filename, flavor ('drizzle' | 'sql'), and applied_at (or
// 'PENDING' for a file on disk with no tracking row). Designed to be
// used as a CI gate directly (hasPendingMigrations(), T1.5.4), not by
// parsing printed output.

const DEFAULT_DRIZZLE_MIGRATIONS_DIR = path.join(__dirname, '../../migrations/drizzle');
const DEFAULT_SQL_MIGRATIONS_DIR = path.join(__dirname, '../../migrations/sql');

export interface MigrateStatusOptions {
  readonly drizzleMigrationsDir?: string;
  readonly sqlMigrationsDir?: string;
}

export type MigrationFlavor = 'drizzle' | 'sql';

export interface MigrationStatusRow {
  readonly filename: string;
  readonly flavor: MigrationFlavor;
  readonly appliedAt: string | 'PENDING';
}

interface DrizzleJournalEntry {
  readonly tag: string;
  readonly when: number;
}

interface DrizzleJournal {
  readonly entries: readonly DrizzleJournalEntry[];
}

/**
 * Drizzle's own migrator tracks applied migrations by content HASH in
 * `drizzle.__drizzle_migrations(id, hash, created_at)` — no filename at
 * all. The journal drizzle-kit writes alongside the migrations
 * (`meta/_journal.json`) is what maps a filename ("<tag>.sql") back to
 * the `created_at` (its own `when`, in epoch ms) it would have if
 * applied — so a journal entry is "applied" exactly when some tracking
 * row's `created_at` equals its `when`.
 */
async function drizzleFlavorRows(pool: Pool, migrationsDir: string): Promise<MigrationStatusRow[]> {
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as DrizzleJournal;

  const tableExists = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
    ) AS exists
  `);
  const appliedAtByWhen = new Map<number, string>();
  if (tableExists.rows[0]?.exists) {
    const applied = await pool.query<{ created_at: string }>(
      `SELECT created_at::text AS created_at FROM drizzle.__drizzle_migrations`,
    );
    for (const row of applied.rows) {
      appliedAtByWhen.set(Number(row.created_at), new Date(Number(row.created_at)).toISOString());
    }
  }

  return journal.entries.map((entry) => ({
    filename: `${entry.tag}.sql`,
    flavor: 'drizzle' as const,
    appliedAt: appliedAtByWhen.get(entry.when) ?? 'PENDING',
  }));
}

/**
 * The hand-written SQL flavor tracks applied migrations by FILENAME
 * directly, in `_posta_sql_migrations` (sql-migrate.ts) — much simpler
 * to correlate than drizzle's hash-based tracking.
 */
async function sqlFlavorRows(pool: Pool, migrationsDir: string): Promise<MigrationStatusRow[]> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();

  const tableExists = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_posta_sql_migrations'
    ) AS exists
  `);
  const appliedAtByFilename = new Map<string, string>();
  if (tableExists.rows[0]?.exists) {
    const applied = await pool.query<{ filename: string; applied_at: string }>(
      `SELECT filename, applied_at::text AS applied_at FROM _posta_sql_migrations`,
    );
    for (const row of applied.rows) {
      appliedAtByFilename.set(row.filename, row.applied_at);
    }
  }

  return files.map((filename) => ({
    filename,
    flavor: 'sql' as const,
    appliedAt: appliedAtByFilename.get(filename) ?? 'PENDING',
  }));
}

/**
 * The fixed run order (T1.5.1: drizzle, then sql) is reflected here too —
 * drizzle rows always precede sql rows, matching the order they are
 * actually applied in.
 */
export async function getMigrationStatus(
  pool: Pool,
  options: MigrateStatusOptions = {},
): Promise<MigrationStatusRow[]> {
  const drizzleRows = await drizzleFlavorRows(
    pool,
    options.drizzleMigrationsDir ?? DEFAULT_DRIZZLE_MIGRATIONS_DIR,
  );
  const sqlRows = await sqlFlavorRows(pool, options.sqlMigrationsDir ?? DEFAULT_SQL_MIGRATIONS_DIR);
  return [...drizzleRows, ...sqlRows];
}

export function hasPendingMigrations(rows: readonly MigrationStatusRow[]): boolean {
  return rows.some((row) => row.appliedAt === 'PENDING');
}

function printStatusTable(rows: readonly MigrationStatusRow[]): void {
  console.table(
    rows.map((row) => ({ filename: row.filename, flavor: row.flavor, applied_at: row.appliedAt })),
  );
}

async function main(): Promise<void> {
  const client = createDbClient();
  try {
    const rows = await getMigrationStatus(client.pool);
    printStatusTable(rows);
    process.exitCode = hasPendingMigrations(rows) ? 1 : 0;
  } finally {
    await client.closeDb();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('migrate:status: failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
