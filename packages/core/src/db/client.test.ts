import { afterAll, describe, expect, it } from 'vitest';
import { createDbClient } from './client';

// T1.1.1 — the db seam every later E1 task builds on. This test connects to
// the REAL compose Postgres over DATABASE_URL (never a mock — same pattern
// as tests/infra/redis-policy.test.ts), so "this test passes" and "the app
// would actually boot against a correctly-configured Postgres" stay the same
// claim.
//
// Pool `max` is explicit and env-supplied (DB_POOL_MAX), never left to the
// pg driver default (10) — see CLAUDE.md/plan T1.1.1: under Kubernetes the
// api scales horizontally, so an implicit default is what lets the HPA
// scaling up exhaust the database's connection cap. TEST_POOL_MAX is
// deliberately NOT 10, so asserting `pool.options.max === TEST_POOL_MAX`
// only passes if the configured value genuinely made it through — a driver
// default sneaking in would fail this assertion, not accidentally satisfy it.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_POOL_MAX = 7;
const PG_DRIVER_DEFAULT_MAX = 10;

describe('createDbClient (T1.1.1)', () => {
  if (!DATABASE_URL) {
    it('fails loudly: DATABASE_URL is not set, so the compose Postgres cannot be reached', () => {
      throw new Error(
        'DATABASE_URL is not set. Start the local stack (`docker compose up -d --wait ' +
          'postgres`) and export DATABASE_URL (see .env.example) before running this test.',
      );
    });
    return;
  }

  describe('when DATABASE_URL is configured', () => {
    const client = createDbClient({ connectionString: DATABASE_URL, max: TEST_POOL_MAX });

    afterAll(async () => {
      await client.closeDb();
    });

    it('connects to the compose Postgres and asserts SELECT 1', async () => {
      const result = await client.pool.query('SELECT 1 AS one');
      expect(result.rows[0]).toEqual({ one: 1 });
    });

    it('asserts the compose Postgres reports server_version >= 16', async () => {
      const result = await client.pool.query<{ server_version: string }>('SHOW server_version');
      const rawVersion = result.rows[0]?.server_version;
      expect(rawVersion).toBeDefined();

      const majorVersion = Number.parseInt(String(rawVersion).split('.')[0] ?? '', 10);
      expect(majorVersion).toBeGreaterThanOrEqual(16);
    });

    it('reports the pool max it was configured with, not the pg driver default', () => {
      expect(client.pool.options.max).toBe(TEST_POOL_MAX);
      expect(client.pool.options.max).not.toBe(PG_DRIVER_DEFAULT_MAX);
    });
  });

  describe('when DB_POOL_MAX is required from env and unset', () => {
    it('throws a clear, named error instead of silently falling back to the driver default', () => {
      const originalPoolMax = process.env.DB_POOL_MAX;
      delete process.env.DB_POOL_MAX;

      try {
        expect(() => createDbClient({ connectionString: DATABASE_URL })).toThrow(/DB_POOL_MAX/);
      } finally {
        if (originalPoolMax === undefined) {
          delete process.env.DB_POOL_MAX;
        } else {
          process.env.DB_POOL_MAX = originalPoolMax;
        }
      }
    });
  });
});
