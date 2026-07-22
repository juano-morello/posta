import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { events } from './events';

// T1.2.4 — a Drizzle pgTable mirroring the hand-written DDL (T1.2.2),
// exported as EventRow (read) and NewEvent (the worker's batch insert
// shape) so app code is typed without drizzle-kit owning the DDL. The
// file is excluded from drizzle.config.ts's schema glob so drizzle-kit
// never emits DDL for `events` and never tries to "fix" the partitioning
// away.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');
const CORE_DIR = path.join(__dirname, '..', '..');
const DRIZZLE_MIGRATIONS_DIR = path.join(CORE_DIR, 'migrations', 'drizzle');

describe('events Drizzle typing (T1.2.4)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('the Drizzle column set is identical to information_schema.columns for events (both directions)', async () => {
    const drizzleColumnNames = Object.values(getTableColumns(events))
      .map((column) => column.name)
      .sort();

    const result = await handle.pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'events'
    `);
    const dbColumnNames = result.rows.map((row) => row.column_name).sort();

    // Two separate assertions (rather than one toEqual on the whole sets)
    // so a drift in either direction names the actual offending column(s)
    // in the failure message, not just "arrays differ".
    const inDrizzleNotDb = drizzleColumnNames.filter((name) => !dbColumnNames.includes(name));
    const inDbNotDrizzle = dbColumnNames.filter((name) => !drizzleColumnNames.includes(name));

    expect(inDrizzleNotDb).toEqual([]);
    expect(inDbNotDrizzle).toEqual([]);
  });
});

describe('drizzle-kit generate (T1.2.4)', () => {
  it(
    'emits no new migration file for events.ts — it is excluded from the schema glob',
    () => {
      const before = readdirSync(DRIZZLE_MIGRATIONS_DIR).sort();

      execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate'], {
        cwd: CORE_DIR,
        env: { ...process.env, DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' },
        stdio: 'pipe',
      });

      const after = readdirSync(DRIZZLE_MIGRATIONS_DIR).sort();
      expect(after).toEqual(before);
    },
    30_000,
  );
});
