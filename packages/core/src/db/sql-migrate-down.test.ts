import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { downSqlMigration, runSqlMigrations } from './sql-migrate';

// T1.2.6 — rollback support for hand-written SQL migrations. Dropping
// `events` drops its partitions, so 001_events.down.sql refuses to run
// when the table has rows unless `--force` — an accidental rollback in
// staging should be loud, not clean.
//
// T4.1.1 added 006_events_classified.sql, a VIEW over `events` — Postgres
// refuses `DROP TABLE events` while any view still references it, so
// every down sequence below must revert 006 before 002/001, newest first
// (same ordering `migrateDown`'s own "newest revertible" walk uses).
//
// T4.2.2 added 007_roles_reader.sql (posta_app, GRANT SELECT on
// events_classified only) — its down.sql revokes and DROP ROLEs, no
// table/view of its own, so its down/re-up cycle runs right after the
// FIRST test below (still against beforeAll's pristine, untouched
// migration state), deliberately BEFORE the 001/002/006 down/up cycle
// two tests later. That ordering is load-bearing, not arbitrary: once
// 006_events_classified.sql itself gets downed-then-reapplied, the view
// is dropped and recreated as a brand-new object (new OID) while 007's
// OWN tracking row is never touched by that cycle — runSqlMigrations
// then sees 007 as "already applied" (matching checksum) and skips
// re-running its GRANT, leaving the freshly-recreated view with NO
// privilege for posta_app at all. That is a real, separate gap (the same
// class the force-true test below already documents for
// 004_default_partition.sql/events), not something this test masks by
// running before it corrupts the state. [security review, T4.2.2 batch]
// roles.test.ts only ever exercised 007's forward grant shape — this is
// what actually exercises its down.sql, so a future edit to the GRANT
// list that forgets to mirror the matching REVOKE fails here.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');
const EVENTS_MIGRATIONS = [
  '001_events.sql',
  '002_events_indexes.sql',
  '006_events_classified.sql',
] as const;

