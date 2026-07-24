import type { DbClient } from '@posta/core';
import { linkKey, resolveLinkBySlug } from '@posta/core';
import { CachedLinkSchema, parseCachedLink, type CachedLink } from '@posta/contracts';
import { describeError, REDIS_TIMEOUT_MARKER, withRedisTimeout, type ResolveLogger } from './resolve-redis';

// T2.2.3 — the link cache lookup (S2.2): `GET link:{tenant}:{slug}`,
// bounded by resolve-redis.ts's withRedisTimeout — the same wrapper
// resolve-tenant.ts's handle tier uses. No Postgres fallback, no SETEX
// backfill, no tombstone in lookupCachedLink ITSELF; those live one
// level up, in resolveLink (T2.2.4/T2.2.5/T2.2.6, further down this same
// file) — lookupCachedLink's own job ends at "cache hit, miss, or
// known-absent".

/**
 * The minimal shape lookupCachedLink needs from a Redis client — `get`
 * only. Deliberately narrower than resolve-tenant.ts's HandleCacheRedis:
 * the read path (this function) has no business writing, so this seam
 * has no `setex` — that capability lives on {@link LinkCacheWriteRedis}
 * (T2.2.5) instead, used only by resolveLink's backfill/tombstone
 * writes, below. Structurally satisfied by a real ioredis `Redis`
 * instance, same as HandleCacheRedis.
 */
export interface LinkCacheRedis {
  get(key: string): Promise<string | null>;
}

/**
 * The result of a link cache lookup. A discriminated union rather than
 * `CachedLink | null`: T2.2.6's negative-cache tombstone (a slug
 * confirmed absent in both Redis and Postgres) is a POSITIVE cached
 * fact, not the absence of one, and must be told apart from an ORDINARY
 * miss (never looked up, or looked up and merely not cached yet) — a
 * tombstone folded into `'miss'` would fall straight through to
 * Postgres on every request, which is exactly the outcome the tombstone
 * exists to prevent. The third `kind` below makes that distinction
 * load-bearing at the type level: resolveLink (further down) branches on
 * `'known-absent'` explicitly, so the compiler — not a caller's memory —
 * enforces that a tombstone read never reaches resolveLinkFromDb.
 */
export type LinkLookupResult =
  | { readonly kind: 'hit'; readonly link: CachedLink }
  | { readonly kind: 'miss' }
  | { readonly kind: 'known-absent' };

/** Singleton "miss" result — immutable and identical across every miss,
 * so returning it allocates nothing on the hot path's common case. */
const LINK_LOOKUP_MISS: LinkLookupResult = { kind: 'miss' };

/** Singleton "known-absent" result (T2.2.6) — returned when the value
 * read back for this key is the tombstone, not merely empty. Same
 * allocation-free reasoning as LINK_LOOKUP_MISS above. */
const LINK_LOOKUP_KNOWN_ABSENT: LinkLookupResult = { kind: 'known-absent' };

// T2.2.6 — negative-cache tombstone for a slug confirmed absent in BOTH
// Redis and Postgres, so a scan over random slugs pays one Postgres
// query per slug per LINK_TOMBSTONE_TTL_SECONDS, not per request.
// Defined independently from resolve-tenant.ts's own
// NEGATIVE_CACHE_TTL_SECONDS / ABSENT_TENANT_TOMBSTONE, rather than
// shared: the two tiers' keys and callers already live in separate
// files with separate deps shapes, and their TTLs diverging in
// principle — even though both happen to be 60s today — is exactly why
// each gets named for the tier it protects.
//
// The value is a deliberate tension, not a round number: long enough to
// blunt a scan (a scanner's Postgres cost drops to once per slug per
// minute instead of once per request), short enough that a link created
// moments after its slug was probed goes live within a minute rather
// than 404ing off a stale tombstone for as long as the POSITIVE cache
// TTL (LINK_CACHE_TTL_SECONDS, env.ts, default 3600) would allow if this
// reused that number instead — which is exactly the "simplification" this
// task's brief calls out and forbids.
export const LINK_TOMBSTONE_TTL_SECONDS = 60;

// GET has no reply distinct from "key never existed" for "we looked, and
// confirmed there is nothing" — both come back `null`. This sentinel is
// what lets a deliberately-cached negative result be told apart from an
// ordinary miss on read. Mirrors resolve-tenant.ts's ABSENT_TENANT_TOMBSTONE
// identical role and exact value for the handle tier. Exported so
// resolve-link.test.ts can construct/assert against it directly rather
// than duplicating the literal `'\0'` and risking the two drifting apart.
export const LINK_TOMBSTONE = '\0';

