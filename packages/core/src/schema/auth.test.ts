import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T1.1.4 — Better Auth's Postgres adapter expects specific tables and
// columns; this test migrates a REAL testcontainers Postgres (never a
// mock) and reads the tables back from information_schema, so "this test
// passes" and "Better Auth's adapter would find what it needs in E5" stay
// the same claim.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

interface ColumnRow extends Record<string, unknown> {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: 'YES' | 'NO';
}

async function columnsOf(handle: PgContainerHandle, tableName: string): Promise<ColumnRow[]> {
  const result = await handle.db.execute<ColumnRow>(sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
    ORDER BY ordinal_position
  `);
  return result.rows;
}

describe('auth schema (T1.1.4)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('migrates the four Better Auth tables: user, session, account, verification', async () => {
    const result = await handle.db.execute<{ table_name: string }>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('user', 'session', 'account', 'verification')
    `);

    const tableNames = result.rows.map((row) => row.table_name).sort();
    expect(tableNames).toEqual(['account', 'session', 'user', 'verification']);
  });

  it('user table has Better Auth\'s required columns', async () => {
    const columnNames = (await columnsOf(handle, 'user')).map((row) => row.column_name);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'email',
        'email_verified',
        'image',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('user.created_at is timestamp with time zone, never naive', async () => {
    const columns = await columnsOf(handle, 'user');
    const createdAt = columns.find((row) => row.column_name === 'created_at');

    expect(createdAt?.data_type).toBe('timestamp with time zone');
  });

  it('every timestamp column across all four tables is timezone-aware', async () => {
    const tableNames = ['user', 'session', 'account', 'verification'];

    for (const tableName of tableNames) {
      const columns = await columnsOf(handle, tableName);
      const timestampColumns = columns.filter((row) => row.data_type.startsWith('timestamp'));

      expect(timestampColumns.length).toBeGreaterThan(0);
      for (const column of timestampColumns) {
        expect(column.data_type).toBe('timestamp with time zone');
      }
    }
  });

  it('session table has Better Auth\'s required columns, including the user_id FK', async () => {
    const columnNames = (await columnsOf(handle, 'session')).map((row) => row.column_name);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id',
        'expires_at',
        'token',
        'ip_address',
        'user_agent',
        'user_id',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('account table has Better Auth\'s required columns, including provider fields', async () => {
    const columnNames = (await columnsOf(handle, 'account')).map((row) => row.column_name);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id',
        'account_id',
        'provider_id',
        'user_id',
        'access_token',
        'refresh_token',
        'id_token',
        'access_token_expires_at',
        'refresh_token_expires_at',
        'scope',
        'password',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('verification table has Better Auth\'s required columns', async () => {
    const columnNames = (await columnsOf(handle, 'verification')).map((row) => row.column_name);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        'id',
        'identifier',
        'value',
        'expires_at',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('session and account both cascade-delete when their user is deleted', async () => {
    const result = await handle.db.execute<{
      table_name: string;
      delete_rule: string;
    }>(sql`
      SELECT tc.table_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_name IN ('session', 'account') AND tc.constraint_type = 'FOREIGN KEY'
    `);

    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.delete_rule).toBe('CASCADE');
    }
  });
});
