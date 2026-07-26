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

// T2.6.2 [INV-1] — the single highest-value test in this epic: "a redirect
// never blocks on analytics. Resolve destination -> 307 -> enqueue. If the
// enqueue fails, still redirect." (CLAUDE.md). Every other S2.6 test proves
// a HAPPY-path property; this one proves the product's actual promise —
// that Posta keeps redirecting when the thing recording the click is dead.
//
// Two fault-injection mechanisms, per this task's own dispatch brief:
//   1. "Points the BullMQ producer at a closed port after boot" — sever
//      ONLY the events queue's own dedicated connection. resolveTenant/
//      resolveLink's cache tier stays healthy; only the enqueue step dies.
//   2. "Separately stops the Redis container outright" — sever EVERY Redis
//      connection this process holds, so resolveTenant/resolveLink also
//      degrade to their Postgres fallback on every single request. A
//      materially more thorough proof: it is not just "the queue's own
//      connection is broken", it is "Redis, in its entirety, is gone".
//
// Both mechanisms reuse T2.6.1's real harness (startHotPathHarness) against
// the REAL production composition (main.ts's own wiring) over real
// Postgres + Redis testcontainers — a mock would let every assertion below
// pass while the real thing hangs.
//
// [mechanism 2, deviation from the dispatch's own suggested path — reported
// here, not by touching hot-path-harness.ts] The dispatch's own brief
// suggested that a GENUINE testcontainers Redis container stop might need a
// small, additive extension to hot-path-harness.ts (mirroring `pool`'s own
// "expose the thing `db` doesn't cover" precedent), since the harness
// currently has no seam for stopping ONLY its Redis piece. Investigated
// that path and chose NOT to take it, for a reason discovered while
// reasoning through what a real container stop actually does to the
// events queue's own connection specifically:
//
//   `createEventsQueue` (enqueue.ts) sets `maxRetriesPerRequest: null`
//   (BullMQ's own hard requirement) and leaves `enableOfflineQueue` at
//   ioredis's own default (`true`). A REAL container stop does NOT set
//   ioredis's `manuallyClosing` flag (only an explicit, local
//   `client.disconnect()` does) — so ioredis's own `retryStrategy` keeps
//   scheduling reconnect attempts forever, and any `queue.add()` issued
//   during that window sits in the OFFLINE QUEUE awaiting a reconnection
//   that, once the container is truly gone (testcontainers cannot cleanly
//   restart a stopped container on the same port — see
//   resolve-degraded.test.ts's own header for this exact finding), never
//   arrives. With `maxRetriesPerRequest: null`, the `MaxRetriesPerRequestError`
//   safety net that would otherwise flush that queue is disabled outright:
//   the `queue.add()` promise would simply HANG forever, never settling.
//   That hang costs the REDIRECT nothing (enqueueCapture is fire-and-forget,
//   awaited by nothing on the hot path) — but it WOULD mean this file's own
//   "one enqueue-failure log per request" assertion silently stops being
//   true for reasons that have nothing to do with invariant 1 itself,
//   because a promise that never settles never reaches `logEnqueueFailure`.
//
// A manual, NON-reconnecting `client.disconnect()` (ioredis's own
// `reconnect` argument defaults to `false`) sidesteps that entirely: it
// sets `manuallyClosing = true`, so ioredis's own close handler skips every
// reconnect attempt and settles the connection at status `"end"` — every
// future command on that client rejects IMMEDIATELY with
// `"Connection is closed."` (verified against ioredis's own source,
// `built/Redis.js`'s `sendCommand` and `built/redis/event_handler.js`'s
// `closeHandler`), never queues behind a retry loop. Applying that SAME
// disconnect to BOTH ioredis client instances this harness holds — the
// shared cache/salt/tenant/link client (`harness.redis`) and the events
// queue's own dedicated connection (`await harness.queue.client`) — is
// observably identical, from this process's point of view, to the whole
// Redis backend vanishing (verified by reading hot-path-harness.ts's own
// boot sequence: those are the ONLY two Redis connections this harness
// ever opens; every resolve/salt closure shares the one `redis.client`),
// while keeping every command's failure mode the deterministic, immediate
// rejection this file's assertions actually depend on. No production file
// and no shared test-infrastructure file needed to change for this.

interface RawResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly elapsedMs: number;
}

// RFC 5737 TEST-NET-3 — never a real host. Matches capture-privacy.test.ts's
// and enqueue-logging.test.ts's own convention for a distinctive,
// greppable IP literal fed via `CF-Connecting-IP` [INV-6].
const DISTINCTIVE_IP = '203.0.113.77';

/** A plain `http.request` against the harness's own ephemeral port, with
 * the seeded link's Host header set explicitly and a distinctive
 * CF-Connecting-IP — mirrors hot-path-harness.test.ts's own
 * `requestSeededLink`, widened to also time the round trip and carry the
 * IP this file's own "no IP in the log" assertion depends on. */
