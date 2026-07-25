import { SECRET_REDACTION_PLACEHOLDER } from './env';

// S2.2 story-fan-out review (CRITICAL, silent-failure-hunter) — a
// DIFFERENT redaction problem from env.ts's redactSecrets, which lives
// next to it there. redactSecrets operates on a known-shaped config
// object and redacts WHOLE VALUES by KEY NAME (e.g. the entire
// DATABASE_URL field). This module instead operates on ARBITRARY TEXT —
// an ioredis or `pg` error's own `.message` — which has no keys to
// redact by, only a credential-bearing URL embedded somewhere inside it
// to find and partially scrub.
//
// Why this exists: ioredis (and `pg`) embed the CONNECTION URL — password
// and all — directly in a connection error's `.message` (e.g. "connect
// ECONNREFUSED redis://user:s3cret@host:6379"). apps/api/src/redirect's
// describeError() (resolve-redis.ts) previously assumed extracting only
// `.message` (never the raw Error object) was enough, on the theory that
// the raw object might carry MORE than the message does. That is true,
// but irrelevant: the message ITSELF is exactly where ioredis puts the
// credential, so ".message is safer than the object" does not imply
// ".message is safe to log". This function is what closes that gap,
// reused everywhere a Redis/Postgres connection-error message reaches a
// logger — resolve-redis.ts's describeError today, and T2.4.4's
// enqueue-failure logging next (its own brief states outright that
// REDIS_URL's embedded password must be redacted before the message is
// written, so this is built once here rather than twice).

// [security fix round 1, T2.4.4 review] The original implementation
// matched `scheme://userinfo@` with a single regex whose userinfo
// character class (`[^\s@/]+`) EXCLUDED `/` and stopped at the FIRST
// `@`. That works for a "clean" credential, and breaks — partially or
// completely — the moment a real password contains either: a literal
// `@` left `...ssword@host:6379` in cleartext right behind a correctly
// redacted `p@`, and a literal `/` matched NOTHING at all, passing the
// whole credential through untouched. Base64-alphabet passwords —
// exactly what managed Redis providers (Upstash, Redis Cloud,
// ElastiCache AUTH tokens) commonly generate — routinely contain both.
//
// Widening the character class again would only produce the next gap
// for the next unusual password shape: guessing at which characters a
// credential can contain is the actual bug, not any one specific
// exclusion. The fix is structural instead: find candidate `scheme://`
// TEXT with a regex (below), then hand each candidate to `new URL()` — a
// real, spec-compliant parser — and let ITS userinfo/host boundary
// decide what gets redacted, never a hand-written character class.
//
// Bounded by the next whitespace (or the end of the string), which is
// the natural boundary for a connection string embedded in a one-line
// log/error message — see this file's test suite for the shapes this
// covers (multiple embedded URLs in one message, trailing path/query
// fragments, ...).
const URL_LIKE_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g;

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Redacts ONE `scheme://...` chunk (a single match of
 * {@link URL_LIKE_PATTERN}), used as `String.prototype.replace`'s
 * per-match callback.
 *
 * The common case: `new URL(chunk)` parses successfully. WHATWG's own
 * authority parser finds the TRUE userinfo/host boundary — the LAST `@`
 * before the host — handling a literal `@` inside a password correctly
 * (it becomes part of `.password`, percent-encoded, not a second
 * delimiter), along with percent-encoded credentials and arbitrary
 * punctuation, none of which a hand-written character class can keep up
 * with. Only `.protocol`/`.host`/`.pathname`/`.search`/`.hash` are used
 * to rebuild the redacted string — `.username`/`.password` are read only
 * to detect WHETHER there is a credential to redact, never echoed.
 *
 * The one case `new URL()` cannot resolve: a credential containing an
 * UNESCAPED `/`. RFC 3986 requires `/` to be percent-encoded inside
 * userinfo — a raw one there is indistinguishable from a path separator
 * to any URL parser, so the input was never a valid URI to begin with
 * (most likely an app that built `REDIS_URL`/`DATABASE_URL` by
 * interpolation without encoding the password). `new URL()` throws for
 * this shape, and this function must not let that throw escape — an
 * error-LOGGING path is exactly where a redactor throwing would be its
 * own bad failure mode — but it also must not fall back to the raw
 * chunk, since leaving it untouched IS the leak this function exists to
 * close. The safe default is to redact the WHOLE chunk, keeping only the
 * scheme (which can never contain user-supplied content): host and port
 * are sacrificed, but ONLY for input that was already malformed, never
 * for a well-formed connection string.
 */
function redactUrlLikeChunk(chunk: string): string {
  let parsed: URL;
  try {
    parsed = new URL(chunk);
  } catch {
    const scheme = SCHEME_PATTERN.exec(chunk)?.[0] ?? '';
    return `${scheme}${SECRET_REDACTION_PLACEHOLDER}`;
  }

  if (parsed.username === '' && parsed.password === '') {
    // No credential to redact. Returns the ORIGINAL chunk, not a
    // reconstruction from the parsed URL's own components: WHATWG URL
    // normalizes host casing/IDNA and can alter percent-encoding in ways
    // that would silently change a message this function is supposed to
    // leave byte-identical — see this file's own "leaves a
    // credential-free URL unchanged" test.
    return chunk;
  }

  return `${parsed.protocol}//${SECRET_REDACTION_PLACEHOLDER}@${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Redacts any `scheme://user:pass@host` credentials embedded in an
 * arbitrary message, replacing only the userinfo with
 * {@link SECRET_REDACTION_PLACEHOLDER} — the same placeholder
 * `redactSecrets` (env.ts) uses, so a redacted value reads identically
 * wherever it appears. Safe to call on ANY string, including one with no
 * embedded URL at all (returned unchanged) or one with several (every
 * occurrence is redacted independently, via {@link URL_LIKE_PATTERN}'s
 * `g` flag). Never throws, regardless of how malformed an embedded
 * `scheme://...` chunk is — see {@link redactUrlLikeChunk}.
 */
export function redactCredentialsFromMessage(message: string): string {
  return message.replace(URL_LIKE_PATTERN, redactUrlLikeChunk);
}
