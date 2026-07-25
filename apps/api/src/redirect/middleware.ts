import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Counter, type Registry } from 'prom-client';
import type { CachedLink } from '@posta/contracts';
import type { GetDailySalt, LookupNetwork } from '@posta/core';
import { buildCapturePayload, computeVisitorHash, readClientIp, readSignals } from './capture';
import { createLogEnqueueFailure, type EnqueueCapture, type LogEnqueueFailure } from './enqueue';
import type { ParseRequestTarget } from './host';
import type { ResolveTenant } from './resolve-tenant';

// T2.1.4 [INV-2] — the redirect hot path itself: a raw Express middleware
// mounted on the Express instance BEFORE NestFactory.create wires up
// Nest's router (see main.ts). A redirect must never pay for Nest's
// DI/controller ceremony, so this file has none: no decorators, no
// providers, nothing `new`ed per request.
//
// Dependency shape: `deps` originally carried only `parseRequestTarget`,
// `logger` and `handleRootHitsCounter` (T2.1.4) — no I/O beyond the pure
// RequestTarget parse. T2.4.3 [INV-1] adds the five dependencies the
// 'link' kind's resolve -> redirect -> enqueue composition needs
// (`resolveTenant`, `resolveLink`, `lookupNetwork`, `getDailySalt`,
// `enqueueCapture`) — every one of them a closure already resolved once
// at boot by its own createX() factory (createResolveTenant,
// resolve-link.ts's `resolveLink` partially applied over its own boot
// deps, createNetworkLookup, createDailySalt, createEnqueueCapture — see
// main.ts) and handed in here unchanged. Nothing in this file constructs
// a Postgres/Redis/geoip/BullMQ resource itself [INV-2] — that stays
// main.ts's job, exactly as it always has for `parseRequestTarget` /
// `logger` / `handleRootHitsCounter`.
//
// Scope, deliberately narrow — T2.1.5 adds the handle-root alarm (error
// log + counter) and makes reserved-path/reserved-handle/invalid-path
// short-circuit behavior explicit; T2.4.3 adds the 'link' kind's real
// composition (`handleLinkTarget`, below). Everything else here is still
// a LATER task, not a bug:
//   - T2.5.2/T2.5.3 give the 404 a branded HTML body; a bare empty 404 is
//     correct here, for every 404 this file produces (`not-ours`
//     excepted, which never 404s at all).
//   - T2.4.4 replaced the former `logEnqueueFailurePlaceholder` with
//     enqueue.ts's real, redacting `createLogEnqueueFailure` — see
//     `handleLinkTarget`'s own comment for the wiring.
//   - T2.4.5 adds a read-time open-redirect guard on the resolved
//     destination, ahead of `sendLinkRedirect`.
//   - T2.6.5 is where "reserved paths cost zero Redis GETs" becomes an
//     assertion against a real client.
// `reserved-path`, `reserved-handle`, `invalid-path` and `handle-root`
// still get the exact same bare 404 with no side effect beyond it (plus
// the alarm, for handle-root) — only `link` does real work now.

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
  /**
   * T2.4.3 — resolves a Host-derived handle to a tenant_id. Built once at
   * boot via createResolveTenant (resolve-tenant.ts) — see main.ts. The
   * FIRST of the two "resolution lookup" awaits invariant 1's own wording
   * carves out explicitly: the ordering guarantee holds because nothing
   * else awaited sits ahead of `res.redirect` besides this call and
   * `resolveLink`, below.
   */
  readonly resolveTenant: ResolveTenant;
  /**
   * T2.4.3 — resolves a tenant-scoped slug to its cached/Postgres-backed
   * link. A thin closure over resolve-link.ts's `resolveLink(tenant, slug,
   * deps)`, partially applied over its own boot-resolved deps (db, redis,
   * logger, timeoutMs, cacheTtlSeconds) in main.ts — this file only ever
   * sees the 2-argument shape. The SECOND, and last, "resolution lookup"
   * await ahead of `res.redirect`.
   */
  readonly resolveLink: (tenantId: string, slug: string) => Promise<CachedLink | null>;
  /**
   * T2.4.3 — the ASN/country lookup (packages/core/src/geoip/lookup.ts),
   * built once at boot via createNetworkLookup over the boot-time mmdb
   * reader pair (T2.3.4's openGeoDatabases) — see main.ts. Synchronous:
   * called with no `await`, so it can run either side of the response
   * without ever delaying it — `handleLinkTarget` (below) runs it AFTER,
   * for reasons explained there.
   */
  readonly lookupNetwork: LookupNetwork;
  /**
   * T2.4.3 — the daily visitor-hash salt (packages/core/src/redis/salt.ts),
   * built once at boot via createDailySalt — see main.ts. The ONLY await
   * in `handleLinkTarget` (below) that runs AFTER the response has
   * already been sent — see that function's own comment for why it
   * cannot sit any earlier without either blocking the redirect on a live
   * Redis round trip or duplicating getDailySalt's own memoization here.
   */
  readonly getDailySalt: GetDailySalt;
  /**
   * T2.4.3 — the BullMQ producer (enqueue.ts's createEnqueueCapture, over
   * createEventsQueue and env.MAX_INFLIGHT_ENQUEUES) — see main.ts.
   * Called at most once per successfully-redirected 'link' request,
   * always AFTER the response, always `void`d with a `.catch()` attached
   * in the same synchronous tick — see `handleLinkTarget`.
   */
  readonly enqueueCapture: EnqueueCapture;
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
  // T2.4.4 — built once here, via enqueue.ts's createLogEnqueueFailure(logger):
  // the same "closure resolved once at boot" treatment every other
  // dependency in this function gets (see the file header).
  // createRedirectMiddleware itself is called exactly once (main.ts), so
  // this costs nothing per request and needs no new RedirectMiddlewareDeps
  // field — logger is already one.
  const logEnqueueFailure = createLogEnqueueFailure(logger);

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

      case 'link':
        // T2.4.3 — the only kind that does real work. handleLinkTarget
        // owns its ENTIRE response (307 on a hit, 404 on a miss), so this
        // returns immediately rather than falling through to the shared
        // 404 below.
        //
        // [fix round 1] `void`d with a defensive `.catch()` attached in
        // the same synchronous tick, not a bare `void`. handleLinkTarget's
        // own two try/catch blocks SHOULD cover its entire throwing
        // surface today, but that is a fact about the code BETWEEN them
        // holding forever, not something the type system enforces —
        // insert one new synchronous statement between the two try blocks
        // (another header write, say) and an unhandled-rejection path
        // reopens silently, in a file other people will keep editing.
        // This `.catch()` costs nothing on the hot path (it only ever
        // runs if handleLinkTarget's own safety net already failed) and
        // removes the dependence on that invariant holding forever.
        void handleLinkTarget(target.handle, target.slug, req, res, {
          ...deps,
          logEnqueueFailure,
        }).catch((error: unknown) => {
          const errorType = error instanceof Error ? error.constructor.name : typeof error;
          logger.error(
            'handleLinkTarget rejected unexpectedly — this should be structurally impossible; its ' +
              'own two try/catch blocks are meant to cover every throw. See this case\'s own comment.',
            { errorType },
          );
        });
        return;

      case 'reserved-path':
      case 'reserved-handle':
      case 'invalid-path':
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

