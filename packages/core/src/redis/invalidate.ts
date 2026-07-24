import { handleKey, linkKey } from './keys';

// T2.2.7 — the seam E5's link edit/archive/delete calls to drop a stale
// cached copy (E5 does not exist yet; this task only defines and tests the
// seam). Deliberately thin: both functions are a single `DEL` through
// keys.ts's own builders, so E5 imports a function instead of reaching
// into the keyspace and inventing a second copy of the key format — see
// this file's own tests for why that matters (T2.2.6's tombstone lives at
// the SAME key as a cached link, so one DEL clears either).
//
// No timeout wrapper here, unlike resolve-redis.ts's withRedisTimeout: that
// wrapper exists because the redirect HOT PATH must never block (invariant
// 1). Invalidation runs on E5's CRUD path, which is not the hot path — a
// caller there genuinely wants to know the delete happened, not have it
// silently degrade to "maybe cleared, maybe not" the way the hot path's
// reads are allowed to.

/**
 * The minimal shape both functions below need from a Redis client — `del`
 * only, returning the number of keys actually removed (Redis's own `DEL`
 * reply). Narrower than a full `Redis` instance, same reasoning as
 * resolve-link.ts's LinkCacheRedis/LinkCacheWriteRedis: structurally
 * satisfied by a real ioredis client, so a caller can also point this at
 * a stub without constructing one.
 */
export interface InvalidateRedis {
  del(key: string): Promise<number>;
}

/**
 * Deletes the cached link at `link:{tenant}:{slug}` — whether it holds a
 * resolved {@link import('@posta/contracts').CachedLink} payload (T2.2.5's
 * backfill) or a T2.2.6 negative-cache tombstone; both live at this same
 * key, so a single `DEL` clears either. Returns the number of keys deleted
 * (Redis's `DEL` return value): `1` if something was cached, `0` if the
 * call was a no-op because nothing was there — a caller debugging a
 * stale-destination report is entitled to tell those two outcomes apart,
 * so this is never swallowed into `void`.
 */
export function invalidateLink(
  redis: InvalidateRedis,
  tenantId: string,
  slug: string,
): Promise<number> {
  return redis.del(linkKey(tenantId, slug));
}

/**
 * Deletes the cached tenant lookup at `handle:{handle}` (T2.2.2's
 * resolveTenant memo backfill). Same return-value contract as
 * {@link invalidateLink}: the count of keys actually deleted, `0` for an
 * absent key.
 */
export function invalidateHandle(redis: InvalidateRedis, handle: string): Promise<number> {
  return redis.del(handleKey(handle));
}
