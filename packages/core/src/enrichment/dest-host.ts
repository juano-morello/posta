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
 * including the empty string — rather than throwing. Also returns `null`
 * (never the empty string) for a value the `URL` constructor DOES parse
 * successfully but that has no authority component, e.g. `javascript:` or
 * `mailto:` — `new URL(...).hostname` reports `''` for those, and this
 * function normalizes that into the same "no usable host" `null` the rest
 * of its contract already uses, rather than handing callers a second,
 * falsy-but-not-null shape to check for. `zDestination`
 * (packages/contracts/src/links.ts) already restricts stored destinations
 * to http(s), where this case can't arise, but this function stays
 * defensive for any caller that hands it unvalidated input.
 *
 * Userinfo is deliberately never part of the return value: `URL#hostname`
 * (unlike `URL#host`) never includes it, and a destination someone pasted
 * with embedded credentials must not leak them into a value that can end
 * up in a dashboard-facing analytics field.
 *
 * SECURITY: the returned hostname is a structural fact, not an
 * output-encoded value. The WHATWG forbidden-host-code-point list blocks
 * characters like `<`, `>`, `@`, and `/`, but NOT `'`, `"`, backtick,
 * `;`, or parens/braces — a destination such as `https://a'b.com/`
 * round-trips to `a'b.com` unescaped. Callers MUST still escape/parameterize
 * this value before interpolating it into HTML, SQL, or a log line; this
 * function performs no output encoding of any kind.
 */
export function destHost(destination: string): string | null {
  if (destination === '') {
    return null;
  }

  try {
    const hostname = new URL(destination).hostname.toLowerCase();

    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}