// T2.4.4 — `logEnqueueFailure(err, ctx)` used to be a minimal placeholder
// here (logged only the error's constructor name, no redaction, no
// message). It now lives in enqueue.ts (its own "files" line) as
// `createLogEnqueueFailure`, is built once at boot in
// `createRedirectMiddleware` above, and is threaded into
// `handleLinkTarget`'s deps below. See enqueue.ts's own header for why
// the redaction matters (REDIS_URL's password rides inside an ioredis
// connection error's own `.message`).

// T2.4.3 [INV-1][INV-3] — the 'link' kind's real composition: resolve ->
// redirect -> enqueue, in that exact order, with the response sent before
// anything analytics-adjacent runs. `resolveTenant` and `resolveLink` are
// the ONLY two awaits ahead of `sendLinkRedirect` — the two "resolution
// lookup" awaits invariant 1's own wording carves out explicitly.
//
// Everything after `sendLinkRedirect` — reading headers/IP, the geoip
// lookup, the salt fetch, hashing, assembling the payload, enqueueing —
// is deliberately pushed to AFTER the response, even the parts that are
// perfectly synchronous (readClientIp/readSignals/lookupNetwork carry no
// `await` at all, and could technically run ahead of the redirect without
// costing it any wall-clock wait). Moving them there anyway keeps this
// function's shape a single, unambiguous fact instead of a judgment call
// a future edit could get wrong: every await AFTER `sendLinkRedirect` is
// automatically safe (the response already went out), every await BEFORE
// it is exactly the two resolution lookups and nothing else. `req`
// itself stays perfectly readable after `res.end()` — Node never
// invalidates the request object when the response finishes — so nothing
// is lost by waiting.
//
// [R16 / capture-privacy.test.ts] The try/catch below is this task's half
// of closing T2.3.8's own gap: that suite's `runCapturePipeline` fixture
// stood in for "whatever T2.4.3 eventually builds" and proved a SAFE
// handler (log only the error's type, never touch the request) leaks
// nothing, while a LEAKY one (`log.error({ req })`, the literal bug
// pattern the dispatch named) does. This function reuses that exact safe
// shape, in a file capture-privacy.test.ts's own static scan
// (REDIRECT_HOT_PATH_FILES) already covers — so the leak class that suite
// guards against is checked against the REAL composition site now, not
// only the fixture that modeled it.
async function handleLinkTarget(
  handle: string,
  slug: string,
  req: Request,
  res: Response,
  deps: Pick<
    RedirectMiddlewareDeps,
    'resolveTenant' | 'resolveLink' | 'lookupNetwork' | 'getDailySalt' | 'enqueueCapture' | 'logger'
  > & {
    /** T2.4.4 — built once at boot by `createRedirectMiddleware` above,
     * via enqueue.ts's `createLogEnqueueFailure(logger)`. Not a
     * `RedirectMiddlewareDeps` field itself (it is DERIVED from `logger`,
     * which already is one) — see that function's own comment. */
    readonly logEnqueueFailure: LogEnqueueFailure;
  },
): Promise<void> {
  const { resolveTenant, resolveLink, lookupNetwork, getDailySalt, enqueueCapture, logger, logEnqueueFailure } =
    deps;

  let tenantId: string | null;
  let link: CachedLink | null;
  try {
    tenantId = await resolveTenant(handle);
    if (tenantId === null) {
      res.set('Cache-Control', 'no-store');
      res.status(404).end();
      return;
    }

    link = await resolveLink(tenantId, slug);
    if (link === null) {
      // No link_id to attach an event to — events.link_id is NOT NULL by
      // design. Enqueueing nothing here is not an oversight; it is the
      // only honest option for a slug that does not resolve.
      res.set('Cache-Control', 'no-store');
      res.status(404).end();
      return;
    }
  } catch (error) {
    // resolveTenant/resolveLink both degrade a Redis failure to a
    // fall-through to Postgres internally, but a genuine POSTGRES failure
    // propagates — see resolve-tenant.ts's createResolveTenant and
    // resolve-link.ts's resolveLinkFromDb, both of which document exactly
    // this: Postgres is the resolution of last resort, so there is
    // nothing left to fall through to. Without this catch, that failure
    // would reject handleLinkTarget's own promise with no handler
    // attached (an unhandled rejection) and — worse — never answer the
    // request at all, hanging it until the client times out. The same
    // terminal 404 every other undecidable outcome on this path already
    // gets is the answer here too, logged the same SAFE way as the
    // capture-pipeline catch below: only the error's constructor name,
    // never the request.
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    logger.error('Link resolution failed; answering 404 rather than leaving the request hanging', {
      errorType,
      handle,
      slug,
    });
    res.set('Cache-Control', 'no-store');
    res.status(404).end();
    return;
  }

  // The response, sent. Everything below this line runs AFTER the
  // visitor already has their 307 — see this function's own header
  // comment for why even the synchronous reads are deferred this far.
  sendLinkRedirect(res, link.destination);
  if (res.statusCode !== 307) {
    // sendLinkRedirect itself 404'd: an unencodable destination
    // (encodeDestinationForHeader's own `null` case, below). No
    // successful redirect happened, so — same reasoning as the
    // link-miss branch above — there is nothing honest to enqueue.
    return;
  }

  try {
    const ip = readClientIp(req.headers);
    const signals = readSignals(req);
    const cfCountryHeader = req.headers['cf-ipcountry'];
    const cfCountry = typeof cfCountryHeader === 'string' ? cfCountryHeader : null;
    const { asn, country } = lookupNetwork(ip ?? '', cfCountry);

    // The one await in this whole function that runs AFTER the response
    // has already been flushed. getDailySalt() is memoized per UTC day
    // (redis/salt.ts) but its FIRST call of the day is a real Redis round
    // trip — awaiting it ahead of sendLinkRedirect would make every
    // visitor's redirect latency depend on that round trip once a day,
    // exactly what invariant 1 forbids. Sitting here costs nothing: the
    // redirect has already happened, and nothing downstream is waiting on
    // this promise either.
    const salt = await getDailySalt();
    const visitorHash = ip ? computeVisitorHash(ip, signals.user_agent, salt) : null;

    const payload = buildCapturePayload({
      tenantId,
      linkId: link.link_id,
      slug,
      signals,
      visitorHash,
      asn,
      country,
    });

    // Fire-and-forget with the `.catch()` attached in the same
    // synchronous tick the promise is created in — enqueueCapture's own
    // doc comment (enqueue.ts) is explicit that this is what makes
    // `void`ing it safe: no unhandled rejection, whatever queue.add()
    // eventually does.
    void enqueueCapture(payload).catch((error: unknown) =>
      logEnqueueFailure(error, {
        eventId: payload.event_id,
        tenantId,
        slug,
      }),
    );
  } catch (error) {
    // A capture failure (geoip, salt, hash, payload assembly) can no
    // longer cost the redirect — it already happened. Degrades to "no
    // analytics for this request", logged the same SAFE way
    // capture-privacy.test.ts's own fixture proves leaks nothing: only
    // the error's constructor name, never the request.
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    logger.error('Capture failed; the redirect already succeeded, no analytics for this request', {
      errorType,
      tenantId,
      slug,
    });
  }
}

