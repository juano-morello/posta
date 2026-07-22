import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T1.2.2 — drizzle-kit cannot emit `PARTITION BY`, so `events` is a
// hand-written SQL migration (packages/core/migrations/sql/001_events.sql),
// applied through T1.2.1's runSqlMigrations. This test verifies the REAL
// migrated schema against a testcontainers Postgres — never a mock —
// reading back Postgres's own catalog (pg_class, pg_get_partkeydef,
// pg_index, information_schema.columns).
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

// The exact column list from spec §8 (docs/superpowers/specs/
// 2026-07-21-posta-design.md) — capture signals nullable (absence of a
// header is itself signal), enrichment nullable (written by the worker,
// not at capture). Deliberately NO ip/classification column — see
// events-forbidden-columns.test.ts (T1.2.5) for the enforcement.
const EXPECTED_COLUMNS = [
  'event_id',
  'occurred_at',
  'tenant_id',
  'link_id',
  'slug',
  'visitor_hash',
  'http_method',
  'user_agent',
  'referer',
  'accept',
  'accept_language',
  'sec_fetch_site',
  'sec_fetch_mode',
  'sec_fetch_dest',
  'sec_fetch_user',
  'sec_purpose',
  'sec_ch_ua',
  'sec_ch_ua_mobile',
  'sec_ch_ua_platform',
  'purpose',
  'x_purpose',
  'x_moz',
  'country',
  'asn',
  'browser',
  'browser_version',
  'os',
  'device_type',
  'source_platform',
  'is_in_app',
  'dest_host',
].sort();

describe('events table schema (T1.2.2)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('is a partitioned table (pg_class.relkind = "p")', async () => {
    const result = await handle.pool.query<{ relkind: string }>(
      `SELECT relkind FROM pg_class WHERE relname = 'events'`,
    );
    expect(result.rows[0]?.relkind).toBe('p');
  });

  it('partitions by RANGE (occurred_at)', async () => {
    const result = await handle.pool.query<{ partkeydef: string }>(
      `SELECT pg_get_partkeydef('events'::regclass) AS partkeydef`,
    );
    expect(result.rows[0]?.partkeydef).toBe('RANGE (occurred_at)');
  });

  it('has PRIMARY KEY (event_id, occurred_at) — the partition key is included, exactly what ON CONFLICT needs [INV-8]', async () => {
    const result = await handle.pool.query<{ column_name: string }>(`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'events'::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `);
    expect(result.rows.map((row) => row.column_name)).toEqual(['event_id', 'occurred_at']);
  });

  it('occurred_at is timestamptz, never naive', async () => {
    const result = await handle.pool.query<{ data_type: string }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'occurred_at'
    `);
    expect(result.rows[0]?.data_type).toBe('timestamp with time zone');
  });

  it('event_id, occurred_at, tenant_id, link_id, and slug are NOT NULL', async () => {
    const result = await handle.pool.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'events'
        AND column_name IN ('event_id', 'occurred_at', 'tenant_id', 'link_id', 'slug')
    `);
    expect(result.rows).toHaveLength(5);
    for (const row of result.rows) {
      expect(row.is_nullable).toBe('NO');
    }
  });

  it('every capture-signal and enrichment column is nullable', async () => {
    const nullableColumnNames = EXPECTED_COLUMNS.filter(
      (name) => !['event_id', 'occurred_at', 'tenant_id', 'link_id', 'slug'].includes(name),
    );
    const result = await handle.pool.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = ANY($1)
    `, [nullableColumnNames]);

    expect(result.rows).toHaveLength(nullableColumnNames.length);
    for (const row of result.rows) {
      expect(row.is_nullable).toBe('YES');
    }
  });

  it('the full column set equals the spec §8 list', async () => {
    const result = await handle.pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'events'
    `);
    const actualColumns = result.rows.map((row) => row.column_name).sort();
    expect(actualColumns).toEqual(EXPECTED_COLUMNS);
  });
});
