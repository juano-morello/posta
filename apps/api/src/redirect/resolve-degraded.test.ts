import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { createRedisClient, linkKey } from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
  type RedisContainerHandle,
} from '@posta/core/testing';
import type { CachedLink } from '@posta/contracts';
import { resolveLink } from './resolve-link';
import {
  CONTAINER_TEST_TIMEOUT_MS,
  TEST_CACHE_TTL_SECONDS,
  makeSpyLogger,
  seedLink,
  seedTenant,
} from './resolve-test-support';

// T2.2.8 — S2.2's own acceptance criterion: "Redis unavailable -> fall
// through to Postgres and still serve; log, do not throw." Proved here
// against REAL containers (both Postgres and Redis), never a stub: a stub
// that rejects instantly is a different failure mode from a real ioredis
// client whose server vanished mid-connection, and it is exactly that
// second failure mode invariant 1 exists to survive.
//
// [Controller ruling — read this before reading "asserts requests keep
// serving 307s" anywhere else this task is described] Nothing wires
// resolveLink into the redirect middleware yet (S2.4's job), the 307
// status itself doesn't exist on this path until T2.4.1, and the
// HTTP-level app-boot harness plus its own outage assertions are T2.6.1 /
// T2.6.2. So this file deliberately tests resolveLink (and its Postgres
// fallback) directly, at the resolution layer S2.2's acceptance criteria
// are actually stated at — not against HTTP. The missing 307 here is not
// a spec gap; it is S2.6's test to write, once the pieces this depends on
// exist.
//
// Structure, per this task's brief: testcontainers cannot cleanly
// "restart" a stopped container on the same port, so this is ONE test in
// three phases, sharing one seeded tenant/link throughout —
//   1. Healthy — warm the cache, prove it is actually warm.
//   2. Outage  — kill the Redis container out from under a REAL client,
//      then prove a batch of resolutions all stay correct, non-throwing,
//      bounded in latency, and each logs a degraded-lookup warning.
//   3. Recovery — a brand-new Redis container (the old one cannot be
//      restarted), and proof the cache actually repopulates.
//
// No production code changes: if this task had needed one to be
// testable, the brief asked for that to be reported as a finding instead
// of made — see this task's report for whether that came up.

const OUTAGE_BATCH_SIZE = 20; // mirrors the brief's own "20 requests" batch size

// Short and deliberately injected (per the brief: 30-50ms), NOT the
// production REDIS_LOOKUP_TIMEOUT_MS default (30ms in .env.example, but
// wired through main.ts, out of this test's reach) — short enough that
// the outage phase runs fast and the latency assertion below is actually
// meaningful, rather than generous enough to hide a regression.
const DEGRADED_TIMEOUT_MS = 40;

// A sane multiple of DEGRADED_TIMEOUT_MS (~12x), not a copy of it: a
// healthy per-call cost during the outage is the timeout bound itself
// (worst case) plus a real Postgres round trip plus ordinary CI
// scheduling jitter — all of that comfortably fits well under 500ms. What
// this bound is actually guarding against is the failure this whole task
// exists to catch: a wedged Redis call costing the OS's own TCP
// timeout (seconds to minutes), which would blow through this by 1-2
// orders of magnitude, not by a few multiples.
const MAX_RESOLUTION_LATENCY_MS = 500;

/**
 * Connects a SEPARATE ioredis client to the outage-phase container,
 * deliberately NOT `redisHandle.client` itself (the handle
 * {@link startRedisContainer} returns), whose OWN internal client is what
 * `redisHandle.stop()` gracefully `quit()`s before removing the
 * container. A gracefully-quit client rejects its very next command
 * near-instantly ("Connection is closed."), which would make the latency
 * assertion below trivially true regardless of whether withRedisTimeout
 * is doing any work at all. This client is never quit by this test —
 * its server simply disappears out from under it when the container
 * stops, matching the brief's "a genuinely vanished server, not a stub
 * that rejects" framing.
 *
 * `lazyConnect` + an explicit `connect()` mirrors redis-container.ts's
 * own reasoning: without it, the very first command in the healthy phase
 * could race the socket handshake.
 */
async function connectDegradedClient(url: string): Promise<Redis> {
  const client = createRedisClient({ url, lazyConnect: true });
  await client.connect();
  // Once the container is stopped, ioredis's own automatic reconnect
  // attempts keep firing 'error' events against a server that no longer
  // exists. Redis (an EventEmitter) throws if an 'error' event has no
  // listener at all — this no-op keeps that background noise from
  // crashing the test process. The resilience under test is resolveLink's
  // fallback behaviour, not this raw client's own reconnect bookkeeping.
  client.on('error', () => {});
  return client;
}