describe('sql-migrate down (T1.2.6)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    // 004_default_partition.sql (T1.3.2) is now part of MIGRATIONS_DIR,
    // so this already creates the real events_default partition — no
    // custom one needed here (a second DEFAULT partition on the same
    // parent is a Postgres error: "conflicts with existing default
    // partition").
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('down refuses to run when events has rows', async () => {
    await handle.pool.query(`
      INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
      VALUES ('01T126EVENT00000000000000', now(), 'tenant-x', 'link-x', 'slug-x')
    `);

    await expect(
      downSqlMigration(handle.pool, '001_events.sql', { migrationsDir: MIGRATIONS_DIR }),
    ).rejects.toThrow(/refus/i);

    // The migration must NOT have been rolled back — its tracking row is
    // still there.
    const tracking = await handle.pool.query(
      'SELECT filename FROM _posta_sql_migrations WHERE filename = $1',
      ['001_events.sql'],
    );
    expect(tracking.rows).toHaveLength(1);

    const tableCheck = await handle.pool.query(`SELECT to_regclass('events')::text AS exists`);
    expect(tableCheck.rows[0]?.exists).toBe('events');
  });

  it('down removes posta_app (T4.2.2) — a fresh re-apply restores its grants exactly', async () => {
    const beforeDown = await handle.pool.query<{ has_privilege: boolean }>(
      `SELECT has_table_privilege('posta_app', 'events_classified', 'SELECT') AS has_privilege`,
    );
    expect(beforeDown.rows[0]?.has_privilege).toBe(true);

    await downSqlMigration(handle.pool, '007_roles_reader.sql', { migrationsDir: MIGRATIONS_DIR });

    // The role itself must be gone, not just stripped of privileges —
    // 007_roles_reader.down.sql REVOKEs before DROP ROLE precisely
    // because DROP ROLE fails outright while any grant to it survives.
    const roleAfterDown = await handle.pool.query(
      `SELECT 1 FROM pg_roles WHERE rolname = 'posta_app'`,
    );
    expect(roleAfterDown.rows).toEqual([]);

    const tracking = await handle.pool.query(
      'SELECT filename FROM _posta_sql_migrations WHERE filename = $1',
      ['007_roles_reader.sql'],
    );
    expect(tracking.rows).toEqual([]);

    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    const roleAfterReapply = await handle.pool.query<{ has_privilege: boolean }>(
      `SELECT has_table_privilege('posta_app', 'events_classified', 'SELECT') AS has_privilege`,
    );
    expect(roleAfterReapply.rows[0]?.has_privilege).toBe(true);

    // Re-applying must never leave posta_app with a grant on raw `events`
    // — the entire point of T4.2.2 — even after a down/up round trip.
    const noEventsPrivilege = await handle.pool.query<{ has_privilege: boolean }>(
      `SELECT has_table_privilege('posta_app', 'events', 'SELECT') AS has_privilege`,
    );
    expect(noEventsPrivilege.rows[0]?.has_privilege).toBe(false);
  });

  it('down succeeds and removes the tracking row once the table is empty', async () => {
    await handle.pool.query('TRUNCATE events');

    // Reverse order: events_classified (T4.1.1) first — Postgres refuses
    // `DROP TABLE events` while its view still references it — then the
    // indexes migration, then the table itself — down() is called
    // per-file, not implicitly cascading (even though DROP TABLE would
    // take the indexes with it regardless).
    await downSqlMigration(handle.pool, '006_events_classified.sql', { migrationsDir: MIGRATIONS_DIR });
    await downSqlMigration(handle.pool, '002_events_indexes.sql', { migrationsDir: MIGRATIONS_DIR });
    await downSqlMigration(handle.pool, '001_events.sql', { migrationsDir: MIGRATIONS_DIR });

    const tracking = await handle.pool.query(
      'SELECT filename FROM _posta_sql_migrations WHERE filename = ANY($1)',
      [EVENTS_MIGRATIONS],
    );
    expect(tracking.rows).toEqual([]);

    const tableCheck = await handle.pool.query(`SELECT to_regclass('events')::text AS exists`);
    expect(tableCheck.rows[0]?.exists).toBeNull();
  });

  it('migrating up again produces a green schema', async () => {
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    const relkindResult = await handle.pool.query<{ relkind: string }>(
      `SELECT relkind FROM pg_class WHERE relname = 'events'`,
    );
    expect(relkindResult.rows[0]?.relkind).toBe('p');

    const indexResult = await handle.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_indexes
      WHERE tablename = 'events'
        AND indexname IN ('events_tenant_link_occurred_at_idx', 'events_tenant_occurred_at_idx')
    `);
    expect(indexResult.rows[0]?.count).toBe('2');

    const tracking = await handle.pool.query(
      'SELECT filename FROM _posta_sql_migrations WHERE filename = ANY($1) ORDER BY filename',
      [EVENTS_MIGRATIONS],
    );
    expect(tracking.rows.map((row) => row.filename)).toEqual([...EVENTS_MIGRATIONS]);
  });

  it('down succeeds despite rows present when force: true is passed — the escape hatch, used deliberately', async () => {
    // The previous test's down('001_events.sql') dropped the whole
    // `events` table, which CASCADE-dropped events_default (T1.3.2) along
    // with it. That migration's OWN tracking row was never touched (only
    // 001/002/006 were rolled back), so runSqlMigrations' re-migrate in
    // the previous test treated 004_default_partition.sql as
    // already-applied (matching checksum) and skipped it — the table was
    // recreated with no partitions at all. A fresh one is needed before
    // another INSERT can land anywhere. (This mismatch between "004 is
    // tracked as applied" and "its physical table doesn't exist" is a
    // known gap in rolling back a migration whose dependents were never
    // themselves rolled back first — out of scope for T1.2.6, which only
    // exercises 001/002's own up/down cycle.)
    await handle.pool.query(`CREATE TABLE events_t126_default_2 PARTITION OF events DEFAULT`);
    await handle.pool.query(`
      INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
      VALUES ('01T126EVENT00000000000001', now(), 'tenant-y', 'link-y', 'slug-y')
    `);

    // events_classified (T4.1.1) must come down before the table again —
    // the previous test's re-migrate recreated it alongside 001/002.
    await downSqlMigration(handle.pool, '006_events_classified.sql', { migrationsDir: MIGRATIONS_DIR });
    await downSqlMigration(handle.pool, '002_events_indexes.sql', { migrationsDir: MIGRATIONS_DIR });
    await downSqlMigration(handle.pool, '001_events.sql', {
      migrationsDir: MIGRATIONS_DIR,
      force: true,
    });

    const tableCheck = await handle.pool.query(`SELECT to_regclass('events')::text AS exists`);
    expect(tableCheck.rows[0]?.exists).toBeNull();

    const tracking = await handle.pool.query(
      'SELECT filename FROM _posta_sql_migrations WHERE filename = ANY($1)',
      [EVENTS_MIGRATIONS],
    );
    expect(tracking.rows).toEqual([]);
  });

  it.each([
    '../../../etc/passwd',
    '001_events.sql; DROP TABLE events;',
    '001_EVENTS.sql', // uppercase rejected — must match NNN_name.sql exactly
    'events.sql', // missing the NNN_ prefix
  ])(
    '[security] rejects a malformed filename before it is ever joined into a filesystem path: %s',
    async (maliciousFilename) => {
      await expect(
        downSqlMigration(handle.pool, maliciousFilename, { migrationsDir: MIGRATIONS_DIR }),
      ).rejects.toThrow(/invalid migration filename/i);
    },
  );
});
