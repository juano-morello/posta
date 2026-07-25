import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Counter, type Registry } from 'prom-client';
import type { ParseRequestTarget } from './host';

// T2.1.4 [INV-2] — the redirect hot path itself: a raw Express middleware
// mounted on the Express instance BEFORE NestFactory.create wires up
// Nest's router (see main.ts). A redirect must never pay for Nest's
// DI/controller ceremony, so this file has none: no decorators, no
// providers, nothing `new`ed per request.
//
// Dependency shape: `deps` carries `parseRequestTarget`, `logger` and
// `handleRootHitsCounter` — NOT `redis` yet. The brief for this story
// describes the eventual factory as `createRedirectMiddleware({ redis })`,
// but the middleware still does not read Redis at all: that starts at
// T2.2.3's cached slug lookup. An unused `redis` field today would be
// dead config threaded through for no reason, so it stays deferred to the
// task that first reads it rather than added speculatively (YAGNI). All
// three current deps are built ONCE at boot (see main.ts: makeUrlBuilders
// + resolveReservedHandles + makeRequestTargetParser, plus
// consoleErrorLogger and createHandleRootHitsCounter — every one called a
// single time) and closed over here — this factory is called exactly
// once, and the handler it returns allocates nothing beyond the `target`
// it computes for the request it is currently serving.
//
// Scope, deliberately narrow — T2.1.5 adds the handle-root alarm (error
// log + counter) and makes reserved-path/reserved-handle/invalid-path
// short-circuit behavior explicit, but everything below is still a LATER
// task, not a bug:
//   - T2.5.2/T2.5.3 give the 404 a branded HTML body; a bare empty 404 is
//     correct here.
//   - S2.2 onward add the actual 'link' kind's slug resolution, Redis
//     lookup and enqueue.
//   - T2.6.5 is where "reserved paths cost zero Redis GETs" becomes an
//     assertion against a real client, once `redis` exists on this
//     middleware's deps at all — today there is nothing to spy on.
// Every RequestTarget kind other than 'not-ours' and 'handle-root'
// therefore still gets the exact same bare 404 with no side effect beyond
// it — the branching those later tasks need doesn't exist yet because
// building it here would be scope creep this task's brief explicitly
// rules out.

/**
 * Minimal logger shape the redirect middleware needs — mirrors
 * PartitionMaintenanceLogger
 * (apps/worker/src/partitions/partition-maintenance.job.ts): just enough
 * to log one error line, so tests can pass a plain spy object instead of
 * a real pino instance (no pino instance is wired up anywhere in this
 * codebase yet — LOG_LEVEL is validated in env.ts but unused).
 */
export interface RedirectMiddlewareLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export const consoleErrorLogger: RedirectMiddlewareLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

export const HANDLE_ROOT_HITS_COUNTER_NAME = 'posta_handle_root_hits';

/**
 * Builds the posta_handle_root_hits counter. Pass a dedicated `registry`
 * in tests to avoid colliding with prom-client's shared global default
 * registry (creating two Counters with the same name against the same
 * registry throws) — mirrors createDefaultPartitionRowsGauge's identical
 * shape in the worker's partition-maintenance job.
 *
 * Any non-zero value means the Cloudflare Origin Rule (`path == "/"` ->
 * Next, spec §14) is misrouting bio-page traffic to the API instead: a
 * dead-looking 404 for the visitor, and — without this counter — total
 * silence for us.
 */
export function createHandleRootHitsCounter(registry?: Registry): Counter<string> {
  // `exactOptionalPropertyTypes` forbids passing `registers: undefined`
  // explicitly — the key must be OMITTED entirely (not present-but-
  // undefined) when no registry override is given, so prom-client falls
  // back to its own default registry.
  return new Counter({
    name: HANDLE_ROOT_HITS_COUNTER_NAME,
    help:
      'Count of requests for "/" on a tenant handle host that reached the API. Should ' +
      'always be zero: the Cloudflare Origin Rule (path == "/" -> Next) is supposed to ' +
      'route bio-page traffic to Next before it ever reaches here. Any non-zero value ' +
      'means that rule is misconfigured and real bio-page visitors are getting a 404.',
    ...(registry ? { registers: [registry] } : {}),
  });
}