/**
 * Flushes two macrotask turns so a resolveLink call's UNAWAITED
 * fire-and-forget writes (backfillLinkCache / writeLinkTombstone) get a
 * chance to settle before the next assertion depends on their side
 * effects — same double-setImmediate pattern resolve-link.test.ts and
 * resolve-tenant.test.ts already use for the identical reason.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('resolveLink stays available through a real Redis outage (T2.2.8)', () => {
  let pgHandle: PgContainerHandle;

  beforeAll(async () => {
    pgHandle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pgHandle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    'keeps resolving the correct destination from Postgres when Redis is truly down, with bounded per-call latency, a warning per degraded lookup, and zero unhandled rejections — then repopulates the cache once Redis recovers',
    async () => {
      const tenantId = await seedTenant(pgHandle);
      const linkId = await seedLink(pgHandle, tenantId, 'promo', 'https://example.test/promo');
      const expectedLink: CachedLink = {
        link_id: linkId,
        tenant_id: tenantId,
        destination: 'https://example.test/promo',
      };

      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      let redisHandle: RedisContainerHandle | undefined;
      let degradedClient: Redis | undefined;
      let recoveryHandle: RedisContainerHandle | undefined;

      try {
        redisHandle = await startRedisContainer();
        degradedClient = await connectDegradedClient(redisHandle.url);

        const logger = makeSpyLogger();
        const degradedDeps = {
          db: pgHandle.db,
          redis: degradedClient,
          logger,
          timeoutMs: DEGRADED_TIMEOUT_MS,
          cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
        };

        // ---- Phase 1: healthy — warm the cache, then prove it is warm ----
        const warmed = await resolveLink(tenantId, 'promo', degradedDeps);
        expect(warmed).toEqual(expectedLink);
        await flushMicrotasks(); // let the fire-and-forget SETEX backfill land

        const warmQuerySpy = vi.spyOn(pgHandle.pool, 'query');
        const stillWarm = await resolveLink(tenantId, 'promo', degradedDeps);
        expect(stillWarm).toEqual(expectedLink);
        expect(warmQuerySpy).not.toHaveBeenCalled();
        warmQuerySpy.mockRestore();
        expect(logger.warn).not.toHaveBeenCalled();

        // ---- Phase 2: outage — a genuinely vanished server, not a stub ----
        await redisHandle.stop();
        redisHandle = undefined; // already stopped; do not stop it again in `finally`

        const elapsedMsPerCall: number[] = [];
        for (let i = 0; i < OUTAGE_BATCH_SIZE; i += 1) {
          const startedAt = Date.now();
          const result = await resolveLink(tenantId, 'promo', degradedDeps);
          elapsedMsPerCall.push(Date.now() - startedAt);
          // Every one of the 20 resolutions still returns the correct
          // destination, resolved from Postgres — the cached copy died
          // with the container, so every one of these is a genuine
          // Postgres fallback, not a lingering cache hit.
          expect(result).toEqual(expectedLink);
        }

        // Latency stays bounded — the part that matters most. A test that
        // only checked the return values above would pass even if every
        // call blocked for the OS's own TCP timeout, and that gap is what
        // this loop closes.
        //
        // [Honesty note, verified while writing this test by temporarily
        // bypassing withRedisTimeout entirely (`return operation;`, no
        // race) and re-running this exact file: it still passed. Locally,
        // testcontainers' `container.stop()` fully removes the container
        // before returning, so by the time this loop's GETs run, ioredis
        // has already noticed the dead connection and fails PATH via its
        // own `enableOfflineQueue: false` fast-reject
        // ("Stream isn't writeable...") well under this bound — it is not
        // waiting out withRedisTimeout's race in this exact scenario. This
        // assertion is therefore end-to-end (bounded latency against a
        // REAL dead server, however the fallback gets there), not a proof
        // that specifically the Promise.race branch fired; that unit-level
        // proof already exists in resolve-link.test.ts's "a GET that never
        // settles" case, against a stub built to actually hang. What DID
        // fail when reverted, on this same file: removing the try/catch
        // around the GET in lookupCachedLink (see this task's report).]
        for (const elapsedMs of elapsedMsPerCall) {
          expect(elapsedMs).toBeLessThan(MAX_RESOLUTION_LATENCY_MS);
        }

        await flushMicrotasks(); // let each call's fire-and-forget backfill attempt (also against the dead server) settle
        const warnCallsDuringOutage = logger.warn.mock.calls.length;
        // One warning is GUARANTEED per call, from lookupCachedLink's own
        // degraded GET (synchronous with the await, so always landed by
        // now). A SECOND, fire-and-forget warning MAY also land per call,
        // from backfillLinkCache's own SETEX failing against the same
        // dead server — its timing isn't guaranteed relative to the loop
        // above, which is why this is a range tied to the call count
        // (per the brief: "relates to the number of calls", not merely
        // "at least one"), not an exact guess at interleaving.
        expect(warnCallsDuringOutage).toBeGreaterThanOrEqual(OUTAGE_BATCH_SIZE);
        expect(warnCallsDuringOutage).toBeLessThanOrEqual(OUTAGE_BATCH_SIZE * 2);

        degradedClient.disconnect();
        degradedClient = undefined;
        await flushMicrotasks();

        // ---- Phase 3: recovery — a brand-new container, a fresh client ----
        recoveryHandle = await startRedisContainer();
        const recoveryLogger = makeSpyLogger();
        const recoveryDeps = {
          db: pgHandle.db,
          redis: recoveryHandle.client,
          logger: recoveryLogger,
          timeoutMs: DEGRADED_TIMEOUT_MS,
          cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
        };

        const recovered = await resolveLink(tenantId, 'promo', recoveryDeps);
        expect(recovered).toEqual(expectedLink);
        await flushMicrotasks(); // let the fire-and-forget SETEX backfill land on the NEW container

        const cachedTtlSeconds = await recoveryHandle.client.ttl(linkKey(tenantId, 'promo'));
        // A positive TTL is only possible if the backfill's SETEX actually
        // ran against the new container — a key that was never written
        // reports -2 (missing), one written with no TTL reports -1.
        expect(cachedTtlSeconds).toBeGreaterThan(0);

        const recoveryQuerySpy = vi.spyOn(pgHandle.pool, 'query');
        const recoveredAgain = await resolveLink(tenantId, 'promo', recoveryDeps);
        expect(recoveredAgain).toEqual(expectedLink);
        expect(recoveryQuerySpy).not.toHaveBeenCalled();
        recoveryQuerySpy.mockRestore();

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        degradedClient?.disconnect();
        await redisHandle?.stop();
        await recoveryHandle?.stop();
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );
});
