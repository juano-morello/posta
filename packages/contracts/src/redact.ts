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

// [security fix round 2, T2.4.4 review] `\S+` has no RIGHT boundary, so
// a candidate immediately followed by ordinary prose punctuation — no
// whitespace in between, e.g. "...host:6379; retrying", "(see
// redis://...)", "...host:6379]" — swept that punctuation into the
// chunk `new URL()` was asked to parse. When the trailing character
// broke port/host parsing, the malformed-input fallback fired and
// dropped host:port for what was actually a WELL-FORMED connection
// string: a real regression against the pre-fix regex (which never
// reached past the userinfo `@` to begin with) and a contradiction of
// this file's own guarantee, two paragraphs below, that host:port
// survive for anything but genuinely malformed input.
//
// The fix does NOT reopen "guess at a character class for the
// CREDENTIAL" — the problem the round-1 fix moved away from. It only
// decides how much TRAILING PROSE PUNCTUATION to peel off the candidate
// before handing the remainder to `new URL()`, then glues the exact
// same trailing characters back onto whatever comes out, verbatim,
// regardless of what happened inside. The credential boundary itself is
// still decided entirely by the parser, never by this set. Matches (in
// full) each get treated the same way whether or not there is a
// credential inside them, so a well-formed, credential-free URL ending
// in this same punctuation (`https://h/x?y=1)`) is unaffected too — see
// `redactUrlLikeChunk`'s no-credential branch, which always returns the
// full original chunk (trailing punctuation included) untouched.
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}>'"]+$/;

/**
 * Redacts ONE `scheme://...` chunk (a single match of
 * {@link URL_LIKE_PATTERN}), used as `String.prototype.replace`'s
 * per-match callback.
 *
 * First splits off any trailing prose punctuation
 * ({@link TRAILING_PUNCTUATION_PATTERN}) — see that constant's own
 * comment — parsing only what remains (`urlPart`) and re-appending
 * `trailing` to whatever this function returns, unmodified, on every
 * path below.
 *
 * The common case: `new URL(urlPart)` parses successfully. WHATWG's own
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
 * close. The safe default is to redact the WHOLE `urlPart`, keeping only
 * the scheme (which can never contain user-supplied content): host and
 * port are sacrificed, but ONLY for input that was already malformed,
 * never for a well-formed connection string.
 *
 * Known, accepted limit — NOT handled, deliberately (out of scope; no
 * existing input in this codebase produces it): an IPv6 host with no
 * port, e.g. `redis://user:pass@[::1]`, ends in a bracket this pattern's
 * `]` would trim, breaking the parse the same way any other malformed
 * input does (fails closed to the scheme-only fallback, no leak — just
 * lost diagnosability for that one narrow shape).
 */