export interface RedirectMiddlewareDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly parseRequestTarget: ParseRequestTarget;
  /** Built once at boot — see main.ts. consoleErrorLogger in production, a spy in tests. */
  readonly logger: RedirectMiddlewareLogger;
  /** Built once at boot via createHandleRootHitsCounter — see main.ts. */
  readonly handleRootHitsCounter: Counter<string>;
}

/**
 * Builds the redirect middleware from dependencies resolved once at boot.
 * `not-ours` (a host this deployment did not construct, or the app./api.
 * hosts Nest itself owns) calls `next()` and falls through to Nest's
 * router. Every other kind — this deployment addressed the request, one
 * way or another — terminates here with a bare 404 and
 * `Cache-Control: no-store`, so nothing downstream ever caches a wrong
 * answer. `handle-root` additionally logs at error level and increments
 * the alarm counter before answering (T2.1.5) — see the file header for
 * why.
 */
export function createRedirectMiddleware(deps: RedirectMiddlewareDeps): RequestHandler {
  const { parseRequestTarget, logger, handleRootHitsCounter } = deps;

  return function redirectMiddleware(req: Request, res: Response, next: NextFunction): void {
    // req.path (not req.url) is Express's query-string-stripped path, so
    // a bio link carrying tracking params (`/?utm=x`) still resolves to
    // '/' here — see CLAUDE.md's routing note and host.test.ts's own
    // coverage of the same requirement one layer down.
    const target = parseRequestTarget(req.headers.host ?? '', req.path);

    if (target.kind === 'not-ours') {
      next();
      return;
    }

    // [security/typescript, S2.1 story-review batch] `target` here is
    // Exclude<RequestTarget, { kind: 'not-ours' }> — TS narrows past the
    // early return above. A `switch` over the remaining kinds, with an
    // exhaustiveness check in `default`, is a compile-time guard, NOT a
    // behavior change: every kind still falls through to the identical
    // 404 below. What changes is that a SEVENTH RequestTarget kind added
    // later (host.ts) without a matching case here fails `tsc` instead
    // of silently landing in `default` and getting a bare 404 with no
    // per-kind decision ever made about it — exactly the kind of gap
    // this discriminated union exists to make impossible.
    switch (target.kind) {
      case 'handle-root':
        // T2.1.5 — the alarm. This branch runs exactly once per matching
        // request (there is only one middleware layer, and only one call
        // to it per request), so one hit is one log line and one
        // increment — never double-counted across layers.
        logger.error(
          `Handle-root hit for "${target.handle}" — "/" on a tenant handle host reached the ` +
            'API. The Cloudflare Origin Rule (path == "/" -> Next) is supposed to route this ' +
            'request to the bio page before it ever gets here; a real visitor is seeing a ' +
            '404 that should have been their bio page.',
          { handle: target.handle },
        );
        handleRootHitsCounter.inc();
        break;

      case 'reserved-path':
      case 'reserved-handle':
      case 'invalid-path':
      case 'link':
        // No alarm, no side effect beyond the shared 404 below — see the
        // file header for why each of these stays a bare 404 for now.
        break;

      default: {
        // Deliberately does NOT throw: an unrecognized kind still falls
        // through to the exact same 404 every other terminal kind gets
        // below, preserving this commit's runtime behavior byte-for-
        // byte. `tsc` — not a runtime branch — is the enforcement
        // mechanism: if this line stops compiling, a case is missing
        // above.
        const _exhaustive: never = target;
        void _exhaustive;
      }
    }

    res.set('Cache-Control', 'no-store');
    res.status(404).end();
  };
}

