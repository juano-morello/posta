import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { linkKey } from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CachedLink } from '@posta/contracts';
import {
  LINK_TOMBSTONE,
  LINK_TOMBSTONE_TTL_SECONDS,
  lookupCachedLink,
  resolveLink,
  type LinkCacheRedis,
  type LinkCacheWriteRedis,
} from './resolve-link';
import {
  CONTAINER_TEST_TIMEOUT_MS,
  LINK_REDIS_TIMEOUT_MS,
  makeRecordingLinkCacheRedis,
  makeSpyLogger,
  seedLink,
  seedTenant,
  TEST_CACHE_TTL_SECONDS,
} from './resolve-test-support';

// T2.2.6's negative-cache tests — split out of resolve-link.test.ts (the
// T2.2.3/T2.2.4/T2.2.5 positive-path half) once that file crossed this
// epic's 800-line cap for a second time (T2.2.6's fix round 1; the first
// split, resolve.test.ts -> resolve-tenant.test.ts / resolve-link.test.ts
// / resolve-test-support.ts, was T2.2.5's fix round 1). Shares
// resolve-test-support.ts's seedTenant / seedLink / makeRecordingLinkCacheRedis
// / LINK_REDIS_TIMEOUT_MS / TEST_CACHE_TTL_SECONDS with resolve-link.test.ts
// rather than duplicating them here.

