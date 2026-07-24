import type { DbClient } from '@posta/core';
import { handleKey, linkKey, resolveTenantByHandle } from '@posta/core';
import { parseCachedLink, type CachedLink } from '@posta/contracts';

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
// on every single request — the same hazard T2.2.6 later closes with a
// tombstone on the slug side; nothing else in this story does it for
// handles, so it has to happen here.
//
// Scope, deliberately narrow: no slug lookup, no lookupCachedLink, no
// hard-timeout Promise.race wrapper. This function DOES catch a Redis
// GET/SETEX failure and fall through rather than throw, but be precise
// about what that buys: maxRetriesPerRequest: 1 and enableOfflineQueue:
// false (packages/core/src/redis/client.ts) bound the CONNECTION-REFUSED
// / OFFLINE cases — a Redis that is down or unreachable rejects fast, and
// the try/catch below turns that rejection into a Postgres fall-through.
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
// [T2.2.3] That gap is now CLOSED: every Redis call in this function —
// the GET above and both SETEX branches below — runs through
// withRedisTimeout, the same REDIS_LOOKUP_TIMEOUT_MS-bounded
// Promise.race wrapper lookupCachedLink (this file) uses for the link
// cache's own GET. One resilience shape for "Redis is unresponsive" in
// this file, not two independently-invented ones: a wedged connection
// now costs this function REDIS_LOOKUP_TIMEOUT_MS of latency and a
// `warn` log — same outcome as a rejected call — never an unbounded
// hang. See withRedisTimeout's own doc comment for how it also avoids
// leaking the pending timer and avoids an unhandled rejection when the
// loser settles after the race already decided.

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
// Shorter than the positive TTL above, mirroring T2.2.6's identical
// tradeoff for the slug tombstone: caching "unknown" for a full hour
// would mean a handle claimed by a brand-new tenant stays invisible to
// anyone who happened to probe it first, for up to an hour. 60s bounds
// that window to roughly the same staleness the memo tier already
// accepts for a positive hit going stale.
const NEGATIVE_CACHE_TTL_SECONDS = 60;

// Redis's GET has no reply distinct from "key does not exist" for "we
// looked, and confirmed there is nothing" — both come back `null`. This
// sentinel is what lets a deliberately-cached negative result be told
// apart from an ordinary cache miss, so a known-absent handle costs a
// Redis GET, never a Postgres query, on every repeat — exactly as often
// as an already-cached positive hit does. Same idea as the tombstone
// T2.2.6 introduces for the slug cache, applied independently here since
// nothing else in this story caches a negative handle result.
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

/** Mirrors RedirectMiddlewareLogger (./middleware.ts) — just enough to
 * log one warning line, so tests can pass a plain spy instead of a real
 * pino instance (not wired up anywhere in this codebase yet). */
export interface ResolveLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export const consoleWarnLogger: ResolveLogger = {
  warn(message, meta) {
    console.warn(message, meta);
  },
};

