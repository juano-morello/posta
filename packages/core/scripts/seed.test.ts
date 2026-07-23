import { verifyPassword } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../src/test/pg-container';
import { seed } from './seed';

// T1.5.5 [INV-9][security] — the ONLY way the single v1 account comes
// into being: there is no public signup route (not hidden — absent), so
// this script is that account's sole origin. Idempotent by email:
// re-running (every deploy) must never duplicate the user, its bio page,
// or its example link.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

const SEED_ENV = {
  email: 'juano@example.test',
  password: 'a-genuinely-long-seed-password-123',
  handle: 'juano',
};

describe('seed (T1.5.5)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('throws naming the variable when SEED_USER_PASSWORD is missing', async () => {
    await expect(
      seed(handle.pool, { email: SEED_ENV.email, password: '', handle: SEED_ENV.handle }),
    ).rejects.toThrow(/SEED_USER_PASSWORD/);
  });

  it('running it twice creates exactly one user, one bio page, and one link — never duplicated', async () => {
    const first = await seed(handle.pool, SEED_ENV);
    const second = await seed(handle.pool, SEED_ENV);

    expect(second).toEqual(first);

    const userCount = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM "user" WHERE email = ${SEED_ENV.email}
    `);
    expect(userCount.rows[0]?.count).toBe('1');

    const bioPageCount = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM bio_pages WHERE tenant_id = ${first.userId}
    `);
    expect(bioPageCount.rows[0]?.count).toBe('1');

    const linkCount = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM links WHERE tenant_id = ${first.userId}
    `);
    expect(linkCount.rows[0]?.count).toBe('1');
  });

  it('stores the password as a verifiable hash, never the raw value', async () => {
    const { userId } = await seed(handle.pool, SEED_ENV);

    const accountRow = await handle.db.execute<{ password: string }>(sql`
      SELECT password FROM account WHERE user_id = ${userId} AND provider_id = 'credential'
    `);
    const storedPassword = accountRow.rows[0]?.password;

    expect(storedPassword).toBeTruthy();
    expect(storedPassword).not.toBe(SEED_ENV.password);

    const isValid = await verifyPassword({ hash: storedPassword ?? '', password: SEED_ENV.password });
    expect(isValid).toBe(true);
  });

  it('creates the bio page with the handle from env and the example link with an https destination', async () => {
    const { userId, bioPageId, linkId } = await seed(handle.pool, SEED_ENV);

    const bioPage = await handle.db.execute<{ id: string; handle: string }>(sql`
      SELECT id, handle FROM bio_pages WHERE id = ${bioPageId}
    `);
    expect(bioPage.rows[0]?.handle).toBe(SEED_ENV.handle);

    const link = await handle.db.execute<{ id: string; destination: string; tenant_id: string }>(sql`
      SELECT id, destination, tenant_id FROM links WHERE id = ${linkId}
    `);
    expect(link.rows[0]?.tenant_id).toBe(userId);
    expect(link.rows[0]?.destination).toMatch(/^https:\/\//);
  });
});
