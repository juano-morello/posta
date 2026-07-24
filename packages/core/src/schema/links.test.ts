import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { newId } from '../ulid';
import { user } from './auth';
import { links } from './links';

// T1.1.5 — `links`: UNIQUE (tenant_id, slug) per tenant, never global
// (invariant 9), and `destination` validated as an absolute http(s) URL at
// the schema boundary via a CHECK constraint (defense in depth behind the
// contracts validation, T1.1.11). All assertions run against a REAL
// testcontainers Postgres (never a mock), reading back the genuine
// SQLSTATE the database raises.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

// drizzle-orm's node-postgres driver wraps every query failure in its own
// DrizzleQueryError; the raw `pg` error (the one carrying the real
// Postgres SQLSTATE in `.code`) is its `.cause`, not the top-level thrown
// error itself.
interface PgError extends Error {
  readonly code?: string;
}

interface DrizzleQueryError extends Error {
  readonly cause?: PgError;
}

function pgErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return (error as DrizzleQueryError).cause?.code;
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

describe('links schema (T1.1.5)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('lets two different tenants both insert the slug "promo" (UNIQUE is per-tenant, never global)', async () => {
    const tenantA = await seedTenant(handle);
    const tenantB = await seedTenant(handle);

    await handle.db.insert(links).values({
      id: newId(),
      tenantId: tenantA,
      slug: 'promo',
      destination: 'https://example.com/a',
    });
    await handle.db.insert(links).values({
      id: newId(),
      tenantId: tenantB,
      slug: 'promo',
      destination: 'https://example.com/b',
    });

    const result = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM links WHERE slug = 'promo'
    `);
    expect(result.rows[0]?.count).toBe('2');
  });

  it('raises SQLSTATE 23505 on a same-tenant duplicate slug', async () => {
    const tenantId = await seedTenant(handle);

    await handle.db.insert(links).values({
      id: newId(),
      tenantId,
      slug: 'dup-slug',
      destination: 'https://example.com/first',
    });

    await expect(
      handle.db.insert(links).values({
        id: newId(),
        tenantId,
        slug: 'dup-slug',
        destination: 'https://example.com/second',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('raises SQLSTATE 23514 for a javascript: destination', async () => {
    const tenantId = await seedTenant(handle);

    let caughtCode: string | undefined;
    try {
      await handle.db.insert(links).values({
        id: newId(),
        tenantId,
        slug: 'bad-destination',
        destination: 'javascript:alert(1)',
      });
    } catch (error) {
      caughtCode = pgErrorCode(error);
    }

    expect(caughtCode).toBe('23514');
  });

  it('the tenant links list query (tenant_id, ORDER BY created_at DESC) uses the composite index', async () => {
    // Postgres's planner prefers a sequential scan on a near-empty table
    // regardless of which indexes exist — disabling seqscan for this
    // session is the standard way to assert an index WOULD be used
    // without seeding thousands of rows to make it the genuinely cheaper
    // plan.
    await handle.db.execute(sql`SET enable_seqscan = off`);

    const tenantId = await seedTenant(handle);
    const result = await handle.db.execute<{ 'QUERY PLAN': string }>(sql`
      EXPLAIN SELECT id FROM links WHERE tenant_id = ${tenantId} ORDER BY created_at DESC
    `);

    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).toContain('links_tenant_id_created_at_idx');

    await handle.db.execute(sql`SET enable_seqscan = on`);
  });
});
