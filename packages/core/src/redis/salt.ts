import { randomBytes } from 'node:crypto';
import { formatUtcDate, saltKey } from './keys';

// T2.3.6 — the daily visitor-hash salt (invariant 6, spec §9, story S2.3).
// `visitor_hash = sha256(ip + user_agent + salt)` (T2.3.7) is only
// unlinkable day-to-day because THIS salt rotates on the UTC calendar day
// — that rotation is the privacy property, not an implementation detail.
//
// Two properties this file has to hold, both load-bearing:
//
//   1. Two instances racing on first use must converge on ONE salt. If
//      they split, the same visitor gets two different hashes on the same
//      day and "únicos hoy" silently overcounts. `SET key <candidate> NX
//      EX 172800` followed by `GET` is the mechanism: NX means only the
//      first writer's value is kept, and the GET means every OTHER writer
//      — including the one whose own candidate lost — reads back the
//      winner's value instead of trusting the candidate it generated
//      itself. Both instances end up agreeing on the winner's salt.
//   2. Rotation happens on the UTC date, never local time — see
//      formatUtcDate's own doc comment (keys.ts) for why a local-time slip
//      here would split one UTC day's hashes across two salts. This file
//      never formats a date itself; it imports formatUtcDate/saltKey so
//      there is exactly one definition of "today" to agree with.
//
// Shape mirrors resolve-tenant.ts's createResolveTenant and
// geoip/lookup.ts's createNetworkLookup: a createX(deps) factory, called
// ONCE at boot [INV-2], returning the thin per-request function
// (GetDailySalt) that closes over a process-local memo — no per-request
// instantiation, no DI ceremony.
//
// Concurrency within ONE process is handled by memoizing the PENDING
// PROMISE, not just the eventual value: createDailySalt's returned
// function is synchronous up to the point it either finds a memo hit or
// starts (and immediately memoizes) a new resolution. Node is
// single-threaded, so N calls issued back-to-back before any of them
// awaits anything all observe the SAME memo state — only the first one
// finds it empty and starts the Redis round trip; the other N-1 receive
// the identical in-flight promise. That is what makes "50 concurrent
// calls, one SET NX" true for calls inside ONE process; the SET...NX
// itself (point 1 above) is what makes it true ACROSS processes too.
//
// Redis-outage fallback (spec'd explicitly, not left to judgment): if the
// SET/GET round trip fails, reuse today's memoised salt if this process
// already has one — which is just the ordinary memo hit path above, no
// special-casing needed — and ONLY IF THERE IS NONE, mint a process-local
// random salt, log once at `error`, and memoize THAT so the rest of the
// day doesn't retry Redis (and re-log) on every subsequent call. Hashes
// computed during that window stay computable; they just stop matching
// other instances until Redis recovers. A THROWN error or a fixed
// fallback value are both worse: throwing would make a redirect depend on
// Redis being up, which invariant 1 forbids for analytics-adjacent work;
// a fixed fallback would make every instance agree on a KNOWN salt, which
// makes visitor_hash reversible by anyone who can guess an IP+UA pair —
// strictly worse than instances merely disagreeing.

const SALT_BYTES = 32;
// 48h (spec §9) — deliberately longer than the 24h a salt is actually
// "current" for, so a request arriving right at UTC midnight still finds
// YESTERDAY's key present in Redis if anything upstream still needs it,
// without this file ever having to read two keys to answer one call.
const SALT_TTL_SECONDS = 172_800;

// The key space here is UTC calendar dates, not attacker-supplied input —
// contrast resolve-tenant.ts's MEMO_MAX_ENTRIES (10,000, bounded against a
// scan over arbitrary handles). At most today's salt, and — for a request
// in flight across the midnight boundary — yesterday's, are ever worth
// keeping; anything older is already gone from Redis in 48h regardless.
// An unbounded map keyed by date would only ever grow by one entry a day,
// but a long-lived process (weeks between deploys) turns that into a slow
// leak for zero benefit, since nothing ever reads a three-day-old entry.
const SALT_MEMO_MAX_ENTRIES = 2;