describe('lookupCachedLink — negative cache (T2.2.6)', () => {
  it('the negative-cache tombstone returns known-absent and logs zero warnings', async () => {
    // Checked BEFORE parseCachedLink, per decision 2 of this task: a
    // tombstone is a POSITIVE cached fact, not corrupt data, so it must
    // never take the "failed to parse" warn path below — under a
    // sustained scan that would fire a warn on every single probe once
    // the tombstone takes hold, turning the defence into a log-flood
    // amplifier.
    const redis: LinkCacheRedis = { get: async () => LINK_TOMBSTONE };
    const logger = makeSpyLogger();

    const result = await lookupCachedLink('tenant-1', 'scanned-slug', {
      redis,
      logger,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ kind: 'known-absent' });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('resolveLink — negative cache (T2.2.6)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a slug missing from both the cache and Postgres resolves to null and writes a tombstone', async () => {
    const tenantId = await seedTenant(handle);

    const redis = makeRecordingLinkCacheRedis();
    const logger = makeSpyLogger();

    const result = await resolveLink(tenantId, 'never-created', {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });

    expect(result).toBeNull();
    expect(redis.setexCalls).toEqual([
      { key: linkKey(tenantId, 'never-created'), seconds: LINK_TOMBSTONE_TTL_SECONDS, value: LINK_TOMBSTONE },
    ]);
  });

  it('100 requests for an unknown slug produce exactly one Postgres query', async () => {
    const tenantId = await seedTenant(handle);
    const redis = makeRecordingLinkCacheRedis();
    const logger = makeSpyLogger();
    const deps = {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    };
    const REQUEST_COUNT = 100;

    const querySpy = vi.spyOn(handle.pool, 'query');

    for (let i = 0; i < REQUEST_COUNT; i++) {
      const result = await resolveLink(tenantId, 'scanned-unknown-slug', deps);
      expect(result).toBeNull();
    }

    // Request #1 is the only one that ever reaches Postgres: it misses
    // both the cache and Postgres, then fire-and-forget writes the
    // tombstone. Requests #2-100 hit that tombstone in lookupCachedLink
    // (kind: 'known-absent') and short-circuit before resolveLink ever
    // calls resolveLinkFromDb again — this is the whole point of T2.2.6.
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(redis.setexCalls).toHaveLength(1);

    querySpy.mockRestore();
  });

  it("the tombstone's TTL is at most 60 seconds", async () => {
    const tenantId = await seedTenant(handle);
    const redis = makeRecordingLinkCacheRedis();
    const logger = makeSpyLogger();

    await resolveLink(tenantId, 'ttl-check-slug', {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });

    expect(redis.setexCalls).toEqual([
      { key: linkKey(tenantId, 'ttl-check-slug'), seconds: LINK_TOMBSTONE_TTL_SECONDS, value: LINK_TOMBSTONE },
    ]);
    expect(LINK_TOMBSTONE_TTL_SECONDS).toBeLessThanOrEqual(60);
  });

  it('creating the link after a tombstone and waiting out the TTL resolves it (a simulated clock, not fake timers or a real 60s sleep)', async () => {
    const tenantId = await seedTenant(handle);
    // [T2.2.6 fix round 1] A plain, test-controlled clock passed into the
    // recording double — NOT vi.useFakeTimers() — so real timers run
    // throughout this entire test, including the real Postgres INSERT
    // below. An earlier version of this test wrapped the second
    // resolveLink() call in vi.useFakeTimers()/advanceTimersByTime(),
    // which a reviewer flagged as fragile: this codebase's own
    // resolve-tenant.test.ts (the memo-expiry test) carries an explicit
    // warning that fake timers must never be active during real Postgres
    // I/O, and restoring real timers first doesn't fix it either —
    // vi.useRealTimers() reverts Date.now() to the actual wall clock,
    // undoing the very time advance the tombstone-expiry check needs.
    // Injecting the double's own "now" sidesteps the conflict entirely.
    let simulatedNowMs = Date.now();
    const redis = makeRecordingLinkCacheRedis(() => simulatedNowMs);
    const logger = makeSpyLogger();
    const deps = {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    };

    const before = await resolveLink(tenantId, 'not-yet-created', deps);
    expect(before).toBeNull();

    const linkId = await seedLink(handle, tenantId, 'not-yet-created', 'https://example.test/now-live');

    simulatedNowMs += (LINK_TOMBSTONE_TTL_SECONDS + 1) * 1000;

    const after = await resolveLink(tenantId, 'not-yet-created', deps);

    expect(after).toEqual({
      link_id: linkId,
      tenant_id: tenantId,
      destination: 'https://example.test/now-live',
    });
  });

  it('a Redis GET timeout does not tombstone a link that genuinely exists', async () => {
    const tenantId = await seedTenant(handle);
    const linkId = await seedLink(handle, tenantId, 'redis-hiccup', 'https://example.test/redis-hiccup');
    const expectedLink: CachedLink = {
      link_id: linkId,
      tenant_id: tenantId,
      destination: 'https://example.test/redis-hiccup',
    };

    const setexCalls: Array<{ key: string; seconds: number; value: string }> = [];
    // A half-open socket on the READ, not the write: this is the "a
    // Redis timeout does not write a tombstone" case from this task's
    // brief, read literally — a transient Redis hiccup during the GET
    // must never cause a REAL link to be falsely tombstoned as absent.
    // resolveLinkFromDb's own Postgres query is untouched by this and
    // still finds the link, so only the ordinary positive backfill
    // (T2.2.5) should ever be written here.
    const wedgedGetRedis: LinkCacheWriteRedis = {
      get: () => new Promise(() => {}),
      async setex(key, seconds, value) {
        setexCalls.push({ key, seconds, value });
        return 'OK';
      },
    };
    const logger = makeSpyLogger();

    const result = await resolveLink(tenantId, 'redis-hiccup', {
      db: handle.db,
      redis: wedgedGetRedis,
      logger,
      timeoutMs: 10,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });

    expect(result).toEqual(expectedLink);
    expect(setexCalls).toEqual([
      {
        key: linkKey(tenantId, 'redis-hiccup'),
        seconds: TEST_CACHE_TTL_SECONDS,
        value: JSON.stringify(expectedLink),
      },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1); // the GET-timeout warn from lookupCachedLink
  });

  it('a Postgres error propagates and writes no tombstone (a query failure means "we do not know", not "confirmed absent")', async () => {
    const tenantId = await seedTenant(handle);
    const redis = makeRecordingLinkCacheRedis();
    const logger = makeSpyLogger();

    const querySpy = vi
      .spyOn(handle.pool, 'query')
      .mockRejectedValueOnce(new Error('simulated Postgres failure'));

    try {
      let caught: unknown;
      try {
        await resolveLink(tenantId, 'pg-error-slug', {
          db: handle.db,
          redis,
          logger,
          timeoutMs: LINK_REDIS_TIMEOUT_MS,
          cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
        });
      } catch (error) {
        caught = error;
      }

      // drizzle-orm's node-postgres driver wraps every query failure in
      // its own DrizzleQueryError; the raw error we injected is its
      // `.cause`, not the top-level thrown error's own message (mirrors
      // packages/core/src/schema/links.test.ts's identical pgErrorCode
      // pattern for the real SQLSTATE case).
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error & { cause?: Error }).cause?.message).toBe('simulated Postgres failure');

      // resolveLinkFromDb never returned — it threw — so resolveLink's
      // tombstone-write branch (which only runs on a returned `null`)
      // never executes. Caching "absent" off a query failure would turn
      // a transient Postgres outage into LINK_TOMBSTONE_TTL_SECONDS of
      // confirmed-wrong 404s for a link that may well exist.
      expect(redis.setexCalls).toEqual([]);
    } finally {
      querySpy.mockRestore();
    }
  });

  it('a rejecting tombstone write still returns null, logging exactly one warning', async () => {
    const tenantId = await seedTenant(handle);
    const redis = makeRecordingLinkCacheRedis();
    redis.failNextSetex();
    const logger = makeSpyLogger();

    const result = await resolveLink(tenantId, 'tombstone-write-fails', {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });

    expect(result).toBeNull();

    // The tombstone write is fire-and-forget — see resolve-link.test.ts's
    // own rejecting-SETEX backfill test for why this needs a flushed
    // macrotask, not a microtask-ordering assumption.
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a rejecting tombstone write does not produce an unhandled rejection', async () => {
    const tenantId = await seedTenant(handle);
    const redis = makeRecordingLinkCacheRedis();
    redis.failNextSetex();
    const logger = makeSpyLogger();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const result = await resolveLink(tenantId, 'tombstone-unhandled-check', {
        db: handle.db,
        redis,
        logger,
        timeoutMs: LINK_REDIS_TIMEOUT_MS,
        cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
      });
      expect(result).toBeNull();

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
