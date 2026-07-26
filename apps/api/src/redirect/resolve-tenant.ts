import type { DbClient } from '@posta/core';
import { handleKey, resolveTenantByHandle } from '@posta/core';
import { describeError, REDIS_TIMEOUT_MARKER, withRedisTimeout, type ResolveLogger } from './resolve-redis';

// T2.2.2 — resolveTenant(handle) bridges the request's Host-derived
// handle to the tenant_id every downstream piece of the redirect hot
// path is scoped by: the link cache key (`link:{tenant}:{slug}`,
// T2.1.3), the Postgres link lookup (T2.2.4), and the enqueued event's
// own tenant_id all inherit whatever this function returns, unquestioned.
// It is the ROOT of every tenant scope downstream of it — a
// tenant-boundary function, not a lookup convenience.
//
// Three tiers, cheapest first — mirrors S2.2's own text:
//   1. A process-local memo: a plain bounded Map, 60s TTL per entry.
//      Handles change roughly never, so paying a Redis GET for one on
//      EVERY request would silently double the round trips the redirect
//      pays for nothing — this tier is what keeps the story's "one Redis
//      round trip" claim true. 60s bounds how stale this can get after a
//      handle is ever repointed to a different tenant.
//   2. Redis (`handle:{handle}`, SETEX 1h) — shared across every API
//      process, survives this one process's memo expiring or restarting.
//   3. Postgres (packages/core/src/db/tenant.ts's resolveTenantByHandle)
//      — the source of truth. A hit here backfills both Redis and the
//      memo before returning, so the very next request — this process or
//      any other — does not reach Postgres again for the same handle
//      within the TTL windows above.
//
// Unknown handles are cached too, at every tier — see
// NEGATIVE_CACHE_TTL_SECONDS below for why that tier uses a shorter TTL
// than a positive hit does. Without this, a scan over random subdomains
// (anyone can request any *.POSTA_LINK_DOMAIN host) would reach Postgres
// on every single request — the same hazard resolve-link.ts's own
// tombstone (T2.2.6) closes for the slug side; nothing else in this
// story does it for handles, so it has to happen here.
//
// Scope, deliberately narrow: no slug lookup, no lookupCachedLink, no
// hard-timeout Promise.race wrapper OF ITS OWN (it imports
// resolve-redis.ts's withRedisTimeout, same as resolve-link.ts does).
// This function DOES catch a Redis GET/SETEX failure and fall through
// rather than throw, but be precise about what that buys: maxRetriesPerRequest: 1
// and enableOfflineQueue: false (packages/core/src/redis/client.ts) bound
// the CONNECTION-REFUSED / OFFLINE cases — a Redis that is down or
// unreachable rejects fast, and the try/catch below turns that rejection
// into a Postgres fall-through.
//
// [reviewer, T2.2.2 fix round 1] An EARLIER version of this comment
// additionally claimed those two settings mean "a dead Redis fails a
// command fast, not hung" in general, and used that to argue the plain
// try/catch alone is "enough". That is wrong for the failure mode that
// matters most here: a HALF-OPEN socket (TCP still connected, the server
// unresponsive) trips neither setting — ioredis still considers the
// client "ready", still sends the command, and the `await` on that
// command can hang for the OS's own TCP timeout, commonly minutes. A
// hang throws nothing, so a try/catch does not touch it: resolveTenant
// would block indefinitely, and because handle resolution runs before
// EVERY redirect resolves anything, one wedged Redis connection stalls
// all traffic, not just analytics — the exact class of outage invariant
// 1 exists to prevent.
//
// So, accurately: the try/catch here converts REJECTED Redis calls to a
// degraded (Postgres-only) fall-through; on its own it does NOT bound
// latency.
//
// [T2.2.3] That gap is now CLOSED for the GET: it runs through
// withRedisTimeout, the same REDIS_LOOKUP_TIMEOUT_MS-bounded
// Promise.race wrapper resolve-link.ts's lookupCachedLink uses for the
// link cache's own GET. A wedged GET costs this function
// REDIS_LOOKUP_TIMEOUT_MS of latency and a `warn` log — same outcome as
// a rejected call — never an unbounded hang. See withRedisTimeout's own
// doc comment (resolve-redis.ts) for how it also avoids leaking the
// pending timer and avoids an unhandled rejection when the loser settles
// after the race already decided.
//
// [R11 / T2.2.5] The paragraph above ORIGINALLY also routed both SETEX
// branches (the backfill write) through withRedisTimeout, awaited. That
// made the "costs REDIS_LOOKUP_TIMEOUT_MS" claim above false for the
// function as a whole: a Redis wedged on BOTH the GET and the SETEX cost
// a cold resolution up to 2x REDIS_LOOKUP_TIMEOUT_MS (the GET's timeout,
// THEN the SETEX's), not the 1x the claim implied. The backfill's result
// can never change what resolveTenant returns — tenantId is already
// known from Postgres by the time the write runs — so awaiting it, even
// bounded, bought nothing but that extra latency. backfillHandleCache
// (below) is now fire-and-forget: called, never awaited, with its own
// try/catch turning a rejection into one `warn` log instead of an
// unhandled rejection. Not awaited also means not worth wrapping in
// withRedisTimeout either — nothing waits on the result, so there is
// nothing left to bound. That makes the ORIGINAL claim literally true
// again: a wedge now costs this function exactly one
// REDIS_LOOKUP_TIMEOUT_MS, from the GET alone.