export interface LookupCachedLinkDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly redis: LinkCacheRedis;
  /** Built once at boot — consoleWarnLogger in production, a spy in tests. */
  readonly logger: ResolveLogger;
  /**
   * REDIS_LOOKUP_TIMEOUT_MS (env.ts) — bounds this GET via
   * {@link withRedisTimeout}. See resolve-tenant.ts's ResolveTenantDeps
   * for the sibling use on the handle tier.
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
 *
 * A FOURTH outcome, checked before any parsing logic runs (T2.2.6): the
 * cached value IS {@link LINK_TOMBSTONE}, written after a slug was
 * confirmed absent in both Redis and Postgres. This returns
 * `{ kind: 'known-absent' }`, not `'miss'` — the whole point of the
 * tombstone is to be told apart from an ordinary miss, so resolveLink
 * never re-queries Postgres for a slug already known not to exist — and
 * logs nothing: under a sustained scan, a tombstone read happens on
 * every single probe, so warning here would flood the log exactly where
 * the tombstone exists to reduce load.
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

  if (raw === LINK_TOMBSTONE) {
    // Checked BEFORE parseCachedLink, deliberately: the tombstone is not
    // corrupt data recovering from a parse failure, it is the expected
    // shape of a confirmed-absent slug, so it must never take the "failed
    // to parse" warn path below.
    return LINK_LOOKUP_KNOWN_ABSENT;
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

// T2.2.4 — the tier below lookupCachedLink's Redis check: on a miss, one
// query resolves the destination straight from Postgres, tenant-scoped
// and archive-aware. The query itself lives in
// packages/core/src/db/tenant.ts's resolveLinkBySlug, not here — same
// reason resolve-tenant.ts's resolveTenant can't build
// resolveTenantByHandle's query in its own file either: apps/api has no
// direct dependency on `drizzle-orm`, only `@posta/core` does. This
// function is the thin, boot-resolved-dependency wrapper around it,
// matching every other function in this file's shape (a `deps` object,
// never a per-request construction) [INV-2].
//
// No try/catch, no timeout, and no fallback beyond this: unlike the
// Redis tiers above, Postgres IS the resolution of last resort here —
// there is nothing left to fall through to. A query failure propagates
// to the caller unchanged, exactly like resolveTenantByHandle already
// does for the handle tier.
//
// Scope, deliberately narrow at the time this function was written —
// still true of resolveLinkFromDb ITSELF, which is unchanged below:
//   - No SETEX backfill into Redis on a hit. [T2.2.5 CLOSED this — see
//     resolveLink, further down, which composes lookupCachedLink + this
//     function + the backfill into the single top-level entry point the
//     redirect middleware will call. resolveLinkFromDb stays exactly
//     what it was: the plain, uncached Postgres tier.]
//   - No negative-cache tombstone on a miss. [T2.2.6 CLOSED this too —
//     see resolveLink, further down, which writes the tombstone itself
//     once THIS function returns `null`. resolveLinkFromDb still doesn't
//     know anything about tombstones: it returns `null` exactly as
//     before, and it is resolveLinkFromDb NOT throwing that lets its
//     caller tell "confirmed absent" apart from "the query itself
//     failed" — see writeLinkTombstone's own doc comment.]

export interface ResolveLinkFromDbDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly db: DbClient['db'];
}

/**
 * The Postgres fallback for a link cache miss: `SELECT id, tenant_id,
 * destination FROM links WHERE tenant_id = $1 AND slug = $2 AND
 * archived_at IS NULL`, via resolveLinkBySlug (packages/core). Returns
 * `null` for an unknown slug AND for an archived one — a revoked link
 * must resolve to nothing, never to its old destination, and that has to
 * be true whether the slug was never claimed or was claimed and later
 * archived; this function does not distinguish the two to its caller,
 * exactly as a 404 shouldn't.
 */
export async function resolveLinkFromDb(
  tenant: string,
  slug: string,
  deps: ResolveLinkFromDbDeps,
): Promise<CachedLink | null> {
  return resolveLinkBySlug(deps.db, tenant, slug);
}

// T2.2.5 — closes the loop S2.2 describes: after a Postgres hit, the
// resolved link is written back to Redis so the NEXT request for the
// same slug is a cache hit, not a repeat Postgres query. Invariant 1
// ("a redirect never blocks on analytics") is written about the enqueue
// specifically, but its spirit covers the whole hot path — this write is
// exactly as fire-and-forget as that one, for the identical reason: a
// failed or slow backfill costs the NEXT request a Postgres query, and
// blocking THIS one on it would trade a guarantee (this visitor gets
// redirected) for an optimisation (the next one is faster).

