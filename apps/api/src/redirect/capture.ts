import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { newId } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';

// T2.3.2 — reads the request's own spec §5.1 header-derived signals for
// the capture payload T2.3.7 assembles. `country`/`asn`/`visitor_hash`
// are DERIVED values (a geoip lookup, a salted hash) this file has no
// business computing — T2.3.5 and T2.3.6/T2.3.7 own those — and
// `event_id`/`occurred_at`/`tenant_id`/`link_id`/`slug` are queue
// context this function is never given. `HeaderSignals` below is a
// `Pick` of `CaptureEvent`'s own inferred type for exactly that reason:
// it can only ever be a genuine subset of CaptureEvent's real keys, so
// a rename or removal in capture.ts (packages/contracts) is a compile
// error here instead of two files silently drifting apart.
//
// THE RULE THIS FILE EXISTS TO ENFORCE (invariant 6, at the read
// boundary): readSignals(req) never spreads or iterates req.headers.
// Every signal is read by its own explicit, hardcoded header name
// below. A spread (`{ ...req.headers }`) would silently drag `cookie`,
// `x-forwarded-for` and `cf-connecting-ip` into the payload the moment
// this return type widens — explicit naming means a new header enters
// the payload only when a human writes its name down here. The ONLY
// spread anywhere in this file is `...readPrefetchTells(headers)`, and
// that spreads a same-shaped LOCAL object with exactly four named keys
// — never `req.headers` or `headers` itself; grep this file for
// `...headers` and it will not appear. capture.test.ts's "never leaks
// an unlisted header" case is the regression guard: it goes red the
// instant that property stops holding.

/**
 * The 16 spec §5.1 signals read directly off the request — every
 * `CaptureEvent` key EXCEPT the identity/context fields (`event_id`,
 * `occurred_at`, `tenant_id`, `link_id`, `slug` — unknown to this
 * function) and the three derived network/identity fields (`country`,
 * `asn`, `visitor_hash` — computed elsewhere, from the IP this function
 * never touches).
 */
export type HeaderSignals = Pick<
  CaptureEvent,
  | 'http_method'
  | 'user_agent'
  | 'referer'
  | 'accept'
  | 'accept_language'
  | 'sec_fetch_site'
  | 'sec_fetch_mode'
  | 'sec_fetch_dest'
  | 'sec_fetch_user'
  | 'sec_purpose'
  | 'sec_ch_ua'
  | 'sec_ch_ua_mobile'
  | 'sec_ch_ua_platform'
  | 'purpose'
  | 'x_purpose'
  | 'x_moz'
>;

/**
 * The minimal request shape `readSignals` needs — `method` and
 * `headers` only, never the full Express `Request`. Keeping the
 * parameter this narrow is itself part of invariant 6's enforcement:
 * there is no `req.ip` (or anything else) reachable through this type
 * for a future edit to reach for by mistake.
 *
 * Defined locally rather than `Pick<express.Request, 'method' |
 * 'headers'>`: Express's own `Request` type widens `method` from Node's
 * `string | undefined` to a required `string`, which a raw
 * `http.IncomingMessage` (what Node hands a server callback before
 * Express ever touches it — see capture.test.ts's case-normalization
 * test) does not actually guarantee. `method?: string | undefined`
 * here matches Node's real contract exactly — the repo runs
 * `exactOptionalPropertyTypes`, under which a bare `method?: string`
 * would be a NARROWER type than Node's own and reject a real
 * `http.IncomingMessage`. A real Express `Request` still satisfies this
 * type structurally (a required `string` is assignable to an optional
 * `string | undefined`), so this is strictly wider, not a different
 * shape.
 */
export interface CaptureRequest {
  readonly method?: string | undefined;
  readonly headers: IncomingHttpHeaders;
}

/**
 * Reads one header by its lowercase name. Node's HTTP parser already
 * lowercases every incoming header name before Express ever sees it
 * (`Accept-Language` and `accept-language` land at the same
 * `req.headers` key) — this function relies on that platform guarantee
 * rather than re-implementing case-folding itself, so every call site
 * below passes the lowercase form directly.
 *
 * Two decisions made once here rather than per call site:
 *
 * - A repeated header can arrive as `string[]` (TypeScript's
 *   `IncomingHttpHeaders` allows it for any header name not on Node's
 *   short explicit list, via its index signature), even though in real
 *   traffic none of the headers this file reads are legitimately sent
 *   twice. The FIRST element is used — the same value Node itself keeps
 *   for the handful of headers it deduplicates outright — rather than
 *   the last or a comma-join: joining could silently turn two
 *   CONFLICTING values (two different `sec-fetch-site` headers, say)
 *   into one string that means neither of the things it originally
 *   said.
 * - An absent header (`undefined`) becomes `null` — the schema's
 *   explicit "we did not see this" value. A header sent WITH an empty
 *   value stays `''`, not `null`: the client still sent the header, so
 *   that is different evidence from never sending it at all, and
 *   `CaptureEventSchema`'s `z.string().nullable()` (no `.min(1)`)
 *   accepts `''` for exactly this reason.
 */
function readHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * The four prefetch tells — `sec-purpose`, `purpose`, `x-purpose`,
 * `x-moz` — read together as their own function, on purpose (T2.3.2's
 * brief). They do more classification work than any other signal
 * group: browsers self-declare prefetches, and a Chrome prefetch
 * carries a legitimate Chrome UA, so without these four, prefetch
 * traffic sails through as human and the product's core claim breaks.
 * A dedicated function with ONE typed return statement means a future
 * edit that drops one of the four breaks `readPrefetchTells`'s own
 * return type at compile time, rather than silently vanishing inside a
 * 16-property object literal.
 */
function readPrefetchTells(
  headers: IncomingHttpHeaders,
): Pick<HeaderSignals, 'sec_purpose' | 'purpose' | 'x_purpose' | 'x_moz'> {
  return {
    sec_purpose: readHeader(headers, 'sec-purpose'),
    purpose: readHeader(headers, 'purpose'),
    x_purpose: readHeader(headers, 'x-purpose'),
    x_moz: readHeader(headers, 'x-moz'),
  };
}

/**
 * Reads the 16 spec §5.1 header-derived signals off one request. Pure
 * and synchronous — no I/O, no allocation beyond the object literal
 * this returns — so it costs nothing beyond reading 16 named
 * properties on the hot path (invariant 2). `http_method` comes from
 * `req.method`, not a header: a `HEAD` request is never a human
 * clicking a link, and is trivially lost if this stopped being read
 * explicitly.
 */
