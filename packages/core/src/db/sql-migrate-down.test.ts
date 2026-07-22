import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { downSqlMigration, runSqlMigrations } from './sql-migrate';

// T1.2.6 — rollback support for hand-written SQL migrations. Dropping
// `events` drops its partitions, so 001_events.down.sql refuses to run
// when the table has rows unless `--force` — an accidental rollback in
// staging should be loud, not clean.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');
const EVENTS_MIGRATIONS = ['001_events.sql', '002_events_indexes.sql'] as const;

describe('sql-migrate down (T1.2.6)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    // events has zero partitions until T1.3.x automates partition
    // creation — a DEFAULT partition here lets this test insert a row
    // covering any occurred_at without depending on that later story.
    await handle.pool.query(`CREATE TABLE events_t126_default PARTITION OF events DEFAULT`);
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

  it('down succeeds and removes the tracking row once the table is empty', async () => {
    await handle.pool.query('TRUNCATE events');

    // Reverse order: the indexes migration first, then the table itself
    // — down() is called per-file, not implicitly cascading (even though
    // DROP TABLE would take the indexes with it regardless).
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
    // The previous test's re-migration recreated the bare partitioned
    // table with no partitions (the DEFAULT partition from beforeAll was
    // dropped along with the table in the prior test) — a fresh one is
    // needed before another INSERT can land anywhere.
    await handle.pool.query(`CREATE TABLE events_t126_default_2 PARTITION OF events DEFAULT`);
    await handle.pool.query(`
      INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
      VALUES ('01T126EVENT00000000000001', now(), 'tenant-y', 'link-y', 'slug-y')
    `);

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
});
