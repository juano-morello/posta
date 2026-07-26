import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { linkKey } from '@posta/core';
import { CONTAINER_TEST_TIMEOUT_MS } from '../resolve-test-support';
import {
  HARNESS_DESTINATION,
  HARNESS_DOMAIN,
  HARNESS_HANDLE,
  HARNESS_SLUG,
  startHotPathHarness,
  type HotPathHarness,
} from './hot-path-harness';

// T2.6.9 [S2.6] — the hot path's own latency budget, measured against the
// SAME real production composition every other T2.6.x test in this
// directory boots (see hot-path-harness.ts's own header): real Postgres,
// real Redis, the real cache ladder (resolve-link.ts, T2.2.4-T2.2.6), the
// real BullMQ producer. Only the CLIENT side — the plain http.request
// timing loop below — is specific to this file; the harness itself needs
// no change (per this task's own brief: "purely a client-side timing loop
// against the already-running app").
//
// What "cache hit" means here, concretely: ONE deliberate warm-up request
// against the seeded link (a genuine cold miss + backfill, mirroring
// cache-backfill.test.ts's own warm-up), discarded from every percentile
// below, followed by MEASURED_REQUEST_COUNT more requests for the SAME
// slug — each of which resolve-link.ts's own cache ladder should serve
// entirely from Redis, zero Postgres queries. A `pool.query` spy across
// the measurement loop proves that directly rather than merely assuming
// it: if the warm-up's fire-and-forget SETEX hadn't actually landed yet
// (see waitForTtl below), or the cache ladder regressed, that would show
// up as a NON-zero query count, not just a slow p95.
//
// Sequential, not concurrent: the brief is explicit that this measures
// per-request SERVICE time on a single loopback connection, not queueing
// delay under concurrent load — `Promise.all` would measure a different,
// unrelated thing.
//
// This is loopback-only: it excludes the LATAM network leg the spec's own
// 15ms budget also covers. Passing here is necessary, not sufficient —
// the deploy-time check is a separate task (E10, per the plan doc).

/** Test-only knob, deliberately NOT part of apiEnvSchema (env.ts) — this
 * budget exists only so THIS test's own RED/GREEN proof can move it
 * without touching any production config surface. Defaults to the spec's
 * real 15ms budget when unset. */
const HOT_PATH_P95_BUDGET_MS = Number(process.env.HOT_PATH_P95_BUDGET_MS ?? '15');

const MEASURED_REQUEST_COUNT = 1000;

// Comfortably above the wall-clock cost of ~1000 real, sequential
// loopback round trips (each a few ms at most) — beforeAll's own
// container boot has its own, larger CONTAINER_TEST_TIMEOUT_MS budget.
const TEST_TIMEOUT_MS = 60_000;

interface TimedResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly durationMs: number;
}

/** A plain `http.request` against the seeded link, timed with
 * `performance.now()` (sub-millisecond resolution, unlike `Date.now()`)
 * from just before the request is issued to the response's own `end`
 * event — the same request shape as hot-path-harness.test.ts's own
 * requestSeededLink, with per-call wall-clock timing added. */
