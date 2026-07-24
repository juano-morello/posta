import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { startPgContainer } from './pg-container';

// T1.1.2 — the shared testcontainers Postgres 16 harness every integration
// test in E1-E4 reuses instead of booting its own container. This test is
// the one place that exercises the harness itself against a REAL container
// (never a mock): boot, confirm it is genuinely Postgres 16.x, then confirm
// stop() actually tears the container down rather than merely resolving.
//
// 120s: a cold `postgres:16-alpine` image pull plus container boot can
// comfortably exceed Vitest's 5s default test timeout; packages/core's own
// vitest.config.ts (this task) raises hookTimeout to match, but the test
// timeout itself is set per-test here too, since this is the one test file
// most likely to hit that ceiling on a cold run.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

describe('startPgContainer (T1.1.2)', () => {
  it(
    'boots a Postgres 16 container, reports server version 16.x, and stop() releases the port',
    async () => {
      const handle = await startPgContainer();

      const probe = new Pool({ connectionString: handle.url, max: 1 });
      try {
        const result = await probe.query<{ version: string }>('SELECT version()');
        expect(result.rows[0]?.version).toMatch(/^PostgreSQL 16\./);
      } finally {
        await probe.end();
      }

      await handle.stop();

      // stop() must have actually torn the container (and its published
      // port) down, not merely resolved — a fresh connection attempt at
      // the same URL should now be refused, not silently succeed.
      const postStopProbe = new Pool({
        connectionString: handle.url,
        max: 1,
        connectionTimeoutMillis: 2_000,
      });
      await expect(postStopProbe.query('SELECT 1')).rejects.toThrow();
      await postStopProbe.end().catch(() => undefined);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );
});
