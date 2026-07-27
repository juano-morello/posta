// T3.2.4 (E3, S3.2) — destHost() derives a queryable `dest_host` fact from a
// stored redirect destination. This is enrichment, not capture: the capture
// DTO (packages/contracts/src/capture.ts) does not even carry a
// `destination` field, so whatever stores the destination verbatim keeps
// the RAW value recoverable from R2 (invariant 7 — R2 is the source of
// truth for events). This function never sees, mutates, or discards that
// original string; it is handed a destination and returns one derived
// fact, nothing more (invariant 4 — a structural fact, never a verdict).
//
// Built on the WHATWG URL global (Node built-in, no new dependency). The
// URL constructor is pure string parsing — it does not perform DNS
// resolution or any network I/O — so this stays a pure, deterministic
// function safe to call from the redirect hot path or the worker's
// enrichment step alike.
//
// Same null-safe, never-throw discipline as T3.2.1's parseUserAgent
// (./ua.ts): a destination that doesn't parse as a URL resolves to `null`
// rather than propagating an exception. A malformed or garbage destination
// is an expected shape of real-world input here, not an operational
// failure worth crashing enrichment over.

/**
 * Extracts the lowercased host from a redirect destination, stripping
 * query string, fragment, port, and userinfo (`username:password@`).
 *
 * Returns `null` for any value the `URL` constructor can't parse —
 * including the empty string — rather than throwing.
 *
 * Userinfo is deliberately never part of the return value: `URL#hostname`
 * (unlike `URL#host`) never includes it, and a destination someone pasted
 * with embedded credentials must not leak them into a value that can end
 * up in a dashboard-facing analytics field.
 */
export function destHost(destination: string): string | null {
  if (destination === '') {
    return null;
  }

  try {
    return new URL(destination).hostname.toLowerCase();
  } catch {
    return null;
  }
}