export const MEMO_TTL_MS = 60_000;
// A generous cap: real tenants own a handful of handles at most — v1 is
// literally one seeded tenant (invariant 9) — so this bounds a DIFFERENT
// case entirely: an attacker driving many distinct, never-repeating
// subdomains at this deployment can't grow this Map without bound and
// exhaust process memory. 10,000 entries is small (well under a MB even
// counting V8's per-entry/string overhead) yet far larger than any
// plausible legitimate handle count for years to come.
const MEMO_MAX_ENTRIES = 10_000;

const HANDLE_CACHE_TTL_SECONDS = 3600;
// Shorter than the positive TTL above, mirroring resolve-link.ts's
// identical tradeoff for the slug tombstone (LINK_TOMBSTONE_TTL_SECONDS,
// T2.2.6): caching "unknown" for a full hour would mean a handle claimed
// by a brand-new tenant stays invisible to anyone who happened to probe
// it first, for up to an hour. 60s bounds that window to roughly the
// same staleness the memo tier already accepts for a positive hit going
// stale.
const NEGATIVE_CACHE_TTL_SECONDS = 60;

// Redis's GET has no reply distinct from "key does not exist" for "we
// looked, and confirmed there is nothing" — both come back `null`. This
// sentinel is what lets a deliberately-cached negative result be told
// apart from an ordinary cache miss, so a known-absent handle costs a
// Redis GET, never a Postgres query, on every repeat — exactly as often
// as an already-cached positive hit does. Same idea as
// resolve-link.ts's LINK_TOMBSTONE for the slug cache (T2.2.6), defined
// independently here since nothing else in this story caches a negative
// handle result.
const ABSENT_TENANT_TOMBSTONE = '\0';

export interface MemoEntry {
  readonly tenantId: string | null;
  readonly expiresAt: number;
}

/**
 * The minimal shape resolveTenant needs from a Redis client — `get` and
 * `setex` only. Structurally satisfied by a real ioredis `Redis`
 * instance with no import of the `ioredis` package needed here — apps/api
 * does not depend on it directly, @posta/core does, and main.ts wires the
 * real client through. Mirrors RedirectMiddlewareLogger's
 * (./middleware.ts) same minimal-seam shape, and lets tests pass a plain
 * recording double instead of standing up a real client.
 */
export interface HandleCacheRedis {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
}

export interface ResolveTenantDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly db: DbClient['db'];
  /** Built once at boot — see main.ts. */
  readonly redis: HandleCacheRedis;
  /** Built once at boot — consoleWarnLogger in production, a spy in tests. */
  readonly logger: ResolveLogger;
  /**
   * REDIS_LOOKUP_TIMEOUT_MS (env.ts) — bounds the memo-miss GET this
   * function makes, via {@link withRedisTimeout}. Does NOT bound the
   * SETEX backfill (see backfillHandleCache, R11): that write is
   * fire-and-forget and never awaited, so there is nothing for a timeout
   * to bound. See resolve-link.ts's LookupCachedLinkDeps for the sibling
   * use on the link cache's own GET.
   */
  readonly timeoutMs: number;
}

export type ResolveTenant = (handle: string) => Promise<string | null>;

function isExpired(entry: MemoEntry): boolean {
  return Date.now() >= entry.expiresAt;
}

/**
 * Writes (or refreshes) a memo entry, evicting the oldest entry first if
 * the map is already at capacity. FIFO, not LRU: the simplest correct
 * bound, and MEMO_TTL_MS already caps how long any entry — hot or cold —
 * usefully lives, so the two eviction strategies behave near-identically
 * for this workload.
 *
 * `maxEntries` defaults to MEMO_MAX_ENTRIES for the real ladder below, and
 * is a parameter (rather than reading the module constant directly) so
 * resolve-tenant.test.ts can exercise the eviction rule itself in
 * isolation — against a plain Map, with a tiny cap — without needing
 * thousands of real handles run through the full Postgres-backed ladder
 * just to fill a 10,000-entry cap.
 */
