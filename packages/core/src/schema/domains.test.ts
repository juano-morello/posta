import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { newId } from '../ulid';
import { user } from './auth';
import { domains } from './domains';

// T1.1.8 — `domains` ships EMPTY in v1: nothing reads or writes it. It
// exists so Cloudflare-for-SaaS custom domains (v1.5) are an INSERT plus
// a read path, not a migration against a live partitioned database. All
// assertions run against a REAL testcontainers Postgres.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

interface DrizzleQueryError extends Error {
  readonly cause?: { readonly code?: string };
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

describe('domains schema (T1.1.8)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('exists after migrate and is empty — nothing in v1 reads or writes it', async () => {
    const result = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM domains
    `);
    expect(result.rows[0]?.count).toBe('0');
  });

  it('defaults type to "subdomain" and accepts an explicit "custom" too', async () => {
    const tenantId = await seedTenant(handle);

    await handle.db.insert(domains).values({
      id: newId(),
      tenantId,
      host: 'juano.example.test',
    });
    await handle.db.insert(domains).values({
      id: newId(),
      tenantId,
      host: 'links.juano.dev',
      type: 'custom',
    });

    const result = await handle.db.execute<{ host: string; type: string }>(sql`
      SELECT host, type FROM domains ORDER BY host
    `);
    expect(result.rows).toEqual([
      { host: 'juano.example.test', type: 'subdomain' },
      { host: 'links.juano.dev', type: 'custom' },
    ]);
  });

  it('rejects a type outside {subdomain, custom} — a CHECK constraint, not just documentation', async () => {
    const tenantId = await seedTenant(handle);

    let caughtCode: string | undefined;
    try {
      await handle.db.insert(domains).values({
        id: newId(),
        tenantId,
        host: 'invalid-type.example.test',
        type: 'bogus',
      });
    } catch (error) {
      caughtCode = pgErrorCode(error);
    }

    expect(caughtCode).toBe('23514');
  });
});
