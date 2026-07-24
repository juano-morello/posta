import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { runSqlMigrations } from './sql-migrate';

// T1.2.1 — drizzle-kit cannot emit `PARTITION BY`, so the events table
// (S1.2) is a hand-written SQL migration instead. This runner reads
// packages/core/migrations/sql/NNN_name.sql in filename order, applies
// each inside its own transaction, and tracks (filename, checksum,
// applied_at) in _posta_sql_migrations — re-running is a no-op, and an
// edited already-applied file is drift the checksum catches loudly
// rather than silently re-applying or silently skipping.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

describe('runSqlMigrations (T1.2.1)', () => {
  let handle: PgContainerHandle;
  let migrationsDir: string;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  beforeEach(() => {
    migrationsDir = mkdtempSync(path.join(tmpdir(), 'posta-sql-migrate-'));
  });

  afterEach(() => {
    rmSync(migrationsDir, { recursive: true, force: true });
  });

  it('running the same migration file twice leaves exactly one tracking row', async () => {
    writeFileSync(
      path.join(migrationsDir, '001_widgets_a.sql'),
      'CREATE TABLE widgets_t121_a (id text primary key);',
    );

    await runSqlMigrations(handle.pool, { migrationsDir });
    await runSqlMigrations(handle.pool, { migrationsDir });

    const result = await handle.pool.query(
      'SELECT filename FROM _posta_sql_migrations WHERE filename = $1',
      ['001_widgets_a.sql'],
    );
    expect(result.rows).toHaveLength(1);
  });

  it('records (filename, checksum, applied_at) for each applied file', async () => {
    writeFileSync(
      path.join(migrationsDir, '001_widgets_b.sql'),
      'CREATE TABLE widgets_t121_b (id text primary key);',
    );

    await runSqlMigrations(handle.pool, { migrationsDir });

    const result = await handle.pool.query<{
      filename: string;
      checksum: string;
      applied_at: Date;
    }>('SELECT filename, checksum, applied_at FROM _posta_sql_migrations WHERE filename = $1', [
      '001_widgets_b.sql',
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.filename).toBe('001_widgets_b.sql');
    expect(result.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(result.rows[0]?.applied_at).toBeInstanceOf(Date);
  });

  it('a mid-file syntax error rolls the whole file back and records no tracking row', async () => {
    writeFileSync(
      path.join(migrationsDir, '001_broken.sql'),
      'CREATE TABLE widgets_t121_c (id text primary key); THIS IS NOT VALID SQL AT ALL;',
    );

    await expect(runSqlMigrations(handle.pool, { migrationsDir })).rejects.toThrow(
      /001_broken\.sql/,
    );

    const tableCheck = await handle.pool.query<{ exists: string | null }>(
      `SELECT to_regclass('widgets_t121_c')::text AS exists`,
    );
    expect(tableCheck.rows[0]?.exists).toBeNull();

    const trackingCheck = await handle.pool.query(
      'SELECT filename FROM _posta_sql_migrations WHERE filename = $1',
      ['001_broken.sql'],
    );
    expect(trackingCheck.rows).toHaveLength(0);
  });

  it('editing an already-applied migration throws, naming the file', async () => {
    const filePath = path.join(migrationsDir, '001_edit_me.sql');
    writeFileSync(filePath, 'CREATE TABLE widgets_t121_d (id text primary key);');

    await runSqlMigrations(handle.pool, { migrationsDir });

    writeFileSync(filePath, 'CREATE TABLE widgets_t121_d (id text primary key, extra text);');

    await expect(runSqlMigrations(handle.pool, { migrationsDir })).rejects.toThrow(
      /001_edit_me\.sql/,
    );
  });

  it('applies multiple files in filename order', async () => {
    writeFileSync(
      path.join(migrationsDir, '002_second.sql'),
      'CREATE TABLE widgets_t121_second (id text primary key);',
    );
    writeFileSync(
      path.join(migrationsDir, '001_first.sql'),
      'CREATE TABLE widgets_t121_first (id text primary key);',
    );

    await runSqlMigrations(handle.pool, { migrationsDir });

    const result = await handle.pool.query<{ filename: string }>(
      `SELECT filename FROM _posta_sql_migrations WHERE filename IN ($1, $2) ORDER BY filename`,
      ['001_first.sql', '002_second.sql'],
    );
    expect(result.rows.map((row) => row.filename)).toEqual(['001_first.sql', '002_second.sql']);
  });
});
