import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_TEST_TIMEOUT_MS } from '../resolve-test-support';
import {
  HARNESS_DESTINATION,
  HARNESS_DOMAIN,
  HARNESS_HANDLE,
  HARNESS_SLUG,
  startHotPathHarness,
  type HotPathHarness,
} from './hot-path-harness';

// T2.6.1 — the FOUNDATION harness every other S2.6 test (T2.6.2-T2.6.9)
// reuses instead of each booting its own Postgres+Redis+app stack. This
// file proves the harness itself does what its own contract promises:
// a real request against the one seeded link gets a real 307, the real
// BullMQ producer enqueues exactly one job, and stop() actually releases
// both containers and the ephemeral port — not just "didn't throw".

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
}

/** A plain `http.request` against `baseUrl`, with the seeded link's own
 * Host header set explicitly — mirrors not-found-routing.test.ts's and
 * open-redirect.test.ts's own small, file-local request helpers rather
 * than centralizing this in the harness itself, which has no opinion on
 * what any ONE test wants to request. */
function requestSeededLink(baseUrl: string): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `/${HARNESS_SLUG}`,
        headers: { Host: `${HARNESS_HANDLE}.${HARNESS_DOMAIN}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Polls `harness.queue` until at least one waiting job shows up, or
 * `deadlineMs` elapses — more robust than a single fixed sleep against a
 * REAL fire-and-forget enqueue (redirect-response.ts's own comment: the
 * response is sent before the capture pipeline even starts running). */
async function waitForWaitingJobs(
  harness: HotPathHarness,
  deadlineMs = 5000,
): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const jobs = await harness.queue.getJobs(['wait']);
    if (jobs.length > 0 || Date.now() > deadline) return jobs.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function connectTo(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/' }, () => resolve());
    req.on('error', reject);
    req.end();
  });
}

describe('startHotPathHarness (T2.6.1)', () => {
  let harness: HotPathHarness;

  beforeAll(async () => {
    harness = await startHotPathHarness();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('redirects the one seeded link with a real 307 and enqueues exactly one job', async () => {
    const response = await requestSeededLink(harness.baseUrl);

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe(HARNESS_DESTINATION);

    const waitingCount = await waitForWaitingJobs(harness);
    expect(waitingCount).toBe(1);
  });

  it('exposes the seeded tenant/link ids and a live db/redis client', async () => {
    expect(harness.tenantId.length).toBeGreaterThan(0);
    expect(harness.linkId.length).toBeGreaterThan(0);
    expect(await harness.redis.ping()).toBe('PONG');
  });

  it('stop() releases both containers and the port, idempotently', async () => {
    const port = harness.port;

    await harness.stop();

    // The port is gone: a fresh connection attempt must fail, never hang.
    await expect(connectTo(port)).rejects.toThrow();

    // The containers are gone too: the SAME redis/pool handles this
    // harness handed out can no longer serve a query. `pool.query`
    // (never `drizzle-orm`'s own `sql` tag) mirrors open-redirect.test.ts's
    // identical `pg.pool.query(...)` precedent — apps/api has no direct
    // dependency on `drizzle-orm` or `pg`, only `@posta/core` does, and
    // `pool`'s type resolves transitively through that package's own
    // compiled declarations with no import needed here.
    await expect(harness.redis.ping()).rejects.toThrow();
    await expect(harness.pool.query('select 1')).rejects.toThrow();

    // Idempotent: a second stop() call must not throw (e.g. "pool
    // already ended", "quit on a closed client").
    await expect(harness.stop()).resolves.toBeUndefined();
  });
});