// T2.4.1 [INV-3] — the response half of S2.4: given an already-resolved
// destination, this is what turns it into a 307. Called from
// handleLinkTarget (above) with the resolved link's `destination` the
// instant resolveLink returns a hit; enqueueing happens strictly AFTER,
// never before — see handleLinkTarget's own header comment for the full
// composition and why. [T2.4.1 fix round 2] This function does not
// GUARANTEE a 307 — a destination that cannot be turned into a valid
// Location header (see the `null` case below) ends in a 404 instead.
// handleLinkTarget checks `res.statusCode` after calling this function to
// tell the two outcomes apart, since this function's own return type
// carries no signal of which one happened.
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
// [T2.4.1 fix round 2] A destination can fail to produce a valid Location
// header at all (see encodeDestinationForHeader's `null` case, below) —
// there is nothing to redirect TO in that case, so this ends in the same
// bare 404 the middleware's own terminal branch uses (Cache-Control:
// no-store, no body), rather than let an encoding failure surface as an
// uncaught exception. `Cache-Control` is set once, up front, so it is
// present on EITHER outcome — both are terminal responses that must
// never be cached by an intermediary.
export function sendLinkRedirect(res: Response, destination: string): void {
  res.set('Cache-Control', 'no-store');

  const encoded = encodeDestinationForHeader(destination);
  if (encoded === null) {
    res.status(404).end();
    return;
  }

  res.set('Location', encoded);
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
function isHeaderSafeCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09) return true; // horizontal tab
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true; // printable ASCII
  if (codePoint >= 0x80 && codePoint <= 0xff) return true; // Latin-1 supplement
  return false;
}

