import type { IncomingHttpHeaders } from 'node:http';
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