function requestSeededLink(baseUrl: string): Promise<RawResponse> {
  const url = new URL(baseUrl);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `/${HARNESS_SLUG}`,
        headers: {
          Host: `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`,
          'cf-connecting-ip': DISTINCTIVE_IP,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            elapsedMs: Date.now() - startedAt,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// This task's own dispatch brief: "50 requests".
const REQUEST_COUNT = 50;

// Generous on purpose — this is NOT T2.6.9's tight production p95 budget
// (15ms, measured sequentially on a warm cache). What this bound actually
// guards against is invariant 1's real failure mode: an AWAITED, wedged
// queue.add() costing the OS's own TCP/reconnect timeout (seconds), or a
// response that never gets sent at all. A healthy redirect (warm cache,
// fire-and-forget enqueue) comfortably clears this by 1-2 orders of
// magnitude; a regression that blocks the redirect on the dead queue does
// not. Mirrors resolve-degraded.test.ts's own MAX_RESOLUTION_LATENCY_MS
// (500ms) reasoning, applied to a full HTTP round trip.
const MAX_LATENCY_QUEUE_ONLY_MS = 500;

// Wider than the queue-only bound above: mechanism 2 also pushes every one
// of the 50 requests through a genuine Postgres fallback query (resolveLink
// can no longer hit Redis at all), all contending on the harness's own
// 5-connection pg Pool (CONTAINER_POOL_MAX, pg-container.ts) — still
// comfortably fast locally, but this bound is sized for that added,
// legitimate contention rather than for a wedge.
const MAX_LATENCY_FULL_OUTAGE_MS = 2000;

const ENQUEUE_FAILURE_LOG_PATTERN = /Enqueue failed; the redirect already succeeded, event dropped/;

/** Polls `harness.logs` (from `since` onward) until at least `count` lines
 * match `pattern`, or `deadlineMs` elapses — enqueueCapture's own failure
 * log is fire-and-forget, attached AFTER the response (T2.4.3's own
 * ordering guarantee), so the LAST of N concurrent requests' own log line
 * can still be landing after every HTTP response has already come back.
 * Mirrors hot-path-harness.test.ts's own waitForWaitingJobs and
 * status-and-event-id.test.ts's waitForWaitingJobCount, applied to log
 * lines instead of queue jobs. */
async function waitForNewLogCount(
  harness: HotPathHarness,
  pattern: RegExp,
  since: number,
  count: number,
  deadlineMs = 5000,
): Promise<string[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const matches = harness.logs.slice(since).filter((line) => pattern.test(line));
    if (matches.length >= count || Date.now() > deadline) return matches;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Polls `harness.queue`'s own 'wait' list until it holds MORE than
 * `previousCount` jobs, or `deadlineMs` elapses — same "poll, don't
 * fixed-sleep" reasoning as {@link waitForNewLogCount}, applied to proving
 * the queue actually accepts a job again once reconnected. */
async function waitForMoreWaitingJobs(
  harness: HotPathHarness,
  previousCount: number,
  deadlineMs = 5000,
): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const jobs = await harness.queue.getJobs(['wait']);
    if (jobs.length > previousCount || Date.now() > deadline) return jobs.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('redirect succeeds while the queue is down (T2.6.2) [INV-1]', () => {
  let harness: HotPathHarness;

  beforeAll(async () => {
    harness = await startHotPathHarness();
    // Warms resolveTenant's own 60s memo, resolveLink's Redis cache, and
    // the daily salt's own process-local memo (T2.3.6) — every request in
    // both `it`s below is then a genuine cache hit for anything that is
    // NOT the specific fault being injected, isolating "does a dead
    // queue/dead Redis degrade the redirect" from "is the first Postgres
    // round trip, or the first-of-day salt fetch, slow".
    const warmup = await requestSeededLink(harness.baseUrl);
    expect(warmup.status).toBe(307);

    // [fix — genuine race, not container contention] `requestSeededLink`'s
    // promise resolves once the CLIENT has the full HTTP response, but
    // middleware.ts's own handleLinkTarget flushes that response (via
    // sendLinkRedirect) BEFORE it `await`s getDailySalt() and calls
    // enqueueCapture() — see this file's own header and middleware.ts's
    // "the one await in this whole function that runs AFTER the response
    // has already been flushed". getDailySalt's OWN first-ever call does a
    // real SET+GET round trip against the Redis container (salt.ts), so
    // the warmup's server-side capture pipeline can still be in flight
    // (specifically, sitting on that round trip) after the line above
    // returns. Without waiting for it here, that lingering continuation
    // can still call enqueueCapture() AFTER either `it` below disconnects
    // the queue/Redis — producing an (N+1)-th "Enqueue failed" log line
    // attributed to a request neither `it` ever issued (observed directly:
    // `expected 51 to be 50`, the assertion always short-circuiting within
    // ~100ms, well inside 5s deadline, meaning 51 lines already existed
    // the FIRST time this poll looked). Every fault-recovery check in this
    // same file (`waitForMoreWaitingJobs`) already waits for the real side
    // effect rather than trusting the client-side response alone; this
    // applies the identical discipline to the warmup, closing the one gap.
    const warmedUp = await waitForMoreWaitingJobs(harness, 0);
    expect(warmedUp).toBeGreaterThan(0);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    'mechanism 1 — the BullMQ producer pointed at a closed port: 50/50 redirects still succeed with bounded latency, one enqueue-failure log per request with no IP, zero unhandled rejections — then recovers once reconnected',
    async () => {
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      const queueClient = await harness.queue.client;
      const logsBefore = harness.logs.length;
      const jobsBefore = (await harness.queue.getJobs(['wait'])).length;

      try {
        // See this file's own header for exactly why this call — not a
        // real closed TCP port, not a reconnect against an unreachable
        // address — is the deterministic way to reproduce "the producer's
        // connection is dead" against the SAME connection object the
        // running middleware's enqueueCapture closure already calls
        // `.add()` through: `queue.client` resolves the identical ioredis
        // instance createEventsQueue built once at harness boot.
        queueClient.disconnect();

        const responses = await Promise.all(
          Array.from({ length: REQUEST_COUNT }, () => requestSeededLink(harness.baseUrl)),
        );

        for (const response of responses) {
          expect(response.status).toBe(307);
          expect(response.location).toBe(HARNESS_DESTINATION);
          expect(response.elapsedMs).toBeLessThan(MAX_LATENCY_QUEUE_ONLY_MS);
        }

        const failureLogs = await waitForNewLogCount(harness, ENQUEUE_FAILURE_LOG_PATTERN, logsBefore, REQUEST_COUNT);
        expect(failureLogs).toHaveLength(REQUEST_COUNT);

        const newLogs = harness.logs.slice(logsBefore);
        for (const line of newLogs) {
          expect(line).not.toContain(DISTINCTIVE_IP);
        }

        expect(unhandledRejections).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }

      // The outage ends: reconnect the SAME client (no new container, no
      // new Queue instance) and prove the process is still serving —
      // another redirect succeeds, AND the queue genuinely accepts a job
      // again, proving this was a real recovery, not merely "the redirect
      // never depended on it in the first place" (true, but a weaker
      // claim than this).
      await queueClient.connect();

      const recovered = await requestSeededLink(harness.baseUrl);
      expect(recovered.status).toBe(307);
      expect(recovered.location).toBe(HARNESS_DESTINATION);

      const jobsAfterRecovery = await waitForMoreWaitingJobs(harness, jobsBefore);
      expect(jobsAfterRecovery).toBeGreaterThan(jobsBefore);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'mechanism 2 — the entire Redis backend is gone: 50/50 redirects still succeed via the Postgres fallback, one enqueue-failure log per request with no IP, zero unhandled rejections — then recovers once reconnected',
    async () => {
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      const queueClient = await harness.queue.client;
      const logsBefore = harness.logs.length;
      const jobsBefore = (await harness.queue.getJobs(['wait'])).length;

      try {
        // Severs BOTH ioredis connections this harness holds — see this
        // file's own header for why this (not a real testcontainers
        // container stop) is the equivalent, more deterministic proof of
        // "the whole Redis backend is gone". resolveTenant's own handle
        // memo (resolve-tenant.ts, 60s TTL) absorbs the handle lookup with
        // no Redis call either way — it was already warmed by this
        // describe block's own beforeAll and by mechanism 1 above, well
        // within its TTL — so what this actually exercises fresh is
        // resolveLink's OWN degrade-to-Postgres path (T2.2.2's acceptance:
        // "Redis unavailable -> fall through to Postgres and still serve;
        // log, do not throw"), on every one of the 50 requests below, at
        // the same time as the queue's own enqueue failure.
        harness.redis.disconnect();
        queueClient.disconnect();

        const responses = await Promise.all(
          Array.from({ length: REQUEST_COUNT }, () => requestSeededLink(harness.baseUrl)),
        );

        for (const response of responses) {
          expect(response.status).toBe(307);
          expect(response.location).toBe(HARNESS_DESTINATION);
          expect(response.elapsedMs).toBeLessThan(MAX_LATENCY_FULL_OUTAGE_MS);
        }

        const failureLogs = await waitForNewLogCount(harness, ENQUEUE_FAILURE_LOG_PATTERN, logsBefore, REQUEST_COUNT);
        expect(failureLogs).toHaveLength(REQUEST_COUNT);

        const newLogs = harness.logs.slice(logsBefore);
        for (const line of newLogs) {
          expect(line).not.toContain(DISTINCTIVE_IP);
        }

        expect(unhandledRejections).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }

      // The outage ends: reconnect both clients and prove the process is
      // still serving, resolution and enqueue both recovering together.
      await Promise.all([harness.redis.connect(), queueClient.connect()]);

      const recovered = await requestSeededLink(harness.baseUrl);
      expect(recovered.status).toBe(307);
      expect(recovered.location).toBe(HARNESS_DESTINATION);

      const jobsAfterRecovery = await waitForMoreWaitingJobs(harness, jobsBefore);
      expect(jobsAfterRecovery).toBeGreaterThan(jobsBefore);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );
});
