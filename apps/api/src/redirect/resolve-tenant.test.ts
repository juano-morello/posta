import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bioPages, handleKey, newId, user } from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import {
  createResolveTenant,
  MEMO_TTL_MS,
  rememberInMemo,
  type HandleCacheRedis,
  type MemoEntry,
} from './resolve-tenant';
import { CONTAINER_TEST_TIMEOUT_MS, makeSpyLogger } from './resolve-test-support';

// The handle→tenant ladder half of what was one file (resolve.test.ts)
// before it crossed this epic's 800-line cap — see resolve-link.test.ts
// for the link lookup/backfill half, and resolve-test-support.ts for the
// fixtures (CONTAINER_TEST_TIMEOUT_MS, makeSpyLogger) both files share.

// T2.2.3 — createResolveTenant's deps now require `timeoutMs` (the
// REDIS_LOOKUP_TIMEOUT_MS-sourced bound applied to every Redis call in
// this file, including the handle tier's). The existing T2.2.2 tests
// below don't exercise timeout behavior themselves, so they share one
// generous constant — large enough to never fire against the in-memory
// recording double's effectively-instant calls, so it can't change any
// of those tests' outcomes.
const HANDLE_REDIS_TIMEOUT_MS = 1_000;

// T2.2.2 — resolveTenant(handle) is the root of every tenant scope
// downstream of it, so these tests exercise it against a REAL Postgres
// (via the shared testcontainers harness, T1.1.2) rather than a stub —
// the Postgres tier's correctness is exactly what a mocked db could paper
// over. The Redis tier's assertions are about call counts ("this call
// touched Redis/Postgres zero times"), so a recording double is the right
// tool there — see makeRecordingRedis below.
//
// ⚠️ Timeout gotcha (per this task's brief): apps/api's tests run under
// the ROOT vitest config's 'default' project, which does not raise
// hookTimeout — only packages/core's own project (vitest.config.ts) sets
// it to 120s. A cold testcontainers image pull blows the 10s default, so
// both hooks below pass an explicit third-argument timeout.

/**
 * A recording double for the minimal Redis surface resolveTenant needs
 * (HandleCacheRedis: get/setex) — an in-memory Map with no TTL
 * enforcement of its own (real Redis TTL behavior isn't the thing under
 * test here; call counts and values are). Records every call so tests can
 * assert "zero Redis commands" precisely, not "at least once".
 */