/**
 * {@link LinkCacheRedis} plus `setex` — the shape resolveLink's backfill
 * write needs, on top of the plain read lookupCachedLink already uses.
 * A separate interface from LinkCacheRedis (rather than adding `setex`
 * to it directly) so lookupCachedLink's own deps stay read-only in their
 * type, not just by convention. Structurally satisfied by a real ioredis
 * `Redis` instance, same as resolve-tenant.ts's HandleCacheRedis.
 */
export interface LinkCacheWriteRedis extends LinkCacheRedis {
  setex(key: string, seconds: number, value: string): Promise<unknown>;
}

export interface ResolveLinkDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly db: DbClient['db'];
  /** Built once at boot — see main.ts. */
  readonly redis: LinkCacheWriteRedis;
  /** Built once at boot — consoleWarnLogger in production, a spy in tests. */
  readonly logger: ResolveLogger;
  /**
   * REDIS_LOOKUP_TIMEOUT_MS (env.ts) — bounds the cache GET only, via
   * lookupCachedLink's own use of {@link withRedisTimeout}. Does NOT
   * bound the backfill/tombstone SETEX below — see backfillLinkCache and
   * writeLinkTombstone.
   */
  readonly timeoutMs: number;
  /**
   * LINK_CACHE_TTL_SECONDS (env.ts, default 3600) — the TTL the backfill
   * SETEX writes. A deps field, not a module constant, mirroring how
   * `timeoutMs` above is threaded through rather than reading env.ts
   * directly from this file — apps/api's env schema is main.ts's concern,
   * not the redirect hot path's.
   */
  readonly cacheTtlSeconds: number;
}

/**
 * Fire-and-forget SETEX backfill of the link cache after a Postgres hit.
 * Called from resolveLink as `void backfillLinkCache(...)` — NEVER
 * awaited: the destination has already been resolved from Postgres by
 * the time this runs, so this write's outcome (or how long it takes)
 * cannot change what resolveLink returns. Mirrors resolve-tenant.ts's
 * backfillHandleCache (R11) in shape: the try/catch lives INSIDE this
 * async function, not as a `.catch()` chained at the call site, so the
 * promise this function returns can never reject — `void`ing it at the
 * call site is provably safe, not merely safe-by-convention.
 *
 * The value written is built by round-tripping `link` through
 * {@link CachedLinkSchema} — `JSON.stringify(CachedLinkSchema.parse(link))`
 * — rather than `JSON.stringify(link)` directly. `link` is already typed
 * as `CachedLink` at this call site, so in the common case this changes
 * nothing about the bytes written; what it buys is that the WRITER and
 * the READER ({@link parseCachedLink}, used by lookupCachedLink) are
 * provably reading and writing the identical schema, so a future change
 * to one can't silently drift from the other. `.parse()` (not
 * `.safeParse()`) is intentional: a value that fails T2.2.1's own schema
 * here would mean resolveLinkFromDb returned something that isn't a
 * valid `CachedLink` at all — a bug worth surfacing as a caught, logged
 * `warn`, not a value worth writing to the cache anyway. That case gets
 * its OWN catch block, below, with its own message: it is a data-shape
 * bug, not a Redis I/O failure, and folding it into the SETEX failure's
 * "Redis SETEX failed" message would send whoever reads that log
 * chasing a Redis outage that never happened.
 */
async function backfillLinkCache(
  tenant: string,
  slug: string,
  link: CachedLink,
  deps: Pick<ResolveLinkDeps, 'redis' | 'logger' | 'cacheTtlSeconds'>,
): Promise<void> {
  const { redis, logger, cacheTtlSeconds } = deps;
  const key = linkKey(tenant, slug);

  let value: string;
  try {
    value = JSON.stringify(CachedLinkSchema.parse(link));
  } catch (error) {
    logger.warn(
      'Resolved link failed CachedLinkSchema validation; skipping the cache backfill.',
      { tenant, slug, error: describeError(error) },
    );
    return;
  }

  try {
    await redis.setex(key, cacheTtlSeconds, value);
  } catch (error) {
    logger.warn(
      'Redis SETEX failed while backfilling the link cache; the next request will re-query Postgres.',
      { tenant, slug, error: describeError(error) },
    );
  }
}