function redactUrlLikeChunk(chunk: string): string {
  const trailingMatch = TRAILING_PUNCTUATION_PATTERN.exec(chunk);
  const urlPart = trailingMatch ? chunk.slice(0, trailingMatch.index) : chunk;
  const trailing = trailingMatch ? trailingMatch[0] : '';

  let parsed: URL;
  try {
    parsed = new URL(urlPart);
  } catch {
    const scheme = SCHEME_PATTERN.exec(urlPart)?.[0] ?? '';
    return `${scheme}${SECRET_REDACTION_PLACEHOLDER}${trailing}`;
  }

  if (parsed.username === '' && parsed.password === '') {
    // No credential to redact. Returns the ORIGINAL chunk (urlPart +
    // trailing, i.e. byte-identical to the input), not a reconstruction
    // from the parsed URL's own components: WHATWG URL normalizes host
    // casing/IDNA and can alter percent-encoding in ways that would
    // silently change a message this function is supposed to leave
    // untouched — see this file's own "leaves a credential-free URL
    // unchanged" test.
    return chunk;
  }

  return `${parsed.protocol}//${SECRET_REDACTION_PLACEHOLDER}@${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}${trailing}`;
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

// T3.7.8 [INV-6][security] — a DIFFERENT redaction problem from
// redactCredentialsFromMessage above, one layer down: that function
// scrubs credentials out of free TEXT with no keys to redact by; this one
// scrubs forbidden KEYS out of a parsed JSON STRUCTURE. Both belong in
// this file for the same reason — isomorphic, zero server dependencies,
// reused everywhere the same class of leak can occur.
//
// Invariant 6 is two clauses, not one: "the raw IP is never stored or
// queued" AND "no cookies, ever". A DLQ entry landing in Redis (T3.7.9,
// which wires this function in — NOT this task) is both "stored" and
// "queued", so a malformed capture payload sitting there with a raw IP or
// a raw cookie violates the invariant today. This constant and function
// are the single source of truth for the forbidden-key vocabulary from
// here on.
//
// [security fix round 1, post-commit review 75e5f2e] T2.3.8's regex
// (`/ip|addr|forwarded|cookie/i`, apps/api/src/redirect/capture-privacy.
// test.ts, referenced at 02-redirect-hot-path.md:168) matches by
// SUBSTRING over free log TEXT, which is strictly more permissive than
// this Set's exact-match-per-key semantics can ever be: the regex also
// flags ordinary English words containing "ip"/"addr"/"forwarded"/
// "cookie" ("zip", "shipping", "cookiecutter", ...) that have nothing to
// do with invariant 6. A literal claim that this vocabulary is a
// mathematical superset of everything that regex matches is therefore
// false and unmaintainable — the regex's match set is effectively
// infinite. What this vocabulary DOES commit to (verified by this file's
// own test suite, in both directions): every CONCRETE, known header
// alias that regex was written to catch — the standard forwarding/
// client-IP headers (`X-Forwarded-For`, `Forwarded` per RFC 7239,
// `X-Real-IP`), the CDN-specific ones (Cloudflare's
// `CF-Connecting-IP`, Fastly's `Fastly-Client-IP`, Akamai/others'
// `True-Client-IP`, the generic `X-Client-IP`), `Cookie`/`Set-Cookie`,
// and the flat `ip`/`client_ip`/`remote_addr` field names this codebase's
// own payloads would use — has a representative entry here, in BOTH its
// `-` and `_` spellings where a header name can plausibly appear either
// way on the wire or in a JSON key. The original round only paired
// `x-forwarded-for`/`x_forwarded_for`; the asymmetry on the rest (no
// underscore variant for `cf-connecting-ip`, `true-client-ip`,
// `set-cookie`, no dash variant for `client_ip`/`remote_addr`) was an
// oversight, not a decision, and is fixed below. `cookie`/`set-cookie`
// are present because the invariant's second clause is not derivable
// from its first; nothing about "no raw IP" implies "no cookie".
export const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'ip',
  'client_ip',
  'client-ip',
  'remote_addr',
  'remote-addr',
  'x-forwarded-for',
  'x_forwarded_for',
  'forwarded',
  'x-real-ip',
  'x_real_ip',
  'x-client-ip',
  'x_client_ip',
  'cf-connecting-ip',
  'cf_connecting_ip',
  'true-client-ip',
  'true_client_ip',
  'fastly-client-ip',
  'fastly_client_ip',
  'cookie',
  'set-cookie',
  'set_cookie',
]);

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase());
}

// Path representation for `redactedKeys` — chosen to read like the JS
// property-access expression that would reach the same value, so a DLQ
// operator (T3.7.9's actual consumer) can tell at a glance where the
// violation was: a top-level `ip` key is just `ip`; a nested,
// identifier-safe key is dotted (`headers.cookie`); a nested key that is
// NOT a valid identifier (contains `-`, starts with a digit, ...) is
// bracket-quoted (`headers['x-forwarded-for']`), since `headers.x-forwarded-for`
// would not parse as JS at all; an array element is bracket-indexed
// (`items[0].cookie`).
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function buildPropertyPath(parentPath: string, key: string): string {
  const segment = IDENTIFIER_PATTERN.test(key) ? key : `['${key}']`;
  if (parentPath === '') {
    return segment;
  }
  return IDENTIFIER_PATTERN.test(key) ? `${parentPath}.${key}` : `${parentPath}${segment}`;
}

function buildIndexPath(parentPath: string, index: number): string {
  return `${parentPath}[${index}]`;
}

// Bounds recursion depth so a payload that is by definition already
// malformed (this function's whole reason to exist — see the module
// comment above) cannot exhaust the call stack. 50 is comfortably deeper
// than any real capture/DLQ payload (CaptureEventSchema, capture.ts, is a
// single flat object) while stopping well short of Node's default stack
// limit even for a pathological, deliberately-deep input (this file's own
// test suite exercises 200 levels). A subtree beyond the limit is
// replaced with a placeholder rather than walked further — losing
// diagnosability for that one pathological shape is the accepted cost of
// never recursing forever.
const MAX_REDACTION_DEPTH = 50;

// Exported (with CIRCULAR_REFERENCE_PLACEHOLDER, below) so this file's own
// test suite can assert on the ACTUAL sentinel value rather than a
// hand-copied string literal that could silently drift out of sync with
// it, and so a regression test for "depth truncation actually fired" can
// search the serialized output for this exact marker instead of just
// checking the call didn't throw — a call not throwing is true whether
// truncation ran or the input simply wasn't deep enough to need it.
export const MAX_DEPTH_EXCEEDED_PLACEHOLDER = '[MAX_DEPTH_EXCEEDED]';

// A self-referencing object (`a.self = a`) is not valid JSON and cannot
// have come from `JSON.parse`, but this function's whole premise is that
// its input already failed validation and cannot be trusted to be
// well-formed — see the module comment above. `ancestors` tracks only the
// objects on the CURRENT recursion path (added on entry, removed on
// backtrack via `finally`), not every object ever visited: a DAG where
// the same object is legitimately reachable via two different paths (not
// a cycle) must still be walked twice, and a global "already seen" set
// would wrongly collapse that case too. Exported for the same reason as
// MAX_DEPTH_EXCEEDED_PLACEHOLDER above.
export const CIRCULAR_REFERENCE_PLACEHOLDER = '[CIRCULAR_REFERENCE]';

