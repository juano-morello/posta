import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { linkKey, links, newId, user } from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import { parseCachedLink, type CachedLink } from '@posta/contracts';
import {
  lookupCachedLink,
  resolveLink,
  resolveLinkFromDb,
  type LinkCacheRedis,
  type LinkCacheWriteRedis,
} from './resolve';
import { CONTAINER_TEST_TIMEOUT_MS, makeSpyLogger } from './resolve-test-support';

// The link lookup/backfill half of what was one file (resolve.test.ts)
// before it crossed this epic's 800-line cap — see resolve-tenant.test.ts
// for the handle→tenant ladder half, and resolve-test-support.ts for the
// fixtures (CONTAINER_TEST_TIMEOUT_MS, makeSpyLogger) both files share.

/** Mirrors packages/core/src/db/tenant.test.ts's own seedTenant() — a
 * `user` row doubling as tenant_id (invariant 9). No bio_pages row: the
 * link tier is reached only once a tenant_id is already known (the
 * handle→tenant ladder is resolve-tenant.test.ts's concern), so neither
 * describe block below needs one. Shared by both describe blocks in this
 * file rather than duplicated per block — each block still boots its OWN
 * Postgres container (unchanged from before this split), so `handle` is
 * a parameter here, not a variable this function closes over. */
async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

async function seedLink(
  handle: PgContainerHandle,
  tenantId: string,
  slug: string,
  destination: string,
  archivedAt?: Date,
): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({
    id: linkId,
    tenantId,
    slug,
    destination,
    ...(archivedAt ? { archivedAt } : {}),
  });
  return linkId;
}