export function rememberInMemo(
  memo: Map<string, MemoEntry>,
  handle: string,
  tenantId: string | null,
  maxEntries: number = MEMO_MAX_ENTRIES,
): void {
  if (memo.size >= maxEntries && !memo.has(handle)) {
    const oldestKey = memo.keys().next().value;
    if (oldestKey !== undefined) memo.delete(oldestKey);
  }
  memo.set(handle, { tenantId, expiresAt: Date.now() + MEMO_TTL_MS });
}

/**
 * Fire-and-forget SETEX for the handle cache (R11): writes either a
 * positive hit (`tenantId`, 1h TTL) or the negative tombstone
 * (`ABSENT_TENANT_TOMBSTONE`, 60s TTL). Called from createResolveTenant
 * as `void backfillHandleCache(...)` — NEVER awaited. By the time this
 * runs, resolveTenant already has its answer from Postgres, so a slow or
 * failed write can only ever cost the NEXT request a Postgres query,
 * never this one's result or its latency [invariant 1's spirit, applied
 * to the whole hot path — not only the analytics enqueue it names].
 *
 * The try/catch is INSIDE this async function, not a `.catch()` chained
 * at the call site: the two are equivalent for "never let this reject
 * unhandled", but keeping it inside means `backfillHandleCache`'s own
 * returned promise can never reject at all — `void`ing it at the call
 * site is provably safe, not merely safe-by-convention. Logs at `warn`
 * exactly once per failed write, via {@link describeError} — never the
 * raw error object, AND with any REDIS_URL credential embedded in the
 * error's own `.message` redacted (describeError's own doc comment,
 * resolve-redis.ts, has the full "why" — a Redis connection error's
 * `.message` itself, not just the object, is exactly where ioredis puts
 * the password).
 */
async function backfillHandleCache(
  key: string,
  handle: string,
  tenantId: string | null,
  deps: Pick<ResolveTenantDeps, 'redis' | 'logger'>,
): Promise<void> {
  const { redis, logger } = deps;
  const [ttlSeconds, value]: [number, string] =
    tenantId !== null
      ? [HANDLE_CACHE_TTL_SECONDS, tenantId]
      : [NEGATIVE_CACHE_TTL_SECONDS, ABSENT_TENANT_TOMBSTONE];

  try {
    await redis.setex(key, ttlSeconds, value);
  } catch (error) {
    logger.warn('Redis SETEX failed while backfilling a resolved handle.', {
      handle,
      error: describeError(error),
    });
  }
}

/**
 * Builds resolveTenant from dependencies resolved once at boot — the
 * returned function is what every request calls, closing over a fresh,
 * process-local memo Map [INV-2]: no per-request instantiation beyond the
 * one memo entry a cold call writes.
 */
export function createResolveTenant(deps: ResolveTenantDeps): ResolveTenant {
  const { db, redis, logger, timeoutMs } = deps;
  const memo = new Map<string, MemoEntry>();

  return async function resolveTenant(handle: string): Promise<string | null> {
    const memoized = memo.get(handle);
    if (memoized && !isExpired(memoized)) {
      return memoized.tenantId;
    }

    const key = handleKey(handle);
    let cached: string | null = null;
    try {
      const result = await withRedisTimeout(redis.get(key), timeoutMs);
      if (result === REDIS_TIMEOUT_MARKER) {
        // A hung GET — no connection error was ever thrown, the
        // command simply never answered in time. Same outcome as the
        // catch below: fall through to Postgres as if this were a
        // plain miss.
        logger.warn('Redis GET timed out while resolving a handle; falling through to Postgres.', {
          handle,
          timeoutMs,
        });
      } else {
        cached = result;
      }
    } catch (error) {
      // A dead/unreachable Redis must cost latency, not availability —
      // fall through to Postgres exactly as if this were a plain miss.
      logger.warn('Redis GET failed while resolving a handle; falling through to Postgres.', {
        handle,
        error: describeError(error),
      });
    }

    if (cached === ABSENT_TENANT_TOMBSTONE) {
      rememberInMemo(memo, handle, null);
      return null;
    }
    if (cached !== null) {
      rememberInMemo(memo, handle, cached);
      return cached;
    }

    const tenantId = await resolveTenantByHandle(db, handle);

    // R11 — fire-and-forget, NOT awaited: the lookup above already
    // succeeded, so this write's outcome (or how long it takes) cannot
    // change what this call returns. See backfillHandleCache's own doc
    // comment for why this is provably safe to `void`.
    void backfillHandleCache(key, handle, tenantId, { redis, logger });

    rememberInMemo(memo, handle, tenantId);
    return tenantId;
  };
}