interface RedactionContext {
  readonly ancestors: WeakSet<object>;
  readonly redactedKeys: string[];
}

function redactNode(node: unknown, path: string, depth: number, ctx: RedactionContext): unknown {
  if (node === null || typeof node !== 'object') {
    return node;
  }

  if (depth >= MAX_REDACTION_DEPTH) {
    return MAX_DEPTH_EXCEEDED_PLACEHOLDER;
  }

  if (ctx.ancestors.has(node)) {
    return CIRCULAR_REFERENCE_PLACEHOLDER;
  }

  ctx.ancestors.add(node);
  try {
    if (Array.isArray(node)) {
      return node.map((item, index) =>
        redactNode(item, buildIndexPath(path, index), depth + 1, ctx),
      );
    }

    const source = node as Record<string, unknown>;
    // [security fix round 1, post-commit review 75e5f2e] `JSON.parse`
    // creates a literal `__proto__` KEY as an ordinary own data property
    // (spec-guaranteed — internalizeJSONProperty uses CreateDataProperty,
    // which never triggers Object.prototype's `__proto__` accessor), so
    // Object.keys(source) picks it up correctly on the READ side above.
    // The WRITE side does not get that guarantee for free: a plain `{}`
    // object literal's `__proto__` IS Object.prototype's accessor, so
    // `result['__proto__'] = redactedValue` would not create an own
    // property at all — it would reassign `result`'s prototype (or
    // no-op for a primitive redactedValue), silently dropping the whole
    // subtree from the output while `ctx.redactedKeys` still recorded it
    // as present. `Object.create(null)` gives `result` no inherited
    // `__proto__` accessor to intercept the assignment, so a literal
    // `__proto__` key behaves as an ordinary own property on both read
    // and write.
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (isForbiddenKey(key)) {
        result[key] = SECRET_REDACTION_PLACEHOLDER;
        ctx.redactedKeys.push(buildPropertyPath(path, key));
      } else {
        result[key] = redactNode(source[key], buildPropertyPath(path, key), depth + 1, ctx);
      }
    }
    return result;
  } finally {
    ctx.ancestors.delete(node);
  }
}

/** The result of {@link redactForbiddenKeys}: the redacted copy, plus the
 * property-access-style path of every key whose value was replaced (see
 * {@link buildPropertyPath}'s doc comment for the path format). An empty
 * `redactedKeys` means the input had nothing to redact — the exact shape
 * a valid `CaptureEvent` produces, since `CaptureEventSchema` is `.strict()`
 * and structurally cannot carry any of {@link FORBIDDEN_PAYLOAD_KEYS}.
 */
export interface RedactForbiddenKeysResult<T> {
  readonly value: T;
  readonly redactedKeys: readonly string[];
}

/**
 * Walks an arbitrary parsed JSON value — object, array, or primitive, at
 * any nesting depth — and returns a NEW structure (never mutates `value`)
 * with the VALUE of any object key matching {@link FORBIDDEN_PAYLOAD_KEYS}
 * (case-insensitively) replaced by {@link SECRET_REDACTION_PLACEHOLDER}.
 * The key itself, and its original casing, are preserved — only the value
 * underneath it is destroyed, which is the half invariant 6 forbids;
 * `redactedKeys` keeps the other half (that a forbidden key was present,
 * and where) so the entry stays diagnosable.
 *
 * Generic over `T` so a well-typed caller (a real `CaptureEvent`, for
 * instance) gets its own type back rather than `unknown`. This is safe
 * specifically BECAUSE `T` is meant to be a contract type: nothing in
 * this codebase's contracts ever legitimately declares a field named `ip`,
 * `cookie`, etc. (that is the whole point of this vocabulary), so for a
 * well-formed `T` no redaction ever fires and the returned value is
 * exactly `T`, unchanged. The type is NOT a sound guarantee for arbitrary,
 * already-malformed input (T3.7.9's `job.data` case) — there, `T` is
 * whatever the untyped queue payload was typed as by the caller, and a
 * redacted field's runtime value (the placeholder string) may no longer
 * match that field's declared type. That mismatch is accepted rather than
 * hidden behind a wider return type, because the caller in that situation
 * already knows the payload is untrustworthy.
 */
export function redactForbiddenKeys<T>(value: T): RedactForbiddenKeysResult<T> {
  const ctx: RedactionContext = { ancestors: new WeakSet(), redactedKeys: [] };
  const redactedValue = redactNode(value, '', 0, ctx) as T;
  return { value: redactedValue, redactedKeys: ctx.redactedKeys };
}