describe('lookupCachedLink (T2.2.3)', () => {
  const wellFormedLink: CachedLink = {
    link_id: '01HXYZ0000000000000000001',
    tenant_id: '01HXYZ0000000000000000002',
    destination: 'https://x.com/promo',
  };

  it('a valid cached payload returns the parsed record as a hit', async () => {
    const redis: LinkCacheRedis = { get: async () => JSON.stringify(wellFormedLink) };
    const logger = makeSpyLogger();

    const result = await lookupCachedLink('tenant-1', 'promo', { redis, logger, timeoutMs: 1_000 });

    expect(result).toEqual({ kind: 'hit', link: wellFormedLink });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('an ordinary cache miss (no key) returns a miss without logging a warning', async () => {
    const redis: LinkCacheRedis = { get: async () => null };
    const logger = makeSpyLogger();

    const result = await lookupCachedLink('tenant-1', 'unknown-slug', {
      redis,
      logger,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ kind: 'miss' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('malformed JSON returns a miss and logs a warning, never throwing', async () => {
    const redis: LinkCacheRedis = { get: async () => 'not json {{{' };
    const logger = makeSpyLogger();

    const result = await lookupCachedLink('tenant-1', 'promo', { redis, logger, timeoutMs: 1_000 });

    expect(result).toEqual({ kind: 'miss' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('[security] a well-formed but schema-invalid payload (javascript: destination) returns a miss and logs a warning', async () => {
    const raw = JSON.stringify({ ...wellFormedLink, destination: 'javascript:alert(1)' });
    const redis: LinkCacheRedis = { get: async () => raw };
    const logger = makeSpyLogger();

    const result = await lookupCachedLink('tenant-1', 'promo', { redis, logger, timeoutMs: 1_000 });

    expect(result).toEqual({ kind: 'miss' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a GET that rejects returns a miss and logs a warning exactly once', async () => {
    const redis: LinkCacheRedis = {
      get: async () => {
        throw new Error('simulated Redis GET failure');
      },
    };
    const logger = makeSpyLogger();

    const result = await lookupCachedLink('tenant-1', 'promo', { redis, logger, timeoutMs: 1_000 });

    expect(result).toEqual({ kind: 'miss' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a GET that never settles returns a miss in under 50ms — the timeout, not the connection, decides', async () => {
    const redis: LinkCacheRedis = { get: () => new Promise(() => {}) };
    const logger = makeSpyLogger();

    const start = Date.now();
    const result = await lookupCachedLink('tenant-1', 'promo', { redis, logger, timeoutMs: 10 });
    const elapsedMs = Date.now() - start;

    expect(result).toEqual({ kind: 'miss' });
    expect(elapsedMs).toBeLessThan(50);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a timed-out GET that later rejects does not produce an unhandled rejection', async () => {
    let rejectLate: (error: Error) => void = () => {};
    const redis: LinkCacheRedis = {
      get: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    };
    const logger = makeSpyLogger();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const result = await lookupCachedLink('tenant-1', 'promo', { redis, logger, timeoutMs: 5 });
      expect(result).toEqual({ kind: 'miss' });

      // The GET settles AFTER the race already resolved to a timeout —
      // exactly the scenario the timeout wrapper's neutralising .catch()
      // exists for.
      rejectLate(new Error('late rejection, after the race already settled'));

      // Give Node's rejection tracking a few turns of the event loop to
      // surface an unhandledRejection, if the implementation failed to
      // neutralise the loser.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('resolveLinkFromDb (T2.2.4)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a live link resolves to its destination', async () => {
    const tenantId = await seedTenant(handle);
    const linkId = await seedLink(handle, tenantId, 'promo', 'https://example.test/promo');

    const result = await resolveLinkFromDb(tenantId, 'promo', { db: handle.db });

    expect(result).toEqual({
      link_id: linkId,
      tenant_id: tenantId,
      destination: 'https://example.test/promo',
    });
  });

  it('an archived link resolves to null, never its old destination', async () => {
    const tenantId = await seedTenant(handle);
    await seedLink(handle, tenantId, 'archived-promo', 'https://example.test/old', new Date());

    const result = await resolveLinkFromDb(tenantId, 'archived-promo', { db: handle.db });

    expect(result).toBeNull();
  });

  it('an unknown slug returns null', async () => {
    const tenantId = await seedTenant(handle);

    const result = await resolveLinkFromDb(tenantId, 'never-created', { db: handle.db });

    expect(result).toBeNull();
  });

  it('a slug that exists for a different tenant returns null (isolation, stated from the other direction)', async () => {
    const tenantA = await seedTenant(handle);
    const tenantB = await seedTenant(handle);
    await seedLink(handle, tenantA, 'only-in-a', 'https://example.test/a');

    const result = await resolveLinkFromDb(tenantB, 'only-in-a', { db: handle.db });

    expect(result).toBeNull();
  });

  it("[security] tenant A's slug is invisible to tenant B — same slug, colliding on purpose, different destinations", async () => {
    const tenantA = await seedTenant(handle);
    const tenantB = await seedTenant(handle);
    await seedLink(handle, tenantA, 'promo', 'https://example.test/a');
    await seedLink(handle, tenantB, 'promo', 'https://example.test/b');

    const resultA = await resolveLinkFromDb(tenantA, 'promo', { db: handle.db });
    const resultB = await resolveLinkFromDb(tenantB, 'promo', { db: handle.db });

    expect(resultA?.destination).toBe('https://example.test/a');
    expect(resultB?.destination).toBe('https://example.test/b');
    expect(resultA?.tenant_id).toBe(tenantA);
    expect(resultB?.tenant_id).toBe(tenantB);
    // Stated the other way too: neither tenant's result is ever the other's.
    expect(resultA?.destination).not.toBe(resultB?.destination);
  });
});

// T2.2.5 — resolveLink is the composition S2.2's own acceptance criteria
// describe directly ("Miss -> Postgres -> SETEX backfill, TTL 1h" / "a
// second request issues zero Postgres queries"): lookupCachedLink
// (T2.2.3), then on a miss resolveLinkFromDb (T2.2.4), then on a Postgres
// HIT a fire-and-forget SETEX backfill so the NEXT request for the same
// slug is served straight out of Redis. Deliberately does NOT write a
// tombstone on a Postgres miss — that negative-cache behavior is T2.2.6's
// job, dispatched separately; a miss here is exactly resolveLinkFromDb's
// own `null`, unchanged.
describe('resolveLink (T2.2.5)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  const LINK_REDIS_TIMEOUT_MS = 1_000;
  // Mirrors LINK_CACHE_TTL_SECONDS's default (.env.example / apps/api/src/env.ts) —
  // resolveLink takes it as a deps field rather than hardcoding it, same
  // as REDIS_LOOKUP_TIMEOUT_MS above, so production wiring (main.ts,
  // outside this task's scope) is the only place the env var is read.
  const TEST_CACHE_TTL_SECONDS = 3600;

  /**
   * A recording double for LinkCacheWriteRedis (get + setex), backed by an
   * in-memory Map that setex actually writes into and get actually reads
   * from — so a cold resolveLink() call's backfill is visible to a WARM
   * second call, exactly like a real Redis instance, unlike
   * makeRecordingRedis's handle-cache sibling (resolve-tenant.test.ts,
   * T2.2.2) whose tests never depend on that read-your-own-write behavior.
   *
   * ⚠️ Real-Redis-TTL note (see T2.2.5's report for the full reasoning):
   * this codebase has no Redis testcontainer helper yet — that lands in
   * T2.6.1 — and that task's binding `files` line was resolve.ts/
   * resolve.test.ts only, not any package.json, so adding
   * @testcontainers/redis wasn't available without going outside that
   * scope. This double therefore stands in for a real Redis: TTL
   * assertions below check the EXACT `seconds` argument passed to
   * `setex`, not a live, decrementing `TTL key` read against a real
   * server. The brief's "TTL between 3590 and 3600" range assertion is
   * exactly that live-decrement check, and lands in T2.6.6 once the real
   * harness exists.
   */
  function makeRecordingLinkCacheRedis(): LinkCacheWriteRedis & {
    readonly getCalls: string[];
    readonly setexCalls: ReadonlyArray<{ key: string; seconds: number; value: string }>;
    failNextSetex(): void;
  } {
    const store = new Map<string, string>();
    const getCalls: string[] = [];
    const setexCalls: Array<{ key: string; seconds: number; value: string }> = [];
    let shouldFailNextSetex = false;

    return {
      getCalls,
      setexCalls,
      failNextSetex() {
        shouldFailNextSetex = true;
      },
      async get(key: string): Promise<string | null> {
        getCalls.push(key);
        return store.get(key) ?? null;
      },
      async setex(key: string, seconds: number, value: string): Promise<unknown> {
        setexCalls.push({ key, seconds, value });
        if (shouldFailNextSetex) {
          shouldFailNextSetex = false;
          throw new Error('simulated Redis SETEX failure');
        }
        store.set(key, value);
        return 'OK';
      },
    };
  }

  it('a resolution after a cache miss resolves from Postgres and backfills the cache with the configured TTL', async () => {
    const tenantId = await seedTenant(handle);
    const linkId = await seedLink(handle, tenantId, 'promo', 'https://example.test/promo');
    const expectedLink: CachedLink = {
      link_id: linkId,
      tenant_id: tenantId,
      destination: 'https://example.test/promo',
    };

    const redis = makeRecordingLinkCacheRedis();
    const logger = makeSpyLogger();

    const result = await resolveLink(tenantId, 'promo', {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });

    expect(result).toEqual(expectedLink);
    expect(redis.setexCalls).toEqual([
      {
        key: linkKey(tenantId, 'promo'),
        seconds: TEST_CACHE_TTL_SECONDS,
        value: JSON.stringify(expectedLink),
      },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('the written cache value round-trips through parseCachedLink to an equal record (writer/reader anti-drift check)', async () => {
    const tenantId = await seedTenant(handle);
    const linkId = await seedLink(handle, tenantId, 'round-trip', 'https://example.test/round-trip');
    const expectedLink: CachedLink = {
      link_id: linkId,
      tenant_id: tenantId,
      destination: 'https://example.test/round-trip',
    };

    const redis = makeRecordingLinkCacheRedis();
    const logger = makeSpyLogger();

    await resolveLink(tenantId, 'round-trip', {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });

    const [written] = redis.setexCalls;
    expect(written).toBeDefined();
    // parseCachedLink is the SAME function lookupCachedLink uses to read
    // this key back — round-tripping through it here (rather than just
    // re-asserting JSON.stringify equality above) is what would catch the
    // writer and the reader drifting apart from each other.
    expect(parseCachedLink(written!.value)).toEqual(expectedLink);
  });

  it('a second request for the same slug is served from the cache and issues zero Postgres queries', async () => {
    const tenantId = await seedTenant(handle);
    await seedLink(handle, tenantId, 'warm-slug', 'https://example.test/warm');

    const redis = makeRecordingLinkCacheRedis();
    const logger = makeSpyLogger();
    const deps = {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    };

    const first = await resolveLink(tenantId, 'warm-slug', deps); // cold: backfills the cache

    const querySpy = vi.spyOn(handle.pool, 'query');
    const second = await resolveLink(tenantId, 'warm-slug', deps);

    expect(second).toEqual(first);
    expect(querySpy).not.toHaveBeenCalled();
    // The cache-hit branch never re-backfills an already-cached value.
    expect(redis.setexCalls).toHaveLength(1);

    querySpy.mockRestore();
  });

  it('a wedged Redis SETEX backfill (never settles) does not block resolveLink — the write is fire-and-forget, not awaited', async () => {
    const tenantId = await seedTenant(handle);
    const linkId = await seedLink(
      handle,
      tenantId,
      'wedged-setex-slug',
      'https://example.test/wedged-setex',
    );
    const expectedLink: CachedLink = {
      link_id: linkId,
      tenant_id: tenantId,
      destination: 'https://example.test/wedged-setex',
    };

    const getCalls: string[] = [];
    // A half-open socket on the BACKFILL write, not the read: the lookup
    // already succeeded (Postgres answered), so this proves resolveLink
    // itself never awaits backfillLinkCache — mirrors the handle tier's
    // identical [R11] wedge test in resolve-tenant.test.ts. If
    // `void backfillLinkCache(...)` at the resolveLink call site were
    // ever changed to `await backfillLinkCache(...)`, this test is the
    // one that would catch it: it would time out waiting on a promise
    // that never settles, instead of returning near-instantly. (Verified
    // by temporarily making that exact change during T2.2.5's fix round —
    // this test went RED with a 5000ms timeout, then GREEN again once the
    // `await` was reverted to `void`; see the fix report.)
    const wedgedRedis: LinkCacheWriteRedis = {
      async get(key) {
        getCalls.push(key);
        return null; // ordinary miss — falls through to Postgres, then to the wedged SETEX below
      },
      setex: () => new Promise(() => {}),
    };
    const logger = makeSpyLogger();

    const start = Date.now();
    const result = await resolveLink(tenantId, 'wedged-setex-slug', {
      db: handle.db,
      redis: wedgedRedis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });
    const elapsedMs = Date.now() - start;

    expect(result).toEqual(expectedLink);
    expect(elapsedMs).toBeLessThan(50);
    expect(getCalls).toEqual([linkKey(tenantId, 'wedged-setex-slug')]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a slug missing from both the cache and Postgres resolves to null and writes no tombstone (T2.2.6 is a separate task)', async () => {
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
    expect(redis.setexCalls).toEqual([]);
  });

  it('a rejecting SETEX still returns the destination, logging exactly one warning', async () => {
    const tenantId = await seedTenant(handle);
    const linkId = await seedLink(handle, tenantId, 'setex-fails', 'https://example.test/setex-fails');
    const expectedLink: CachedLink = {
      link_id: linkId,
      tenant_id: tenantId,
      destination: 'https://example.test/setex-fails',
    };

    const redis = makeRecordingLinkCacheRedis();
    redis.failNextSetex();
    const logger = makeSpyLogger();

    const result = await resolveLink(tenantId, 'setex-fails', {
      db: handle.db,
      redis,
      logger,
      timeoutMs: LINK_REDIS_TIMEOUT_MS,
      cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
    });

    // Invariant: the destination resolved from Postgres is returned
    // regardless of whether the backfill write succeeded.
    expect(result).toEqual(expectedLink);

    // The backfill is fire-and-forget: resolveLink never awaits it, so its
    // rejection is caught on a LATER microtask than the one that resolves
    // resolveLink's own promise. Flush one macrotask rather than depend on
    // exact microtask-hop ordering (same pattern as the handle-tier R11
    // test in resolve-tenant.test.ts and this file's own
    // unhandledRejection test above).
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a rejecting SETEX does not produce an unhandled rejection', async () => {
    const tenantId = await seedTenant(handle);
    await seedLink(handle, tenantId, 'unhandled-check', 'https://example.test/unhandled-check');

    const redis = makeRecordingLinkCacheRedis();
    redis.failNextSetex();
    const logger = makeSpyLogger();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      await resolveLink(tenantId, 'unhandled-check', {
        db: handle.db,
        redis,
        logger,
        timeoutMs: LINK_REDIS_TIMEOUT_MS,
        cacheTtlSeconds: TEST_CACHE_TTL_SECONDS,
      });

      // Give Node's rejection tracking a few turns of the event loop to
      // surface an unhandledRejection, if backfillLinkCache failed to
      // handle the rejected setex internally.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
