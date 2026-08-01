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
// T4.2.3 extends this same suite with posta_worker
// (packages/core/migrations/sql/008_roles_writer.sql) — the mirror-image
// role: INSERT + SELECT on raw `events` (the batch flush and replay's
// reconciliation row-count), nothing on the CRUD tables or the
// classified view. Both roles share one file/one container on purpose —
// a regression in one role's grants (e.g. posta_app accidentally gaining
// INSERT on `events`) is exactly the kind of thing that should fail here,
// next to the role it would silently widen past.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');
const READER_ROLE = 'posta_app';
const WRITER_ROLE = 'posta_worker';
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

    // T4.2.3 regression check — 008_roles_writer.sql grants posta_worker
    // INSERT on `events`; this proves that grant landed on posta_worker
    // only and did not somehow widen posta_app's own grants alongside it.
    it('INSERT INTO events throws SQLSTATE 42501 (insufficient_privilege) — regression check (T4.2.3)', async () => {
      await expect(
        client.query(
          `INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
           VALUES ($1, now(), $2, $3, $4)`,
          ['evt-reader-regression-t423', 'tenant-reader-regression', 'link-reader-regression', 'slug-reader-regression'],
        ),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });
});

// T4.2.3 — posta_worker (packages/core/migrations/sql/008_roles_writer.sql):
// the mirror-image role to posta_app above. INSERT + SELECT on raw
// `events` (the batch flush and replay's reconciliation row-count), NO
// grant on any CRUD table — the worker has no business touching `links`
// et al. Own container/describe block, same reasoning as the reader
// suite above: each role gets its own fully-migrated database rather than
// sharing state across describe blocks.
describe('posta_worker writer role (T4.2.3)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('HAS INSERT privilege on the raw events table', async () => {
    const result = await handle.pool.query<HasPrivilegeRow>(
      `SELECT has_table_privilege('${WRITER_ROLE}', 'events', 'INSERT') AS has_privilege`,
    );

    expect(result.rows[0]?.has_privilege).toBe(true);
  });

  it('has NO UPDATE privilege on links (CRUD tables are off-limits)', async () => {
    const result = await handle.pool.query<HasPrivilegeRow>(
      `SELECT has_table_privilege('${WRITER_ROLE}', 'links', 'UPDATE') AS has_privilege`,
    );

    expect(result.rows[0]?.has_privilege).toBe(false);
  });

  // Same dedicated-client-plus-per-test-transaction reasoning as the
  // posta_app block above: SET ROLE is session-level, and the UPDATE
  // test below deliberately errors, which would otherwise poison a
  // shared transaction for every later query in it.
  describe('querying as posta_worker (SET ROLE within a transaction)', () => {
    let client: PoolClient;

    beforeEach(async () => {
      client = await handle.pool.connect();
      await client.query('BEGIN');
      await client.query(`SET ROLE ${WRITER_ROLE}`);
    });

    afterEach(async () => {
      await client.query('ROLLBACK');
      client.release();
    });

    it('INSERT INTO events succeeds', async () => {
      await client.query(
        `INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
         VALUES ($1, now(), $2, $3, $4)`,
        ['evt-writer-role-t423', 'tenant-writer-role', 'link-writer-role', 'slug-writer-role'],
      );

      const result = await client.query('SELECT event_id FROM events WHERE event_id = $1', [
        'evt-writer-role-t423',
      ]);
      expect(result.rows).toEqual([{ event_id: 'evt-writer-role-t423' }]);
    });

    it('UPDATE links throws SQLSTATE 42501 (insufficient_privilege)', async () => {
      await expect(
        client.query(`UPDATE links SET slug = 'nope' WHERE id = 'nonexistent'`),
      ).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    });
  });
});
