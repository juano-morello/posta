import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { newId } from '../ulid';
import { user } from './auth';
import { bioPages } from './bio';

// T1.1.6 — `bio_pages.handle` is globally unique (it is a DNS subdomain,
// not a per-tenant name — unlike links.slug, T1.1.5). All assertions run
// against a REAL testcontainers Postgres, reading back the genuine
// SQLSTATE / column values the database produces.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

interface DrizzleQueryError extends Error {
  readonly cause?: { readonly code?: string };
}

async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

describe('bio_pages schema (T1.1.6)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('raises SQLSTATE 23505 when the same handle is claimed under two different tenants', async () => {
    const tenantA = await seedTenant(handle);
    const tenantB = await seedTenant(handle);

    await handle.db.insert(bioPages).values({
      id: newId(),
      tenantId: tenantA,
      handle: 'juano',
    });

    let caughtCode: string | undefined;
    try {
      await handle.db.insert(bioPages).values({
        id: newId(),
        tenantId: tenantB,
        handle: 'juano',
      });
    } catch (error) {
      caughtCode = (error as DrizzleQueryError).cause?.code;
    }

    expect(caughtCode).toBe('23505');
  });

  it('defaults theme_id to "default" and leaves optional fields null', async () => {
    const tenantId = await seedTenant(handle);

    await handle.db.insert(bioPages).values({
      id: newId(),
      tenantId,
      handle: 'no-theme-set',
    });

    const result = await handle.db.execute<{
      theme_id: string;
      display_name: string | null;
    }>(sql`SELECT theme_id, display_name FROM bio_pages WHERE handle = 'no-theme-set'`);

    expect(result.rows[0]?.theme_id).toBe('default');
    expect(result.rows[0]?.display_name).toBeNull();
  });

  it('created_at round-trips as timestamptz, not shifted by a non-UTC session TimeZone', async () => {
    const tenantId = await seedTenant(handle);

    // A naive `timestamp` column stores `now()`'s value as LOCAL WALL-CLOCK
    // TEXT in whatever TimeZone is active at insert time, stripping the
    // offset. Reading it back under a DIFFERENT session TimeZone then
    // reinterprets that same naive literal under the new zone, silently
    // shifting the reconstructed instant by the difference between the two
    // offsets. A genuine `timestamptz` column stores the UTC instant
    // itself, immune to whatever TimeZone is active at insert OR read time.
    // Sao Paulo (UTC-03:00) makes a naive-column bug obviously wrong (~3
    // hours off), never something a few seconds of clock skew could
    // accidentally paper over.
    await handle.db.execute(sql`SET TIME ZONE 'America/Sao_Paulo'`);
    await handle.db.insert(bioPages).values({
      id: newId(),
      tenantId,
      handle: 'tz-round-trip-handle',
    });
    // Switch to a DIFFERENT session TimeZone before reading back — this is
    // the step that actually exposes a naive column, not just proves a
    // value was stored.
    await handle.db.execute(sql`SET TIME ZONE 'UTC'`);

    // The comparison happens entirely in Postgres (EXTRACT(EPOCH FROM ...))
    // rather than parsing the returned value as a JS Date — raw
    // db.execute() returns Postgres's text encoding of timestamptz
    // (e.g. "2026-07-22 18:52:44.49-03"), which is not a format the JS
    // Date constructor is guaranteed to parse consistently.
    const result = await handle.db.execute<{ diff_seconds: string }>(sql`
      SELECT EXTRACT(EPOCH FROM (now() - created_at))::text AS diff_seconds
      FROM bio_pages WHERE handle = 'tz-round-trip-handle'
    `);
    const diffSeconds = Number(result.rows[0]?.diff_seconds);

    // Generous enough for real clock skew/test latency, but two orders of
    // magnitude below Sao Paulo's 3-hour (10,800 second) offset — a naive
    // column would fail this by a wide margin, not a marginal one.
    expect(Math.abs(diffSeconds)).toBeLessThan(30);
  });
});