function makeRecordingRedis(): HandleCacheRedis & {
  readonly getCalls: string[];
  readonly setexCalls: ReadonlyArray<{ key: string; seconds: number; value: string }>;
  failNextGet(): void;
  failNextSetex(): void;
} {
  const store = new Map<string, string>();
  const getCalls: string[] = [];
  const setexCalls: Array<{ key: string; seconds: number; value: string }> = [];
  let shouldFailNextGet = false;
  let shouldFailNextSetex = false;

  return {
    getCalls,
    setexCalls,
    failNextGet() {
      shouldFailNextGet = true;
    },
    failNextSetex() {
      shouldFailNextSetex = true;
    },
    async get(key: string): Promise<string | null> {
      getCalls.push(key);
      if (shouldFailNextGet) {
        shouldFailNextGet = false;
        throw new Error('simulated Redis GET failure');
      }
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

describe('rememberInMemo — bounded FIFO eviction (T2.2.2)', () => {
  it('does not evict while under capacity', () => {
    const memo = new Map<string, MemoEntry>();

    rememberInMemo(memo, 'a', 'tenant-a', 3);
    rememberInMemo(memo, 'b', 'tenant-b', 3);

    expect([...memo.keys()]).toEqual(['a', 'b']);
  });

  it('evicts the OLDEST entry once at capacity, keeping the map bounded', () => {
    const memo = new Map<string, MemoEntry>();

    rememberInMemo(memo, 'a', 'tenant-a', 3);
    rememberInMemo(memo, 'b', 'tenant-b', 3);
    rememberInMemo(memo, 'c', 'tenant-c', 3);
    // At capacity (3/3) — writing a 4th distinct handle must evict 'a',
    // the oldest, rather than growing past the cap.
    rememberInMemo(memo, 'd', 'tenant-d', 3);

    expect(memo.size).toBe(3);
    expect(memo.has('a')).toBe(false);
    expect([...memo.keys()]).toEqual(['b', 'c', 'd']);
  });

  it('refreshing an EXISTING handle at capacity does not evict anything', () => {
    const memo = new Map<string, MemoEntry>();

    rememberInMemo(memo, 'a', 'tenant-a', 2);
    rememberInMemo(memo, 'b', 'tenant-b', 2);
    // 'a' already has an entry — this is a refresh, not a new key, so it
    // must not trigger eviction of 'b' (a naive `size >= max` check with
    // no `has()` guard would wrongly evict here even though the map
    // never actually grows).
    rememberInMemo(memo, 'a', 'tenant-a-updated', 2);

    expect(memo.size).toBe(2);
    expect(memo.get('a')?.tenantId).toBe('tenant-a-updated');
    expect(memo.has('b')).toBe(true);
  });
});

describe('createResolveTenant (T2.2.2)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  /** Seeds a tenant (a `user` row, doubling as tenant_id per invariant 9)
   * and one `bio_pages` row claiming `handleName`. Mirrors
   * tenant.test.ts's own seedTenant() — inserting directly into `user`/
   * `bio_pages` here (not through forTenant()) is test setup, exactly the
   * pattern tenant.test.ts's own beforeAll already establishes, and
   * *.test.ts files are excluded from T1.1.10's tenant-scope scanner. */
  async function seedBioPage(tenantId: string, handleName: string): Promise<void> {
    await handle.db.insert(user).values({
      id: tenantId,
      name: 'Test Tenant',
      email: `${tenantId.toLowerCase()}@example.test`,
    });
    await handle.db.insert(bioPages).values({
      id: newId(),
      tenantId,
      handle: handleName,
    });
  }

  it('a cold call queries Postgres exactly once and SETEXes the handle key with a 1h TTL', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'cold-handle');

    const redis = makeRecordingRedis();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    const querySpy = vi.spyOn(handle.pool, 'query');
    const result = await resolveTenant('cold-handle');

    expect(result).toBe(tenantId);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(redis.getCalls).toEqual([handleKey('cold-handle')]);
    expect(redis.setexCalls).toEqual([
      { key: handleKey('cold-handle'), seconds: 3600, value: tenantId },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();

    querySpy.mockRestore();
  });

  it('a second call within 60s issues zero Redis and zero Postgres commands (the memo hit)', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'warm-handle');

    const redis = makeRecordingRedis();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    await resolveTenant('warm-handle'); // cold call: warms the memo

    const querySpy = vi.spyOn(handle.pool, 'query');
    redis.getCalls.length = 0;
    (redis.setexCalls as { key: string; seconds: number; value: string }[]).length = 0;

    const result = await resolveTenant('warm-handle');

    expect(result).toBe(tenantId);
    expect(querySpy).not.toHaveBeenCalled();
    expect(redis.getCalls).toEqual([]);
    expect(redis.setexCalls).toEqual([]);

    querySpy.mockRestore();
  });

  it('an unknown handle resolves to null', async () => {
    const redis = makeRecordingRedis();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    const result = await resolveTenant('never-claimed-handle');

    expect(result).toBeNull();
  });

  it('an unknown handle is memoised too: a repeat call queries Postgres zero times', async () => {
    const redis = makeRecordingRedis();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    await resolveTenant('scanned-handle'); // cold: caches the negative result

    const querySpy = vi.spyOn(handle.pool, 'query');
    const result = await resolveTenant('scanned-handle');

    expect(result).toBeNull();
    expect(querySpy).not.toHaveBeenCalled();

    querySpy.mockRestore();
  });

  it("[security] two tenants with different handles each resolve to their own tenant_id, never the other's", async () => {
    const tenantA = newId();
    const tenantB = newId();
    await seedBioPage(tenantA, 'tenant-a-handle');
    await seedBioPage(tenantB, 'tenant-b-handle');

    const redis = makeRecordingRedis();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    const resultA = await resolveTenant('tenant-a-handle');
    const resultB = await resolveTenant('tenant-b-handle');

    expect(resultA).toBe(tenantA);
    expect(resultB).toBe(tenantB);
    expect(resultA).not.toBe(resultB);
  });

  it('[security] a handle differing only by case does not resolve — exact match, never case-folded', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'case-sensitive-handle');

    const redis = makeRecordingRedis();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    const result = await resolveTenant('Case-Sensitive-Handle');

    expect(result).toBeNull();
  });

  it('the memo entry expires after 60s, so a later call consults Redis again', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'expiring-handle');

    const redis = makeRecordingRedis();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    // Cold call runs under REAL timers — it does real Postgres I/O, which
    // fake timers must not be active for.
    const first = await resolveTenant('expiring-handle');
    expect(first).toBe(tenantId);

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(MEMO_TTL_MS + 1_000);

      redis.getCalls.length = 0;
      const second = await resolveTenant('expiring-handle');

      expect(second).toBe(tenantId);
      // The memo entry is gone, so this call must re-check Redis rather
      // than serve the (now stale, by the memo's own 60s contract) value
      // straight out of the expired entry.
      expect(redis.getCalls).toEqual([handleKey('expiring-handle')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Redis GET failure falls through to Postgres and still resolves, logging a warning', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'redis-down-handle');

    const redis = makeRecordingRedis();
    redis.failNextGet();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    const result = await resolveTenant('redis-down-handle');

    expect(result).toBe(tenantId);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('[R11] a Redis SETEX failure still returns the resolved tenant, logging a warning', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'setex-fails-handle');

    const redis = makeRecordingRedis();
    redis.failNextSetex();
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis,
      logger,
      timeoutMs: HANDLE_REDIS_TIMEOUT_MS,
    });

    const result = await resolveTenant('setex-fails-handle');
    expect(result).toBe(tenantId);

    // R11 — the backfill SETEX is fire-and-forget: resolveTenant does not
    // await it, so its rejection is handled on a LATER microtask than the
    // one that resolves resolveTenant's own promise. Flush one macrotask
    // (matches lookupCachedLink's own unhandledRejection test in
    // resolve-link.test.ts) instead of gambling on exact microtask-hop
    // ordering between the two.
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('[R11] a wedged Redis SETEX backfill (never settles) does not block resolveTenant — the write is fire-and-forget, not awaited', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'wedged-setex-handle');

    const getCalls: string[] = [];
    // A half-open socket on the BACKFILL write, not the read: the lookup
    // already succeeded (Postgres answered), so this exercises the
    // fire-and-forget write path directly. Before R11 this was awaited
    // inside withRedisTimeout and the timeout branch logged a warning;
    // after R11 nothing awaits this write at all, so a wedge that NEVER
    // settles must never surface here — there is nothing to observe,
    // because observing it would require awaiting it, which is exactly
    // the blocking shape R11 removes.
    const wedgedRedis: HandleCacheRedis = {
      async get(key) {
        getCalls.push(key);
        return null; // ordinary miss — falls through to Postgres, then to the wedged SETEX below
      },
      setex: () => new Promise(() => {}),
    };
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis: wedgedRedis,
      logger,
      timeoutMs: 10,
    });

    const start = Date.now();
    const result = await resolveTenant('wedged-setex-handle');
    const elapsedMs = Date.now() - start;

    expect(result).toBe(tenantId);
    expect(elapsedMs).toBeLessThan(50);
    expect(getCalls).toEqual([handleKey('wedged-setex-handle')]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('[T2.2.3] a wedged Redis GET (never settles) still resolves via Postgres in under 50ms, logging a warning', async () => {
    const tenantId = newId();
    await seedBioPage(tenantId, 'wedged-redis-handle');

    const setexCalls: Array<{ key: string; seconds: number; value: string }> = [];
    // A half-open socket: the GET neither resolves nor rejects, ever —
    // ioredis still considers the client "ready" and never surfaces a
    // rejection, which is exactly the failure mode a plain try/catch
    // cannot touch (see resolve.ts's own header comment).
    const wedgedRedis: HandleCacheRedis = {
      get: () => new Promise(() => {}),
      async setex(key, seconds, value) {
        setexCalls.push({ key, seconds, value });
        return 'OK';
      },
    };
    const logger = makeSpyLogger();
    const resolveTenant = createResolveTenant({
      db: handle.db,
      redis: wedgedRedis,
      logger,
      timeoutMs: 10,
    });

    const start = Date.now();
    const result = await resolveTenant('wedged-redis-handle');
    const elapsedMs = Date.now() - start;

    expect(result).toBe(tenantId);
    expect(elapsedMs).toBeLessThan(50);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The GET timeout falls through to Postgres exactly like a rejected
    // GET already did before this task — including the backfill SETEX
    // after a successful Postgres lookup.
    expect(setexCalls).toEqual([
      { key: handleKey('wedged-redis-handle'), seconds: 3600, value: tenantId },
    ]);
  });
  // The SETEX-side wedge case moved to '[R11] a wedged Redis SETEX
  // backfill ... fire-and-forget, not awaited' above, once the backfill
  // stopped being awaited inside withRedisTimeout (R11) — awaiting it (the
  // old shape this comment used to sit under) is exactly what R11 removes.
});