// T2.4.1 [INV-3] — the response half of S2.4: given an already-resolved
// destination, this is what turns it into a 307. Deliberately NOT called
// from the switch's 'link' case above yet: T2.4.3 owns wiring
// resolveLink (resolve-link.ts) into this middleware and composing
// resolve -> respond -> enqueue in that exact order [INV-1] — calling it
// from here would collide with that task's composition and leave the
// 'link' case half-built with no real destination to redirect to. This
// function IS the seam: T2.4.3 calls it with the resolved link's
// `destination` the instant resolveLink returns a hit, then enqueues
// AFTER, never before.
//
// `res.redirect(307, destination)` is deliberately NOT used here.
// Express's res.redirect() — and res.location(), which it calls
// internally — run the URL through the `encodeurl` package before
// writing the Location header. Verified by hand against a live Express
// server: a destination containing a Latin-1 accented character (e.g.
// "promoción", the kind of destination this Spanish-first product will
// see routinely) comes back as "promoci%C3%B3n" — encodeurl re-encodes
// UNCONDITIONALLY on any character outside its own allowed set, Latin-1
// accents included, regardless of whether the source was already valid.
// That is exactly the "no normalisation, no re-encoding" this story's
// acceptance criteria rule out — the destination must reach the
// visitor's browser byte-identical to what is in storage. (encodeurl
// does NOT, however, touch an already-valid `%XX` escape sequence like
// `%2F` — it only re-escapes a `%` that is NOT part of one, e.g. `%zz`
// or a trailing `%`; see redirect-response.test.ts's percent-encoding
// case for the destination that actually demonstrates the difference.)
// res.redirect() also formats and writes a Content-Type-negotiated
// HTML/text body plus a Content-Length header on every call, work this
// hot path (every single click) has no use for. res.set() — Express's
// own header setter, NOT res.location() — writes the header value
// untouched, which is what redirect-response.test.ts's byte-identity
// cases depend on.
export function sendLinkRedirect(res: Response, destination: string): void {
  res.set('Cache-Control', 'no-store');
  res.set('Location', encodeDestinationForHeader(destination));
  res.status(307).end();
}

// [T2.4.1 fix round 1, CRITICAL] `zDestination` (packages/contracts/src/links.ts)
// accepts an absolute http(s) URL containing ANY Unicode character —
// verified by hand: `https://example.test/日本語` and
// `https://exámple.test/x` both parse successfully. Node's raw HTTP
// header writer does not: it throws `ERR_INVALID_CHAR` synchronously for
// any code point above the Latin-1 supplement block, confirmed by direct
// measurement against a real `http.ServerResponse` on this Node version
// (0x00-0xFF swept one code point at a time; see isHeaderSafeCodePoint's
// own comment for the exact accepted set — narrower than the commonly
// cited `checkInvalidHeaderChar` regex, which does not match this
// runtime's actual behaviour). Left uncaught, that turns a
// legitimately-created link whose destination contains such a character
// into a PERMANENT per-slug outage: every request for that slug throws
// inside sendLinkRedirect, forever — worse than the 404 T2.4.5 ships for
// a genuinely malicious destination, and not something T2.4.5's guard
// (dangerous URL SCHEMES, a different concern) or E5's write-time
// validation (Redis is a second writer that write-time validation
// structurally cannot cover — the same reasoning T2.4.5's own brief
// already establishes) would catch. It is this function's problem.
//
// The fix percent-encodes ONLY the characters that would actually make
// the header write throw, leaving every already-safe character —
// including every ASCII delimiter this hot path must never touch (`/`,
// `?`, `&`, `=`, `#`) and every Latin-1 accented character — completely
// untouched, so the byte-identical guarantee for every destination that
// CAN be sent verbatim still holds exactly as before. A destination that
// needed encoding still lands the visitor on the identical target: this
// is the same transform a browser applies when it parses a URL
// containing such a character by any other route.
//
// Iterates by Unicode CODE POINT (`Array.from`, not a plain index-based
// loop over UTF-16 code units) so a supplementary-plane character
// represented as a surrogate PAIR — an emoji, for instance — is read and
// encoded as the single code point it is, not as two broken halves; see
// redirect-response.test.ts's emoji case, which specifically exercises
// this. `encodeURIComponent` on that one resulting character/pair
// produces its exact percent-encoded UTF-8 bytes.
//
// Deliberately does NOT attempt to repair a LONE, unpaired UTF-16
// surrogate (malformed input with no valid Unicode representation —
// `encodeURIComponent` itself throws `URIError` on one). That is a
// different problem: malformed/invalid input, not a legitimate
// destination containing a character outside Latin-1, and closer in
// kind to T2.4.5's malicious-input guard than to this fix. Not handling
// it here is a scope decision, not an oversight — recording it so it
// isn't silently rediscovered later.
function isHeaderSafeCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09) return true; // horizontal tab
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true; // printable ASCII
  if (codePoint >= 0x80 && codePoint <= 0xff) return true; // Latin-1 supplement
  return false;
}

function encodeDestinationForHeader(destination: string): string {
  return Array.from(destination)
    .map((char) => {
      const codePoint = char.codePointAt(0);
      return codePoint !== undefined && isHeaderSafeCodePoint(codePoint)
        ? char
        : encodeURIComponent(char);
    })
    .join('');
}
