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

// Matches `scheme://userinfo@` — e.g. `redis://user:s3cret@` or
// `postgresql://posta:Tr0ub4dor-AndFour@` — and redacts ONLY the
// userinfo, never the scheme, host, or port. The host and port are
// exactly what makes a connection error diagnosable ("which instance
// refused this connection?"), so nuking the whole URL (or the whole
// message) would trade a real credential leak for a log line useless for
// its actual purpose. `[^\s@/]+` bounds the userinfo match to characters
// that cannot themselves contain an unescaped `@` or `/`, which is what
// keeps this from either under-matching (stopping short of the `@`) or
// over-matching into a following path segment.
const CREDENTIAL_URL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s@/]+@/g;

/**
 * Redacts any `scheme://user:pass@host` credentials embedded in an
 * arbitrary message, replacing only the userinfo with
 * {@link SECRET_REDACTION_PLACEHOLDER} — the same placeholder
 * `redactSecrets` (env.ts) uses, so a redacted value reads identically
 * wherever it appears. Safe to call on ANY string, including one with no
 * embedded URL at all (returned unchanged) or one with several (every
 * occurrence is redacted, via the pattern's `g` flag).
 */
export function redactCredentialsFromMessage(message: string): string {
  return message.replace(CREDENTIAL_URL_PATTERN, `$1${SECRET_REDACTION_PLACEHOLDER}@`);
}