export interface ResolveTenantDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly db: DbClient['db'];
  /** Built once at boot — see main.ts. */
  readonly redis: HandleCacheRedis;
  /** Built once at boot — consoleWarnLogger in production, a spy in tests. */
  readonly logger: ResolveLogger;
  /**
   * REDIS_LOOKUP_TIMEOUT_MS (env.ts) — bounds EVERY Redis call this
   * function makes (the GET and both SETEX branches), via
   * {@link withRedisTimeout}. See LookupCachedLinkDeps for the sibling
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
 * resolve.test.ts can exercise the eviction rule itself in isolation —
 * against a plain Map, with a tiny cap — without needing thousands of
 * real handles run through the full Postgres-backed ladder just to fill
 * a 10,000-entry cap.
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// T2.2.3 — a hung Redis must cost latency, not availability (invariant
// 1). A half-open socket (TCP still connected, the server unresponsive)
// throws nothing, so a plain try/catch cannot bound it: the `await` on
// that command can hang for the OS's own TCP timeout, commonly minutes.
// REDIS_TIMEOUT_MARKER is what withRedisTimeout returns instead, once
// REDIS_LOOKUP_TIMEOUT_MS elapses with no answer — a unique symbol, not
// `null`, because `null` is `GET`'s own legitimate "key does not exist"
// reply and must stay distinguishable from "we gave up waiting".
const REDIS_TIMEOUT_MARKER = Symbol('redis-lookup-timeout');
type RedisTimeoutMarker = typeof REDIS_TIMEOUT_MARKER;

/**
 * Races `operation` (an already-started Redis call) against `timeoutMs`,
 * returning {@link REDIS_TIMEOUT_MARKER} if the timer wins. Every Redis
 * call on the redirect hot path — the link cache's GET
 * (`lookupCachedLink`) and the handle cache's GET/SETEX
 * (`createResolveTenant`) — goes through this one helper, so "Redis is
 * unresponsive" has exactly one resilience shape in this file, not one
 * per call site.
 *
 * Two things a naive `Promise.race` gets wrong, both fixed here:
 *   - **Timer leak.** A `Promise.race` against a `setTimeout` leaves a
 *     pending timer running on the winning path unless it is cleared —
 *     real garbage on a path that runs on every redirect, and in tests
 *     it keeps the event loop alive. The `finally` clears it on every
 *     outcome, win or lose.
 *   - **A timed-out call still settles later.** When the timeout wins,
 *     `operation` is still out there and will eventually resolve or
 *     reject on its own. `Promise.race` already subscribes to every
 *     promise it is given, which is enough on its own to keep a later
 *     rejection from being reported as unhandled — but that reliance is
 *     implicit and easy to break in a future refactor of this helper.
 *     The explicit `operation.catch(() => {})` below makes "a late
 *     rejection is deliberately ignored, not accidentally swallowed"
 *     true by construction, not by an engine implementation detail this
 *     file doesn't otherwise depend on.
 *
 * Does NOT swallow a rejection that wins the race (i.e., `operation`
 * rejects before the timeout fires) — that still propagates, exactly as
 * an un-raced `await operation` would. Callers already have a try/catch
 * around this for that failure mode; this helper only adds the timeout
 * failure mode alongside it, not a second, different way to hide errors.
 */
function withRedisTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T | RedisTimeoutMarker> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<RedisTimeoutMarker>((resolve) => {
    timer = setTimeout(() => resolve(REDIS_TIMEOUT_MARKER), timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer);
    // Neutralises a rejection that arrives on the loser after the race
    // has already settled — see this function's doc comment. `void`
    // marks this as deliberately fire-and-forget, not an accidentally
    // dropped promise.
    void operation.catch(() => {});
  });
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

    try {
      const setexResult =
        tenantId !== null
          ? await withRedisTimeout(
              redis.setex(key, HANDLE_CACHE_TTL_SECONDS, tenantId),
              timeoutMs,
            )
          : await withRedisTimeout(
              redis.setex(key, NEGATIVE_CACHE_TTL_SECONDS, ABSENT_TENANT_TOMBSTONE),
              timeoutMs,
            );

      if (setexResult === REDIS_TIMEOUT_MARKER) {
        // The lookup itself already succeeded — a hung backfill write
        // costs only the NEXT request a Postgres query, never this
        // one's result. Same outcome as the catch below.
        logger.warn('Redis SETEX timed out while backfilling a resolved handle.', {
          handle,
          timeoutMs,
        });
      }
    } catch (error) {
      // The lookup itself already succeeded — a failed cache write costs
      // only the NEXT request a Postgres query, never this one's result.
      logger.warn('Redis SETEX failed while backfilling a resolved handle.', {
        handle,
        error: describeError(error),
      });
    }

    rememberInMemo(memo, handle, tenantId);
    return tenantId;
  };
}

// T2.2.3 — the link cache lookup (S2.2): `GET link:{tenant}:{slug}`,
// bounded by the same withRedisTimeout this file's handle tier now
// shares. No Postgres fallback, no SETEX backfill, no tombstone — those
// are T2.2.4/T2.2.5/T2.2.6, dispatched separately; this function's job
// ends at "cache hit, or miss".

/**
 * The minimal shape lookupCachedLink needs from a Redis client — `get`
 * only. Deliberately narrower than {@link HandleCacheRedis}: the SETEX
 * backfill for the link cache is T2.2.5's job, not this one's, so this
 * seam has no `setex` to avoid implying a write path exists here yet.
 * Structurally satisfied by a real ioredis `Redis` instance, same as
 * HandleCacheRedis.
 */
