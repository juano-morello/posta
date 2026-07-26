import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

// T2.6.6 — proves the cache-miss ladder resolve-link.ts implements
// (T2.2.4/T2.2.5/T2.2.6) end to end, against the REAL production
// composition the T2.6.1 harness boots: a cold miss costs exactly one
// Postgres query and leaves a live, near-3600s-TTL cache entry behind; a
// warm second request for the SAME slug costs zero. The negative-cache
// half is the mirror image: an unknown slug costs one Postgres query
// total across 50 requests, guarded by a <=60s tombstone.
//
// Deliberately requests over real HTTP against harness.baseUrl (mirrors
// hot-path-harness.test.ts's own requestSeededLink), not a direct call
// into resolveLink() the way resolve-link.test.ts/resolve-link-tombstone.test.ts
// do: those files already cover resolveLink in isolation with a recording
// Redis double (resolve-test-support.ts's makeRecordingLinkCacheRedis).
// This file's job is different — proving the SAME behavior holds through
// the real middleware, a real ioredis client, and real testcontainers
// Postgres, with a REAL, live-decrementing TTL read back off Redis
// itself, which a recording double can only simulate.

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
}

/** A plain `http.request` against `baseUrl` for an arbitrary slug, with
 * the seeded handle's own Host header set — same shape as
 * hot-path-harness.test.ts's own requestSeededLink, generalized to take
 * the slug as a parameter since this file also requests a slug that was
 * never seeded (the negative-cache half). */
function requestSlug(baseUrl: string, slug: string): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `/${slug}`,
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

/** Polls `redis.ttl(key)` until it reports a positive remaining TTL, or
 * `deadlineMs` elapses. Needed because BOTH backfillLinkCache and
 * writeLinkTombstone (resolve-link.ts) are explicitly fire-and-forget
 * (`void`ed, never awaited by the response path — see each function's
 * own doc comment) so the HTTP response this test just read can complete
 * before the SETEX behind it has actually landed in Redis. Same
 * reasoning, same shape, as hot-path-harness.test.ts's own
 * waitForWaitingJobs polling a real, async BullMQ enqueue for the
 * identical reason. Returns whatever the last read was (including a
 * non-positive one on timeout) rather than throwing, so a broken
 * backfill/tombstone fails at the assertion that actually names what's
 * missing, not inside this helper.
 */
async function waitForTtl(redis: Redis, key: string, deadlineMs = 5000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const ttl = await redis.ttl(key);
    if (ttl > 0 || Date.now() > deadline) return ttl;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const UNKNOWN_SLUG = 'nonexistent-slug-xyz';
const NEGATIVE_CACHE_REQUEST_COUNT = 50;

// Explicit per-test timeout, comfortably above waitForTtl's own 5000ms
// default polling deadline: without this, Vitest's own 5000ms default
// test timeout races waitForTtl's internal one and can trip FIRST,
// turning a genuine "the backfill/tombstone never landed" failure into
// an opaque "Test timed out" instead of the specific, readable assertion
// each test below actually names.
const TEST_TIMEOUT_MS = 15_000;

describe('cache miss backfills and the second request is a hit (T2.6.6)', () => {
  let harness: HotPathHarness;

  // Unconditional, regardless of whether a test's own assertions threw
  // before reaching its own `querySpy.mockRestore()` call below: without
  // this, a FAILING first test leaves its `vi.spyOn(harness.pool,
  // 'query')` spy active — `harness.pool` is the SAME real `pg` Pool for
  // the whole file (one harness, one beforeAll) — and the second test's
  // own `vi.spyOn` on that already-spied method returns the SAME mock
  // instance, call count and all, rather than a fresh one. That is a real
  // test-isolation gap, not a hypothetical one: it is exactly what turned
  // this file's own negative-cache test from "1 query" into a spurious
  // "2 queries" the one time the positive-cache test above it failed
  // first (an earlier draft of this file, T2.6.6's own RED-proof run,
  // caught it).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    harness = await startHotPathHarness();

    // Warm resolveTenant's own in-process memo (resolve-tenant.ts,
    // T2.2.2, 60s TTL) for HARNESS_HANDLE before either test below ever
    // touches Redis. That memo lives in the closure createResolveTenant
    // builds once at boot (see hot-path-harness.ts) — it is NOT Redis, so
    // `harness.redis.flushall()` inside a test never evicts it. Without
    // this warm-up, the very FIRST request this file ever makes would
    // cost TWO Postgres queries (the handle→tenant lookup, T2.2.2, AND
    // the slug→link lookup this file actually measures), not the ONE this
    // task's own brief asserts on — the handle tier is a real, separate
    // concern this file isn't testing (resolve-tenant.test.ts already
    // covers it), so both tests below prime it out of the count exactly
    // once, up front, the same way a real deployment already has it warm
    // long before any one slug's own cache entry goes cold.
    await requestSlug(harness.baseUrl, HARNESS_SLUG);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a cold miss costs one Postgres query and backfills a ~3600s cache entry; the warm second request costs zero and returns the same Location', async () => {
    await harness.redis.flushall();
    const key = linkKey(harness.tenantId, HARNESS_SLUG);
    const querySpy = vi.spyOn(harness.pool, 'query');

    const first = await requestSlug(harness.baseUrl, HARNESS_SLUG);
    expect(first.status).toBe(307);
    expect(first.headers.location).toBe(HARNESS_DESTINATION);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // The backfill SETEX is fire-and-forget — wait for it to actually
    // land before reading its TTL or issuing the second request, per
    // waitForTtl's own doc comment above.
    const ttlAfterFirst = await waitForTtl(harness.redis, key);
    expect(ttlAfterFirst).toBeGreaterThan(3500);
    expect(ttlAfterFirst).toBeLessThanOrEqual(3600);

    querySpy.mockClear();

    const second = await requestSlug(harness.baseUrl, HARNESS_SLUG);
    expect(second.status).toBe(307);
    expect(second.headers.location).toBe(first.headers.location);
    expect(querySpy).toHaveBeenCalledTimes(0);

    querySpy.mockRestore();
  }, TEST_TIMEOUT_MS);

  it('an unknown slug requested 50 times costs exactly one Postgres query and leaves a <=60s tombstone', async () => {
    await harness.redis.flushall();
    const key = linkKey(harness.tenantId, UNKNOWN_SLUG);
    const querySpy = vi.spyOn(harness.pool, 'query');

    const first = await requestSlug(harness.baseUrl, UNKNOWN_SLUG);
    expect(first.status).toBe(404);

    // The tombstone SETEX is fire-and-forget too — wait for it to land
    // before firing the remaining 49 requests, so this assertion measures
    // the steady state T2.2.6 actually guards (one Postgres query per
    // tombstone lifetime), not a race between this test's own requests.
    await waitForTtl(harness.redis, key);

    for (let i = 1; i < NEGATIVE_CACHE_REQUEST_COUNT; i++) {
      const response = await requestSlug(harness.baseUrl, UNKNOWN_SLUG);
      expect(response.status).toBe(404);
    }

    expect(querySpy).toHaveBeenCalledTimes(1);

    const finalTtl = await harness.redis.ttl(key);
    expect(finalTtl).toBeGreaterThan(0);
    expect(finalTtl).toBeLessThanOrEqual(60);

    querySpy.mockRestore();
  }, TEST_TIMEOUT_MS);
});
