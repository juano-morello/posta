import path from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { runSqlMigrations } from './sql-migrate';

// T4.2.2 — posta_app (packages/core/migrations/sql/007_roles_reader.sql) is
// the REAL enforcement of invariant 5 ("query the view, never raw
// `events`") — T4.2.1's grep test is advisory (application source only);
// this suite proves the database itself refuses the raw table to that
// role, against a real testcontainers Postgres, never a mock.
//
// This file is deliberately scoped to T4.2.2 only (posta_app's own
// grant/no-grant shape). A later task (T4.2.3) extends this same suite —
// keep additions here, don't fork a second roles file.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');
const READER_ROLE = 'posta_app';
const INSUFFICIENT_PRIVILEGE = '42501';

interface HasPrivilegeRow {
  readonly has_privilege: boolean;
}

describe('posta_app reader role (T4.2.2)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('has NO SELECT privilege on the raw events table', async () => {
    const result = await handle.pool.query<HasPrivilegeRow>(
      `SELECT has_table_privilege('${READER_ROLE}', 'events', 'SELECT') AS has_privilege`,
    );

    expect(result.rows[0]?.has_privilege).toBe(false);
  });

  it('HAS SELECT privilege on events_classified', async () => {
    const result = await handle.pool.query<HasPrivilegeRow>(
      `SELECT has_table_privilege('${READER_ROLE}', 'events_classified', 'SELECT') AS has_privilege`,
    );

    expect(result.rows[0]?.has_privilege).toBe(true);
  });

  // A dedicated client (not handle.pool.query, which may hand back a
  // different pooled connection per call) so `SET ROLE` — a session-level
  // GUC — actually applies to the queries run against it below. Fresh
  // BEGIN/ROLLBACK per test (beforeEach/afterEach, not beforeAll/afterAll):
  // Postgres aborts the ENTIRE surrounding transaction the instant one
  // statement errors ("current transaction is aborted, commands ignored
  // until end of transaction block") — the 42501 test below deliberately
  // errors, so sharing one transaction across tests would poison every
  // later query in it. Postgres treats a plain (non-LOCAL) SET as
  // transactional when issued inside an explicit transaction block, so
  // each test's own ROLLBACK reverts the session back to its original
  // (superuser) role before the client is released back to the pool.
  describe('querying as posta_app (SET ROLE within a transaction)', () => {
    let client: PoolClient;

    beforeEach(async () => {
      client = await handle.pool.connect();
      await client.query('BEGIN');
      await client.query(`SET ROLE ${READER_ROLE}`);
    });

    afterEach(async () => {
      await client.query('ROLLBACK');
      client.release();
    });

    it('SELECT * FROM events throws SQLSTATE 42501 (insufficient_privilege)', async () => {
      await expect(client.query('SELECT * FROM events LIMIT 1')).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    });

    it('SELECT * FROM events_classified succeeds (zero rows is fine)', async () => {
      const result = await client.query('SELECT * FROM events_classified LIMIT 1');

      expect(result.rows).toEqual([]);
    });
  });
});
