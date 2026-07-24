// T2.1.3 — the ONE place every Redis key string in Posta's keyspace
// (spec §9) gets built: `link:{tenant}:{slug}` (the hot link cache),
// `handle:{handle}` (reserved for handle-scoped lookups), and
// `salt:YYYY-MM-DD` (the daily visitor-hash salt, invariant 6). Every
// later task that reads or writes one of these keys — T2.2.x's slug
// cache, T2.3.6's salt manager, T2.4.2's BullMQ producer — imports these
// builders instead of formatting a template string inline, so the
// keyspace has exactly one definition and a rename here is a one-file
// change instead of a grep-and-hope.
//
// No runtime sanitisation of `tenant` / `slug` / `handle` here, on
// purpose: by the time any of these builders run, the input has already
// been validated upstream — `slug` by contracts' isValidSlug
// (SLUG_PATTERN's charset + SLUG_MAX_LENGTH), `handle` by
// packages/contracts/src/domain.ts's parseHandleFromHost, which enforces
// HANDLE_PATTERN's lowercase-alnum-and-hyphen charset AND a 63-character
// length ceiling (HANDLE_MAX_LENGTH, RFC 1035's DNS label limit) before
// ever returning a handle to a caller — added in the S2.1 story-review
// batch, T2.1.5's fallback fix, after a review found that charset/length
// gate lived only in domain.ts's OTHER handle function
// (assertClaimableHandle, the URL-construction direction) and not in the
// parse direction this module's own callers (T2.2.2's resolveTenant, the
// redirect hot path) actually go through — so this file's claim of
// "already validated upstream" was false until that fix landed. `tenant`
// is a ULID minted by this package's own newId(). Re-validating here
// would be a second, divergent copy of rules that already live in
// exactly one place, spent on the redirect hot path for no safety this
// module's callers don't already provide [INV-2].

/** Hot link cache: `tenant` + `slug` → resolved destination. 1h TTL
 * (spec §9); the TTL itself is set by the caller (T2.2.x), not here. */
export function linkKey(tenant: string, slug: string): string {
  return `link:${tenant}:${slug}`;
}

/** Handle-scoped lookups keyed by `handle` alone. */
export function handleKey(handle: string): string {
  return `handle:${handle}`;
}

/**
 * Formats a `Date` as `YYYY-MM-DD` on its UTC calendar day — never local
 * time. Exported on its own (not just inlined into {@link saltKey})
 * because T2.3.6's salt manager needs the IDENTICAL string as its own
 * process-local memo key. A second, independently-written formatter
 * there — especially one built on `getFullYear()`/`getMonth()`/
 * `getDate()` instead of the UTC accessors — would rotate the salt at
 * the wrong instant on a machine whose local timezone isn't UTC, and
 * split one UTC day's visitor hashes across two different salts.
 */
export function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Daily visitor-hash salt (invariant 6). 48h TTL (spec §9); the TTL
 * itself is set by the caller (T2.3.6), not here. Takes a `Date`, not a
 * preformatted string — see {@link formatUtcDate} for why the UTC
 * formatting has to live in exactly one place. */
export function saltKey(dateUtc: Date): string {
  return `salt:${formatUtcDate(dateUtc)}`;
}
