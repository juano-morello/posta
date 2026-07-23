import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { runSqlMigrations } from './sql-migrate';

// T1.3.6 — the month-edge cases the bounds arithmetic (T1.3.1's
// create_events_partition) is most likely to get wrong. August/September
// 2026 partitions are created EXPLICITLY here via create_events_partition
// (idempotent — a no-op if T1.3.3's bootstrap already created them for
// "today"), rather than relied upon from the bootstrap's own dynamically
// computed "current + 3" window, so this test stays correct regardless of
// what "today" happens to be whenever it actually runs.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `01T136EVENT${String(eventCounter).padStart(14, '0')}`;
}

describe('partition boundary and pruning tests (T1.3.6)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    await handle.pool.query(`SELECT create_events_partition('2026-08-01'::date)`);
    await handle.pool.query(`SELECT create_events_partition('2026-09-01'::date)`);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  async function tableoidFor(eventId: string): Promise<string | undefined> {
    const result = await handle.pool.query<{ tableoid: string }>(
      `SELECT tableoid::regclass::text AS tableoid FROM events WHERE event_id = $1`,
      [eventId],
    );
    return result.rows[0]?.tableoid;
  }

  it('2026-08-31T23:59:59.999Z lands in August', async () => {
    const eventId = nextEventId();
    await handle.pool.query(
      `INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
       VALUES ($1, '2026-08-31T23:59:59.999Z', 'tenant-x', 'link-x', 'slug-x')`,
      [eventId],
    );
    expect(await tableoidFor(eventId)).toBe('events_2026_08');
  });

  it('2026-09-01T00:00:00.000Z lands in September', async () => {
    const eventId = nextEventId();
    await handle.pool.query(
      `INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
       VALUES ($1, '2026-09-01T00:00:00.000Z', 'tenant-x', 'link-x', 'slug-x')`,
      [eventId],
    );
    expect(await tableoidFor(eventId)).toBe('events_2026_09');
  });

  it('a -03:00 Sao Paulo timestamp is routed by its UTC instant, not its local date', async () => {
    // '2026-08-31 22:00:00-03:00' local time in Sao Paulo is
    // '2026-09-01 01:00:00Z' as a UTC instant — a routing bug that
    // (incorrectly) used the LOCAL calendar date "August 31" would land
    // this in events_2026_08; correct UTC-instant routing lands it in
    // events_2026_09.
    const eventId = nextEventId();
    await handle.pool.query(
      `INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
       VALUES ($1, '2026-08-31 22:00:00-03:00', 'tenant-x', 'link-x', 'slug-x')`,
      [eventId],
    );
    expect(await tableoidFor(eventId)).toBe('events_2026_09');
  });

  it('an occurred_at BETWEEN range query prunes to the matching partition only', async () => {
    await handle.pool.query('SET enable_seqscan = off');

    const result = await handle.pool.query<{ 'QUERY PLAN': string }>(`
      EXPLAIN SELECT event_id FROM events
      WHERE occurred_at >= '2026-08-01T00:00:00Z' AND occurred_at < '2026-09-01T00:00:00Z'
    `);
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');

    expect(plan).toContain('events_2026_08');
    expect(plan).not.toContain('events_2026_09');
    // Exactly one partition scanned — count occurrences of the "on
    // events_YYYY_MM" scan-target phrase, not just "does the name appear
    // anywhere in the plan" (which the WHERE clause's own literals or an
    // unrelated line could also satisfy).
    const scannedPartitions = [...plan.matchAll(/\bon (events_\d{4}_\d{2})\b/g)].map(
      (match) => match[1],
    );
    expect(new Set(scannedPartitions).size).toBe(1);
    expect(scannedPartitions).toContain('events_2026_08');

    await handle.pool.query('SET enable_seqscan = on');
  });
});
