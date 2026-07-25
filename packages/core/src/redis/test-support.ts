// Shared test-only support for packages/core/src/redis's own test files
// (keys.test.ts, salt.test.ts) — a plain sibling module, not a *.test.ts
// file itself, so importing it never re-executes another file's own
// describe()/it() blocks the way importing a *.test.ts file directly
// would (each Vitest test file gets its own isolated module registry, so
// a static import of another test file re-runs its whole top-level body).
// Same role apps/api/src/redirect/resolve-test-support.ts plays for that
// folder's test files.

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
