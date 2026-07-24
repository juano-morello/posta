// Split out of resolve.ts during T2.2.6's fix round, once that file
// crossed this epic's ~750-line split trigger (800 is the hard cap) —
// mirrors the earlier test-side split (resolve.test.ts ->
// resolve-tenant.test.ts / resolve-link.test.ts / resolve-test-support.ts,
// T2.2.5's fix round 1). This file holds the plumbing BOTH tiers share —
// the logger seam and the hard-timeout Redis wrapper — so resolve-tenant.ts
// (the handle→tenant ladder, T2.2.2) and resolve-link.ts (the slug cache,
// T2.2.3-T2.2.6) each import it rather than each defining their own copy.

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

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// T2.2.3 — a hung Redis must cost latency, not availability (invariant
// 1). A half-open socket (TCP still connected, the server unresponsive)
// throws nothing, so a plain try/catch cannot bound it: the `await` on
// that command can hang for the OS's own TCP timeout, commonly minutes.
// REDIS_TIMEOUT_MARKER is what withRedisTimeout returns instead, once
// the caller's timeoutMs elapses with no answer — a unique symbol, not
// `null`, because `null` is `GET`'s own legitimate "key does not exist"
// reply and must stay distinguishable from "we gave up waiting".
export const REDIS_TIMEOUT_MARKER = Symbol('redis-lookup-timeout');
export type RedisTimeoutMarker = typeof REDIS_TIMEOUT_MARKER;

/**
 * Races `operation` (an already-started Redis call) against `timeoutMs`,
 * returning {@link REDIS_TIMEOUT_MARKER} if the timer wins. Every
 * AWAITED Redis read on the redirect hot path — the link cache's GET
 * (resolve-link.ts's `lookupCachedLink`) and the handle cache's GET
 * (resolve-tenant.ts's `createResolveTenant`) — goes through this one
 * helper, so "Redis is unresponsive" has exactly one resilience shape
 * for the calls this request actually waits on, not one per call site.
 * The SETEX backfill/tombstone writes on both tiers
 * (`backfillHandleCache`, `backfillLinkCache`, `writeLinkTombstone`) are
 * fire-and-forget (R11 / T2.2.5 / T2.2.6) — never awaited, so they never
 * go through this helper: nothing waits on them, so there is nothing to
 * bound a timeout against.
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
export function withRedisTimeout<T>(
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