/**
 * The minimal shape createDailySalt needs from a Redis client — structurally
 * matches ioredis's own `SET key value EX seconds NX` and `GET key`
 * overloads exactly, so a real ioredis `Redis` instance satisfies this with
 * no adapter, and tests can pass a plain recording double instead. Mirrors
 * HandleCacheRedis (apps/api/src/redirect/resolve-tenant.ts) and
 * InvalidateRedis (./invalidate.ts)'s same narrow-seam shape.
 */
export interface DailySaltRedis {
  set(
    key: string,
    value: string,
    secondsToken: 'EX',
    seconds: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
}

/** Mirrors GeoLookupLogger (../geoip/lookup.ts) and PartitionMaintenanceLogger
 * (apps/worker/src/partitions/partition-maintenance.job.ts) — just enough to
 * log one error line, so tests can pass a plain spy instead of a real pino
 * instance (not wired up anywhere in this codebase yet). */
export interface DailySaltLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface DailySaltDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly redis: DailySaltRedis;
  /** Built once at boot. */
  readonly logger: DailySaltLogger;
}

export type GetDailySalt = () => Promise<string>;

/**
 * Runs the actual SET NX + GET round trip for one UTC date, falling back to
 * a process-local random salt — logged once at `error` — on ANY failure
 * along the way, including a GET that comes back empty right after a SET
 * (Redis never legitimately does that inside a 48h TTL window, so it is
 * treated exactly like a connection failure rather than trusted). Both
 * branches of the try block are covered by ONE catch, deliberately: a
 * SET failure must never reach the GET call, so there is exactly one
 * fallback path and exactly one log line per failure, not one per command.
 *
 * Never rejects — every path returns a string — so memoizing the promise
 * this returns is always safe; there is no failure mode that would leave a
 * permanently-rejected promise sitting in the memo.
 */
async function fetchOrGenerateSalt(
  now: Date,
  redis: DailySaltRedis,
  logger: DailySaltLogger,
): Promise<string> {
  const key = saltKey(now);
  const candidate = randomBytes(SALT_BYTES).toString('hex');

  try {
    await redis.set(key, candidate, 'EX', SALT_TTL_SECONDS, 'NX');
    const stored = await redis.get(key);
    if (stored !== null) return stored;

    throw new Error(`Redis GET returned no value for ${key} immediately after SET`);
  } catch (error) {
    // Never the salt (this file's own candidate, or whatever Redis might
    // have returned) and never a raw error object — only the failing
    // error's constructor name, mirroring geoip/lookup.ts's
    // logLookupFailure: a third-party error's own `.message` is not this
    // file's to trust, and ioredis is exactly the library known to put the
    // connection string (password included) straight into a connection
    // error's message.
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    logger.error(
      'Daily salt SET/GET failed against Redis; falling back to a process-local salt for this ' +
        'UTC day. Hashes computed during this window will not match other instances until Redis ' +
        'recovers.',
      { errorType },
    );
    return candidate;
  }
}

/**
 * Writes (or refreshes) a memo entry, evicting the oldest entry first once
 * at capacity — same FIFO shape as resolve-tenant.ts's rememberInMemo, sized
 * down to this file's much smaller key space (see SALT_MEMO_MAX_ENTRIES).
 */
function rememberSalt(
  memo: Map<string, Promise<string>>,
  dateKey: string,
  salt: Promise<string>,
): void {
  if (memo.size >= SALT_MEMO_MAX_ENTRIES && !memo.has(dateKey)) {
    const oldestKey = memo.keys().next().value;
    if (oldestKey !== undefined) memo.delete(oldestKey);
  }
  memo.set(dateKey, salt);
}

/**
 * Builds getDailySalt() from dependencies resolved once at boot — the
 * returned function is what every capture on the redirect hot path calls,
 * closing over a fresh, process-local memo Map [INV-2]. No per-request
 * instantiation beyond the one memo entry a cold call writes.
 */
export function createDailySalt(deps: DailySaltDeps): GetDailySalt {
  const { redis, logger } = deps;
  const memo = new Map<string, Promise<string>>();

  return function getDailySalt(): Promise<string> {
    const now = new Date();
    const dateKey = formatUtcDate(now);

    const memoized = memo.get(dateKey);
    if (memoized) return memoized;

    const pending = fetchOrGenerateSalt(now, redis, logger);
    rememberSalt(memo, dateKey, pending);
    return pending;
  };
}