export function readSignals(req: CaptureRequest): HeaderSignals {
  const { headers } = req;

  return {
    http_method: req.method ?? null,
    user_agent: readHeader(headers, 'user-agent'),
    referer: readHeader(headers, 'referer'),
    accept: readHeader(headers, 'accept'),
    accept_language: readHeader(headers, 'accept-language'),
    sec_fetch_site: readHeader(headers, 'sec-fetch-site'),
    sec_fetch_mode: readHeader(headers, 'sec-fetch-mode'),
    sec_fetch_dest: readHeader(headers, 'sec-fetch-dest'),
    sec_fetch_user: readHeader(headers, 'sec-fetch-user'),
    sec_ch_ua: readHeader(headers, 'sec-ch-ua'),
    sec_ch_ua_mobile: readHeader(headers, 'sec-ch-ua-mobile'),
    sec_ch_ua_platform: readHeader(headers, 'sec-ch-ua-platform'),
    ...readPrefetchTells(headers),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// T2.3.7 [INV-6][security] — visitor_hash and immediate IP discard.
//
// The client IP funds exactly two derived values (a geoip lookup — T2.3.5,
// owned by packages/core/src/geoip/lookup.ts — and the salted hash below)
// and is dropped the instant both exist. `ClientIp` is what makes that
// STRUCTURAL rather than a comment asking nicely: it is a branded string,
// not `string` itself, so `readClientIp`'s return value cannot be passed
// anywhere that expects a plain `string | null` without an explicit cast a
// reviewer would have to see in a diff. Be precise about what that
// forecloses: TypeScript's types erase at runtime, so `ip as unknown as
// string` (or `String(ip)`) still compiles and still runs — the brand is
// not a capability boundary, it cannot stop a determined caller. What it
// DOES stop is the accidental path: the wrong local variable landing in a
// call that expects a hash, `ip` forwarded one call further than intended,
// or `ip` reused as if it were the user-agent string. `buildCapturePayload`
// below is the other half of the same idea: its parameter type has no slot
// a `ClientIp` fits, proven by this file's own `@ts-expect-error` test
// (capture.test.ts) — and that test is honest that bypassing the brand
// with an explicit cast still lets the leak through, because a type system
// cannot be a runtime guarantee.
//
// IP source order (this task's own dispatch — not literally in story
// S2.3's acceptance text): `CF-Connecting-IP` first — Cloudflare sets this
// itself on every request that reaches an origin through it — else the
// LEFTMOST `X-Forwarded-For` entry (the original client; everything to
// its right is a proxy hop it passed through). Both headers are
// attacker-spoofable by anyone who reaches the origin directly or
// controls an upstream proxy. That is a DATA-QUALITY question, not a
// privacy one: a spoofed IP changes which bucket a visitor_hash falls
// into (degrading "únicos hoy"'s accuracy), it does not leak anything —
// and validating the header's plausibility here would be validation
// theatre, since no check can turn an untrustworthy header into a
// trustworthy one; it would only imply a guarantee this code cannot make.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The raw client IP, branded so it cannot be passed anywhere a plain
 * `string` is expected without an explicit cast — see this file's header.
 * Produced only by {@link readClientIp}; consumed only by
 * {@link computeVisitorHash} here and by `lookupNetwork`
 * (packages/core/src/geoip/lookup.ts, T2.3.5) at the call site that
 * assembles a request (T2.4.x, out of this task's scope).
 */
export type ClientIp = string & { readonly __brand: 'ClientIp' };

/**
 * The salted, sliced sha256 digest {@link computeVisitorHash} produces —
 * branded DISTINCTLY from {@link ClientIp} so the two can never be
 * confused at a call site: a `ClientIp` is not assignable where a
 * `VisitorHash` is expected, even though both are plain strings at
 * runtime. This is the type {@link buildCapturePayload} actually accepts
 * for `visitorHash` — not `string` — which is what turns passing a
 * `ClientIp` there into a compile error instead of a silently-accepted
 * subtype (a plain `string` parameter WOULD silently accept a `ClientIp`,
 * since a brand only adds structure, it does not remove `string`'s own —
 * this second, distinct brand is the part that actually closes that gap).
 */
export type VisitorHash = string & { readonly __brand: 'VisitorHash' };

/**
 * The leftmost entry of a comma-separated `X-Forwarded-For` value — the
 * original client; every entry to its right is a proxy hop it passed
 * through. Blank (whitespace-only, or an empty leading entry like
 * `", 10.0.0.1"`) returns `null` rather than skipping ahead to the next
 * entry: "leftmost" means literally leftmost, not "leftmost non-empty".
 */
function leftmostForwardedFor(value: string): string | null {
  const leading = value.split(',')[0]?.trim() ?? '';
  return leading.length > 0 ? leading : null;
}

/**
 * Reads the client IP: `CF-Connecting-IP` when present and non-empty,
 * else the leftmost `X-Forwarded-For` entry, else `null`. A present-but-
 * empty `CF-Connecting-IP` is treated as absent here — unlike the generic
 * §5.1 signals `readSignals` reads above, where present-but-empty is
 * itself meaningful evidence — because an empty string cannot identify a
 * visitor, so falling through to `X-Forwarded-For` is strictly more
 * useful than returning one.
 *
 * No further validation is applied: both headers are attacker-spoofable
 * (see this file's header), and rejecting or "cleaning" a malformed value
 * would imply a trust guarantee this function cannot make. The IP is used
 * for nothing but the two derivations `readClientIp`'s callers make from
 * it — it is never stored, queued, or logged from here.
 */
export function readClientIp(headers: IncomingHttpHeaders): ClientIp | null {
  const cfConnectingIp = readHeader(headers, 'cf-connecting-ip');
  if (cfConnectingIp !== null && cfConnectingIp.length > 0) {
    return cfConnectingIp as ClientIp;
  }

  const forwardedFor = readHeader(headers, 'x-forwarded-for');
  if (forwardedFor === null) return null;

  const leftmost = leftmostForwardedFor(forwardedFor);
  return leftmost === null ? null : (leftmost as ClientIp);
}

const VISITOR_HASH_LENGTH = 32;

// [security, SPEC DEVIATION — flagged loudly per this task's dispatch,
// not done silently] Spec §9 / story S2.3 write the formula literally as
// `sha256(ip + user_agent + salt)` — bare concatenation, no delimiter.
// That is genuinely ambiguous at field boundaries: ip="1.2.3.4" with
// ua="Ax" and ip="1.2.3.4A" with ua="x" concatenate to the identical
// string before hashing and would collide, silently merging two
// different visitors into one bucket. A real user-agent string that
// happens to start with digits completing an IP octet is astronomically
// unlikely in practice, but the fix costs nothing and removes the
// ambiguity outright: a NUL byte can never appear in an IP literal
// (`readClientIp` only ever hands this function digits, dots, colons and
// hex from an already-parsed header) and RFC 7230's field-content grammar
// forbids control characters in a legal header value, so `'\u0000'` is
// always a safe, always-available separator between the three fields.
// This IS a literal deviation from the spec's bare `ip + user_agent +
// salt` — recorded here, in the open, exactly as this task's dispatch
// asked, rather than silently reordering or altering the formula.
const VISITOR_HASH_DELIMITER = '\u0000';

type VisitorHashField = 'ip' | 'userAgent' | 'salt';

/**
 * [security review, fix round 1] The delimiter's collision-avoidance
 * property (this file's header, above) rests on an assumption EXTERNAL
 * to this file: that Node's HTTP parser never hands a header value
 * containing a NUL byte through to application code. A raw-socket probe
 * against this app's own server primitive confirmed that assumption
 * holds today — Node returns `400 Bad Request` before any handler runs
 * — but nothing in this file enforces it. If the HTTP layer is ever
 * swapped, `--insecure-http-parser` is enabled for a legacy-client
 * workaround, or this function is reused on a string that never passed
 * through header parsing, the exact collision this file's header
 * describes reopens with nothing local to catch it.
 *
 * This assertion is that local backstop: it REJECTS (throws), rather
 * than silently stripping, any input that already contains the
 * delimiter — silently stripping would change the hash for an input
 * that should have been refused instead, which is worse than refusing
 * outright. The thrown message names only which FIELD was poisoned
 * (`'ip' | 'userAgent' | 'salt'`), never the value itself: one of these
 * three inputs is the client IP and another is the daily salt, and
 * invariant 6 (plus ordinary salt hygiene) means neither belongs in a
 * thrown message any more than in a log line.
 */
function assertNoHashDelimiter(value: string, field: VisitorHashField): void {
  if (!value.includes(VISITOR_HASH_DELIMITER)) return;

  throw new Error(
    `computeVisitorHash: ${field} contains the hash delimiter byte; refusing to hash rather ` +
      'than silently colliding at a field boundary. (The offending value is deliberately not ' +
      'included in this message — see capture.ts for why.)',
  );
}

/**
 * `sha256(ip + delimiter + user_agent + delimiter + salt)`, hex-encoded
 * and sliced to 32 characters (spec §9's `visitor_hash`, with the
 * delimiter deviation explained above). `userAgent: null` — the header
 * was absent, itself real evidence, e.g. of non-browser traffic — hashes
 * as the empty string in its slot; a request with no salt available
 * cannot occur, since `getDailySalt()` (packages/core/src/redis/salt.ts)
 * never resolves to `null` or `''`, even during a Redis outage.
 *
 * Throws (via `assertNoHashDelimiter`) if any input already contains the
 * delimiter byte, rather than silently producing a hash whose collision-
 * freedom property no longer holds — see that function's own comment.
 * A caller assembling the redirect hot path (T2.4.x, out of this task's
 * scope) MUST NOT let that throw cost a redirect [INV-1]: analytics
 * capture failing is not a reason to fail the redirect itself, so that
 * call site needs its own try/catch around capture — this function is
 * not the place to swallow the error itself, since swallowing it here
 * would silently hide a genuinely poisoned input instead of surfacing it.
 *
 * This is the ONLY function in this file that reads `ip`'s value: it is
 * consumed here, never stored, never returned, and never logged — the
 * function has no branch that could put it anywhere else.
 */
export function computeVisitorHash(ip: ClientIp, userAgent: string | null, salt: string): VisitorHash {
  const effectiveUserAgent = userAgent ?? '';
  assertNoHashDelimiter(ip, 'ip');
  assertNoHashDelimiter(effectiveUserAgent, 'userAgent');
  assertNoHashDelimiter(salt, 'salt');

  const material = [ip, effectiveUserAgent, salt].join(VISITOR_HASH_DELIMITER);
  const digest = createHash('sha256').update(material).digest('hex');

  return digest.slice(0, VISITOR_HASH_LENGTH) as VisitorHash;
}

/**
 * The identity/context and DERIVED values {@link buildCapturePayload}
 * assembles into a `CaptureEvent` — deliberately not the raw request.
 * `signals` is whatever `readSignals(req)` already produced; `asn` and
 * `country` come from `lookupNetwork` (T2.3.5); `visitorHash` comes from
 * {@link computeVisitorHash}. There is no `ip` field here, and
 * `visitorHash`'s type is `VisitorHash`, not `string` — a `ClientIp` is
 * not assignable to it without an explicit cast. See this file's header
 * and capture.test.ts's `@ts-expect-error` case.
 */
export interface CapturePayloadInput {
  readonly tenantId: string;
  readonly linkId: string;
  readonly slug: string;
  readonly signals: HeaderSignals;
  readonly visitorHash: VisitorHash | null;
  readonly asn: number | null;
  readonly country: string | null;
}

/**
 * Assembles one `CaptureEvent` — the BullMQ queue payload and the row
 * shape the worker eventually writes. `event_id` (a ULID) and
 * `occurred_at` (an ISO string, so it survives JSON through BullMQ) are
 * assigned HERE, ONCE [INV-8] — no other function on the redirect hot
 * path generates either. The IP itself never reaches this function: its
 * only inputs are identity/context fields and the three values already
 * derived from it elsewhere, which is what makes "no call path from IP to
 * queue payload" a property of this function's TYPE, not merely its body
 * — see {@link CapturePayloadInput} and this file's header.
 */
export function buildCapturePayload(input: CapturePayloadInput): CaptureEvent {
  const { tenantId, linkId, slug, signals, visitorHash, asn, country } = input;

  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: tenantId,
    link_id: linkId,
    slug,
    ...signals,
    country,
    asn,
    visitor_hash: visitorHash,
  };
}
