// T2.3.6 (S2.3 story-fan-out fix) — promoted here from
// packages/core/src/redis/test-support.ts, which originally served only
// that folder's own test files (keys.test.ts, salt.test.ts). Once
// apps/api/src/redirect/visitor-hash.test.ts (T2.3.9) needed the identical
// tool for its own UTC-rotation guard, it couldn't reach a file under
// packages/core/src/redis via a relative import (that would cross the
// api->core package boundary on disk, which no test file in this repo
// does) and copied the function locally instead — a copy whose CODE stayed
// correct but whose docstring (the part that actually matters here, see
// below) did not travel with it. A code-reviewer finding on the S2.3
// story-level fan-out called that drift out explicitly: promoting the one
// definition to `@posta/core`'s TEST-ONLY subpath (`@posta/core/testing`,
// see ./index.ts's own header for why that subpath exists) is what lets
// every package/app import the SAME copy instead of maintaining several.
// packages/core's own test files (keys.test.ts, salt.test.ts) import this
// via the relative path below (same-package imports never go through the
// package's own subpath export), while apps/api imports it via
// `@posta/core/testing`.

/**
 * Runs `fn` with `process.env.TZ` pinned to `tz`, restoring the original
 * value (or its absence) afterward.
 *
 * Always pin a POSITIVE UTC offset (e.g. `Europe/Berlin`) for any test that
 * claims to prove UTC-vs-local behavior: this repo's CI runs on
 * `ubuntu-latest` with no `TZ` override (defaults to UTC) and this repo's
 * own dev sandbox runs `America/Buenos_Aires` (UTC-3) — a late-UTC-day
 * instant is still the SAME calendar day in both of those whether read via
 * `getUTC*()` or the local `getFullYear()`/`getMonth()`/`getDate()`
 * equivalents, so an assertion that only relies on the environment's
 * ambient timezone would pass identically under a regressed local-getter
 * implementation. This epic already shipped one UTC guard (T2.1.3's own
 * keys.test.ts) that made exactly that mistake in an early draft; a
 * positive offset is what forces UTC and local to actually disagree.
 *
 * **Call this ONCE PER INSTANT you read a local Date getter against —
 * never once around multiple `vi.setSystemTime()` instants.** A
 * `@sinonjs/fake-timers`/Node interaction (the engine behind Vitest's
 * `vi.useFakeTimers()`) means a SECOND local-getter read taken inside one
 * HELD pin — after a second `vi.setSystemTime()` call moves the fake
 * clock — can silently return a STALE result instead of reflecting the new
 * instant, even though `process.env.TZ` itself never changed in between.
 * `salt.test.ts`'s own UTC-midnight rotation case (T2.3.6) hit this for
 * real: an early draft held ONE `withPinnedTz` call around TWO
 * `vi.setSystemTime()` + read pairs, and passed unchanged against a
 * deliberately broken (local-getter) `formatUtcDate` — the exact
 * regression the test existed to catch, discovered only once a SIBLING
 * task's own rotation guard (T2.3.9) hit the identical failure and traced
 * it back here. The fix is to call `withPinnedTz` again for every instant:
 * `process.env.TZ = tz` below is a genuine write each time, even when `tz`
 * is the same string as last time, and that write is what clears the
 * staleness. So: wrap each `vi.setSystemTime()` + read pair in ITS OWN
 * `withPinnedTz(tz, () => { vi.setSystemTime(instant); return read(); })`
 * call — never hoist one pin around more than one instant.
 */
export function withPinnedTz<T>(tz: string, fn: () => T): T {
  const originalTz = process.env.TZ;
  process.env.TZ = tz;

  try {
    return fn();
  } finally {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  }
}