// [T2.4.1 fix round 2, INV-2] This hot path runs on every single
// redirect, and the overwhelming common case is a destination that
// needs NO transformation at all — yet the original fix round 1
// implementation ran `Array.from(destination).map(...).join('')` on
// EVERY call regardless, paying an array allocation plus a per-character
// codePointAt/function-call for a destination that never had anything to
// encode. This pattern expresses isHeaderSafeCodePoint's exact same
// 0x00-0xFF boundary (tab, printable ASCII, Latin-1 supplement) as a
// single non-allocating regex scan: when the WHOLE destination already
// matches, encodeDestinationForHeader returns it completely unchanged
// with no further work — no Array.from, no per-character loop, nothing
// beyond one `.test()` call. Only a destination containing at least one
// character outside this set falls through to the slower per-code-point
// path below, which is the rare path, not the hot one.
const HEADER_SAFE_DESTINATION_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * Percent-encodes `destination` for the Location header, touching only
 * the characters {@link isHeaderSafeCodePoint} says Node's raw header
 * writer cannot represent. Returns `null` when the destination cannot be
 * represented AT ALL — [T2.4.1 fix round 2, CRITICAL] a lone, unpaired
 * UTF-16 surrogate (malformed input with no valid Unicode representation
 * on its own) makes `encodeURIComponent` throw `URIError` rather than
 * return anything, and this IS reachable through the normal validated
 * path: `zDestination` (`z.url()`) accepts
 * `String.fromCharCode(0xd800)` embedded in an otherwise-valid URL,
 * confirmed by hand. `sendLinkRedirect` treats `null` as "no valid
 * Location exists for this destination" and 404s rather than let the
 * exception escape and crash the request — this is a narrower, purely
 * mechanical fact ("this string cannot become a valid HTTP header
 * value"), not the malicious-URL-scheme concern T2.4.5's guard exists
 * for.
 *
 * The fast-path regex above doubles as the detector for this case with
 * no separate check needed: an unpaired surrogate's own UTF-16 code unit
 * (0xD800-0xDFFF) falls outside the regex's safe ranges exactly like a
 * CJK or emoji character's code units do, so it already falls through to
 * this per-code-point path, where the `catch` below is what actually
 * turns the throw into `null` instead of letting it propagate.
 *
 * Iterates by Unicode CODE POINT (a plain `for...of` over the string,
 * which — like `Array.from` — respects surrogate PAIRS) so a
 * supplementary-plane character such as an emoji is read and encoded as
 * the single code point it is, not as two broken halves; see
 * redirect-response.test.ts's emoji case, which specifically exercises
 * this. `encodeURIComponent` on that one resulting character/pair
 * produces its exact percent-encoded UTF-8 bytes.
 */
function encodeDestinationForHeader(destination: string): string | null {
  if (HEADER_SAFE_DESTINATION_PATTERN.test(destination)) {
    return destination;
  }

  const parts: string[] = [];
  for (const char of destination) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isHeaderSafeCodePoint(codePoint)) {
      parts.push(char);
      continue;
    }
    try {
      parts.push(encodeURIComponent(char));
    } catch {
      return null;
    }
  }
  return parts.join('');
}