function requestSeededLinkTimed(baseUrl: string): Promise<TimedResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `/${HARNESS_SLUG}`,
        headers: { Host: `${HARNESS_HANDLE}.${HARNESS_DOMAIN}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            durationMs: performance.now() - startedAt,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Polls `redis.ttl(key)` until the seeded link's cache entry reports a
 * positive remaining TTL, or `deadlineMs` elapses — mirrors
 * cache-backfill.test.ts's own waitForTtl, for the identical reason:
 * backfillLinkCache's SETEX is fire-and-forget (resolve-link.ts), so the
 * warm-up request's HTTP response can land before its own cache write
 * has. Without waiting here, the very first "measured" request below
 * could race that write and land as a second genuine miss, corrupting
 * both the timing (a miss costs a real Postgres query) and the hit count
 * this test reports. */
async function waitForTtl(redis: Redis, key: string, deadlineMs = 5000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const ttl = await redis.ttl(key);
    if (ttl > 0 || Date.now() > deadline) return ttl;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Nearest-rank percentile over an ALREADY sorted (ascending) array:
 * `Math.ceil(sorted.length * p) - 1` — for p95 over 1000 samples that's
 * index 949, the 950th-smallest duration, i.e. the value at or below
 * which 95% of requests landed. `Math.floor` instead of `ceil - 1` would
 * shift the answer one sample toward p94.9 and understate the tail by one
 * position. Clamped to `[0, length - 1]` as a defensive bound, not because
 * p50/p95/p99 over 1000 samples can ever land outside it. The explicit
 * `undefined` check (rather than a non-null assertion) is only here to
 * satisfy `noUncheckedIndexedAccess` (tsconfig.base.json) — the clamp
 * above already guarantees `clampedIndex` is in range for any non-empty
 * input.
 */
function percentile(sortedAscendingMs: readonly number[], p: number): number {
  const index = Math.ceil(sortedAscendingMs.length * p) - 1;
  const clampedIndex = Math.min(Math.max(index, 0), sortedAscendingMs.length - 1);
  const value = sortedAscendingMs[clampedIndex];
  if (value === undefined) {
    throw new Error(`percentile: no sample at index ${clampedIndex} (length ${sortedAscendingMs.length})`);
  }
  return value;
}

describe('redirect hot path latency budget (T2.6.9)', () => {
  let harness: HotPathHarness;

  beforeAll(async () => {
    harness = await startHotPathHarness();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    `p95 stays under HOT_PATH_P95_BUDGET_MS (currently ${HOT_PATH_P95_BUDGET_MS}ms) once the cache is warm`,
    async () => {
      // Warm-up: one deliberate cold miss + backfill against the seeded
      // link, discarded from every percentile below — see this file's own
      // header for why.
      const warmUp = await requestSeededLinkTimed(harness.baseUrl);
      expect(warmUp.status).toBe(307);
      expect(warmUp.location).toBe(HARNESS_DESTINATION);

      const cacheKey = linkKey(harness.tenantId, HARNESS_SLUG);
      const ttlAfterWarmUp = await waitForTtl(harness.redis, cacheKey);
      expect(ttlAfterWarmUp).toBeGreaterThan(0);

      // Spied AFTER the warm-up's own (real, expected) Postgres query, so
      // this only counts queries issued during the MEASURED requests below
      // — proving every one of them is a genuine Redis hit, not merely
      // assuming it.
      const querySpy = vi.spyOn(harness.pool, 'query');

      const durationsMs: number[] = [];
      // Sequential — see this file's own header for why NOT Promise.all.
      for (let i = 0; i < MEASURED_REQUEST_COUNT; i++) {
        const response = await requestSeededLinkTimed(harness.baseUrl);
        expect(response.status).toBe(307);
        expect(response.location).toBe(HARNESS_DESTINATION);
        durationsMs.push(response.durationMs);
      }

      const postgresQueriesDuringMeasurement = querySpy.mock.calls.length;
      querySpy.mockRestore();
      expect(postgresQueriesDuringMeasurement).toBe(0);

      const sortedMs = [...durationsMs].sort((a, b) => a - b);
      const p50 = percentile(sortedMs, 0.5);
      const p95 = percentile(sortedMs, 0.95);
      const p99 = percentile(sortedMs, 0.99);

      const missCount = 1; // the warm-up request above
      const hitCount = MEASURED_REQUEST_COUNT; // proven by the zero-query assertion above

      console.log(
        `[T2.6.9] redirect hot path (cache-hit) latency over ${MEASURED_REQUEST_COUNT} requests: ` +
          `p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms | ` +
          `miss=${missCount} hit=${hitCount} | budget(HOT_PATH_P95_BUDGET_MS)=${HOT_PATH_P95_BUDGET_MS}ms`,
      );

      expect(p95).toBeLessThan(HOT_PATH_P95_BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );
});