export interface LinkCacheRedis {
  get(key: string): Promise<string | null>;
}

/**
 * The result of a link cache lookup. A discriminated union rather than
 * `CachedLink | null`, on purpose: T2.2.6 adds a negative-cache
 * tombstone for slugs confirmed absent in both Redis and Postgres, and
 * needs to tell that apart from an ORDINARY miss (never looked up, or
 * looked up and merely not cached yet) so a tombstone never falls
 * through to Postgres the way a plain miss must. This shape leaves room
 * for that as a third `kind` (e.g. `'known-absent'`) later without
 * changing what `'hit'` or `'miss'` mean or breaking existing callers —
 * this task does NOT add that variant or any tombstone read/write logic,
 * only the room for it.
 */
export type LinkLookupResult =
  | { readonly kind: 'hit'; readonly link: CachedLink }
  | { readonly kind: 'miss' };

/** Singleton "miss" result — immutable and identical across every miss,
 * so returning it allocates nothing on the hot path's common case. */
const LINK_LOOKUP_MISS: LinkLookupResult = { kind: 'miss' };

export interface LookupCachedLinkDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly redis: LinkCacheRedis;
  /** Built once at boot — consoleWarnLogger in production, a spy in tests. */
  readonly logger: ResolveLogger;
  /**
   * REDIS_LOOKUP_TIMEOUT_MS (env.ts) — bounds this GET via
   * {@link withRedisTimeout}. See ResolveTenantDeps for the sibling use
   * on the handle tier.
   */
  readonly timeoutMs: number;
}

/**
 * `GET link:{tenant}:{slug}`, parsed and bounded. Three distinct failure
 * modes — a timeout, a rejected GET (a dead/unreachable connection), and
 * a payload that fails to parse or fails {@link CachedLinkSchema} (T2.2.1's
 * `parseCachedLink`, e.g. a non-`http(s)` `destination` — an unparsed
 * cache value handed to a redirect is an open redirect with a TTL) — all
 * collapse to the SAME outcome here: `{ kind: 'miss' }`, logged at `warn`.
 * Never throws: a hung or broken cache must cost this request latency,
 * not availability [invariant 1].
 *
 * An ordinary cache miss (`GET` returns `null` — nothing has ever cached
 * this slug) is NOT warned about: it is the expected steady-state result
 * for a slug the cache hasn't seen yet, and warning on every one of
 * those would be pure noise on a path that runs on every redirect. Only
 * a value that WAS present and still failed to yield a usable
 * {@link CachedLink} — corrupt JSON, a schema violation, a timeout, or a
 * connection error — is worth a `warn`.
 */
export async function lookupCachedLink(
  tenant: string,
  slug: string,
  deps: LookupCachedLinkDeps,
): Promise<LinkLookupResult> {
  const { redis, logger, timeoutMs } = deps;
  const key = linkKey(tenant, slug);

  let raw: string | null;
  try {
    const result = await withRedisTimeout(redis.get(key), timeoutMs);
    if (result === REDIS_TIMEOUT_MARKER) {
      logger.warn('Redis GET timed out while looking up a cached link; treating as a miss.', {
        tenant,
        slug,
        timeoutMs,
      });
      return LINK_LOOKUP_MISS;
    }
    raw = result;
  } catch (error) {
    logger.warn('Redis GET failed while looking up a cached link; treating as a miss.', {
      tenant,
      slug,
      error: describeError(error),
    });
    return LINK_LOOKUP_MISS;
  }

  const link = parseCachedLink(raw);
  if (link === null) {
    if (raw !== null) {
      // There WAS a cached value and it did not survive parsing — either
      // malformed JSON or a schema violation (T2.2.1's parseCachedLink
      // folds both into this same null). Worth a warn: an ordinary miss
      // (raw === null) is not.
      logger.warn('Cached link payload failed to parse; treating as a miss.', { tenant, slug });
    }
    return LINK_LOOKUP_MISS;
  }

  return { kind: 'hit', link };
}
