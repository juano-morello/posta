import { isValid, monotonicFactory } from 'ulid';

// T1.1.3 — the ONE place a Posta id is generated. IDs are created in
// application code and stored as `text` — never a database default (see
// CLAUDE.md) — so the same id exists before the row does, and can be
// logged, queued, or retried ahead of the insert.
//
// monotonicFactory(), not the bare `ulid()` export: a plain ulid() only
// guarantees lexicographic ordering ACROSS distinct milliseconds — two
// calls within the same millisecond get independent random suffixes with
// no ordering guarantee between them. This module's own contract ("ids
// generated in sequence sort by creation order") has to hold even under a
// tight loop, which is exactly what the monotonic factory's per-millisecond
// incrementing random component gives.
const generateMonotonicUlid = monotonicFactory();

const ULID_LENGTH = 26;
// Crockford's base32 alphabet: 0-9 and A-Z minus the four visually
// ambiguous letters (I, L, O, U) — the same alphabet the `ulid` package
// itself encodes with.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A 26-char Crockford ULID, branded so a bare `string` can't be passed
 * where an id is expected without going through {@link newId} or
 * {@link isUlid} first. */
export type Ulid = string & { readonly __brand: 'Ulid' };

/** Type guard: true only for a genuine 26-char Crockford ULID — rejects a
 * UUID (hyphenated, lowercase hex, wrong alphabet), wrong-length strings,
 * and the empty string. */
export function isUlid(value: string): value is Ulid {
  return value.length === ULID_LENGTH && ULID_PATTERN.test(value) && isValid(value);
}

/**
 * Generates a new id: a 26-char ULID, monotonic within this process even
 * across calls made in the same millisecond.
 *
 * The cast to `Ulid` below is a trust boundary on the `ulid` package: this
 * is the ONE place that boundary is crossed, so it is checked at runtime
 * rather than assumed — if `monotonicFactory()` ever produced something
 * malformed (a library bug, a future breaking change), this throws
 * immediately at the point ids are minted instead of silently handing out
 * a value that only fails a downstream isUlid()/DB constraint check much
 * later, far from its actual origin.
 */
export function newId(): Ulid {
  const generated = generateMonotonicUlid();

  if (!isUlid(generated)) {
    throw new Error(`ulid's monotonicFactory() produced a malformed id: "${generated}"`);
  }

  return generated;
}