// T2.2.6 — the mirror image of the backfill above: after a Postgres MISS
// (rather than a hit), a fire-and-forget SETEX writes the negative-cache
// tombstone, so a scan over random slugs pays one Postgres query per slug
// per LINK_TOMBSTONE_TTL_SECONDS, not per request.

/**
 * Fire-and-forget SETEX of the negative-cache tombstone. Called from
 * resolveLink ONLY once a slug is genuinely confirmed absent: the cache
 * missed it AND resolveLinkFromDb (T2.2.4) — Postgres, the source of
 * truth — RETURNED `null` rather than throwing. Mirrors backfillLinkCache
 * (T2.2.5, above) in shape: the try/catch lives INSIDE this async
 * function, not a `.catch()` chained at the call site, so the promise
 * this function returns can never reject — `void`ing it at the call site
 * is provably safe. Never awaited: by the time this runs, resolveLink
 * already has its answer (`null`), so a slow or failed write can only
 * ever cost the NEXT probe of this exact slug a Postgres query, never
 * this request's result or its latency.
 *
 * The "confirmed absent, not merely unknown" distinction this function's
 * doc comment keeps repeating is the subtlest part of T2.2.6, so it is
 * worth being explicit about how it is enforced, not just asserted:
 * resolveLinkFromDb has NO try/catch of its own (see its own header
 * comment) — a genuine Postgres error (a dead connection, a syntax
 * error, anything) PROPAGATES OUT of it as a thrown rejection, which
 * resolveLink does not catch either. That means a Postgres failure never
 * reaches the `link === null` check that guards the call to this
 * function at all — the whole call stack unwinds past it. So the only
 * way execution reaches `writeLinkTombstone` is a Postgres query that
 * SUCCEEDED and genuinely found no matching, unarchived row: "we do not
 * know" (a Redis hiccup on the read, or a thrown Postgres error) is
 * structurally incapable of reaching this function; only "we checked,
 * and there is nothing" can.
 */
async function writeLinkTombstone(
  tenant: string,
  slug: string,
  deps: Pick<ResolveLinkDeps, 'redis' | 'logger'>,
): Promise<void> {
  const { redis, logger } = deps;
  const key = linkKey(tenant, slug);

  try {
    await redis.setex(key, LINK_TOMBSTONE_TTL_SECONDS, LINK_TOMBSTONE);
  } catch (error) {
    logger.warn(
      'Redis SETEX failed while writing the negative-cache tombstone; the next probe of this slug will re-query Postgres.',
      { tenant, slug, error: describeError(error) },
    );
  }
}

/**
 * The redirect hot path's single entry point for slug resolution — the
 * composition S2.2's acceptance criteria describe directly: cache lookup
 * (T2.2.3's lookupCachedLink) first; on a cache MISS, Postgres (T2.2.4's
 * resolveLinkFromDb); on a POSTGRES hit, a fire-and-forget positive cache
 * backfill (T2.2.5); on a POSTGRES miss, a fire-and-forget negative-cache
 * tombstone (T2.2.6) so the NEXT request for this exact slug never
 * touches Postgres again for LINK_TOMBSTONE_TTL_SECONDS.
 *
 * A cache HIT returns immediately — no Postgres call, no re-backfill of a
 * value that's already cached and still valid.
 *
 * A cache result of `'known-absent'` (T2.2.6) ALSO returns immediately,
 * with no Postgres call: the tombstone from a PRIOR request's Postgres
 * miss already answered this question, so re-asking Postgres would waste
 * exactly the query the tombstone exists to avoid.
 */
export async function resolveLink(
  tenant: string,
  slug: string,
  deps: ResolveLinkDeps,
): Promise<CachedLink | null> {
  const { db, redis, logger, timeoutMs, cacheTtlSeconds } = deps;

  const cached = await lookupCachedLink(tenant, slug, { redis, logger, timeoutMs });
  if (cached.kind === 'hit') {
    return cached.link;
  }
  if (cached.kind === 'known-absent') {
    return null;
  }

  const link = await resolveLinkFromDb(tenant, slug, { db });
  if (link === null) {
    // Fire-and-forget, NOT awaited — see writeLinkTombstone's own doc
    // comment for why this branch is only ever reached on a CONFIRMED
    // absence, never on an infrastructural failure.
    void writeLinkTombstone(tenant, slug, { redis, logger });
    return null;
  }

  // Fire-and-forget, NOT awaited — see backfillLinkCache's own doc
  // comment for why this is provably safe to `void`.
  void backfillLinkCache(tenant, slug, link, { redis, logger, cacheTtlSeconds });

  return link;
}
