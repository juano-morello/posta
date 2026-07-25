import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Counter, type Registry } from 'prom-client';
import { zDestination, type CachedLink } from '@posta/contracts';
import type { GetDailySalt, LookupNetwork } from '@posta/core';
import { buildCapturePayload, computeVisitorHash, readClientIp, readSignals } from './capture';
import { createLogEnqueueFailure, type EnqueueCapture, type LogEnqueueFailure } from './enqueue';
import type { ParseRequestTarget } from './host';
import type { RenderNotFound } from './not-found';
import { sendLinkRedirect } from './redirect-response';
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
//   - T2.5.3 wires renderNotFound (T2.5.2) into every terminal 404 this
//     file decides (`not-ours` excepted, which never 404s at all) —
//     `sendNotFound`, below, is the one call site. The single exception:
//     an unencodable destination still gets a bare, bodyless 404, because
//     that response is sent entirely inside sendLinkRedirect
//     (./redirect-response.ts) before handleLinkTarget regains control —
//     see sendNotFound's own doc comment for why that file stays
//     untouched.
//   - T2.4.4 replaced the former `logEnqueueFailurePlaceholder` with
//     enqueue.ts's real, redacting `createLogEnqueueFailure` — see
//     `handleLinkTarget`'s own comment for the wiring.
//   - T2.4.5 added the read-time open-redirect guard, ahead of
//     `sendLinkRedirect` — see `handleLinkTarget`'s own comment for why it
//     sits there and not one level down in resolve-link.ts.
//   - T2.6.5 is where "reserved paths cost zero Redis GETs" becomes an
//     assertion against a real client.
// `reserved-path`, `reserved-handle`, `invalid-path` and `handle-root`
// still get no side effect beyond the 404 itself (plus the alarm, for
// handle-root) and none of them ever enqueue — only `link` does real work
// now. T2.5.3 gave each of the four its own rendered body: see
// `sendNotFound`'s call sites below for exactly what each one reflects.
//
// [S2.4 fan-out fix round] `sendLinkRedirect`, `encodeDestinationForHeader`,
// `isHeaderSafeCodePoint` and `HEADER_SAFE_DESTINATION_PATTERN` used to
// live in this file (T2.4.1). They now live in `./redirect-response.ts` —
// split out once this file crossed the epic's 800-line hard cap, per the
// story-level review that landed once S2.4 (T2.4.1-T2.4.5) was complete.
// The split follows the existing test boundary exactly:
// `redirect-response.test.ts` already tested that surface as a unit, so
// this is a pure move (same exports, same behavior), not a redesign.
// `describeRejectedScheme` and the open-redirect guard stay HERE, in
// `handleLinkTarget` — they are about the destination's SCHEME and
// length, a request-composition concern; `redirect-response.ts` owns
// whether a validated destination can become HTTP header bytes at all, a
// completely different concern that must not blur back together across
// the file boundary either.

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

export const OPEN_REDIRECT_REJECTED_COUNTER_NAME = 'posta_open_redirect_rejected_total';

/**
 * Builds the posta_open_redirect_rejected_total counter (T2.4.5
 * [security]). Pass a dedicated `registry` in tests to avoid colliding
 * with prom-client's shared global default registry — mirrors
 * createHandleRootHitsCounter (above) and createEnqueueDroppedCounter's
 * (enqueue.ts) identical shape.
 *
 * Every increment means the open-redirect guard in `handleLinkTarget`
 * (below) refused to redirect a RESOLVED destination that failed
 * `zDestination` — the exact same absolute-http(s) check T1.1.11 already
 * enforces at write time. A destination that never passed that check
 * reaching this guard means either the Redis cache or the Postgres
 * `links` row was written to directly, bypassing every application-level
 * validation this codebase has: a poisoned cache entry or a corrupt row,
 * either one worth paging someone for. Unlike
 * posta_enqueue_dropped_total (which trends up under ordinary
 * backpressure and is expected to move), this number should be zero,
 * always — any non-zero value is a genuine incident, not routine traffic.
 */
export function createOpenRedirectRejectedCounter(registry?: Registry): Counter<string> {
  // `exactOptionalPropertyTypes` forbids passing `registers: undefined`
  // explicitly — see createHandleRootHitsCounter's identical comment.
  return new Counter({
    name: OPEN_REDIRECT_REJECTED_COUNTER_NAME,
    help:
      'Count of resolved link destinations rejected by the read-time open-redirect guard ' +
      '(T2.4.5) because they failed zDestination, the same absolute-http(s) check write-time ' +
      'validation already enforces. Should always be zero — any non-zero value means a Redis ' +
      'or Postgres value was written directly, bypassing every application-level check, and ' +
      'is worth investigating immediately.',
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
  /**
   * T2.4.5 [security] — built once at boot via
   * createOpenRedirectRejectedCounter — see main.ts. Incremented every
   * time the read-time open-redirect guard (`handleLinkTarget`, below)
   * refuses to redirect a resolved destination that fails `zDestination`.
   */
  readonly openRedirectRejectedCounter: Counter<string>;
  /**
   * T2.5.3 — the branded 404 document (not-found.ts's makeNotFoundRenderer),
   * built once at boot over env-derived UrlBuilders — see main.ts. Wired
   * in exactly like openRedirectRejectedCounter above: a closure resolved
   * once, handed in unchanged, called per request only by `sendNotFound`
   * (below) to produce the body a terminal 404 writes.
   */
  readonly renderNotFound: RenderNotFound;
}

/**
 * Terminal 404 shape for every branch the redirect middleware itself
 * decides (i.e. everything except a real 'link' hit's own 307). T2.5.3's
 * single call site: replaces the bare `res.status(404).end()` every one
 * of these branches used to send with S2.5's branded document (T2.5.2) —
 * status and `Cache-Control` are unchanged from before this task; the
 * body and `Content-Type` are new. `slug` is whatever the CALLER decided
 * this branch should reflect (see this function's call sites, and the
 * file header's own note on `handleLinkTarget`'s branches) — always the
 * RAW, unescaped value: renderNotFound (not-found.ts) runs it through
 * escapeHtml internally, and running it through a second escaper here
 * would double-escape it.
 *
 * Does NOT cover the unencodable-destination outcome inside
 * sendLinkRedirect (./redirect-response.ts): that function already calls
 * `res.status(404).end()` with no body of its own before handleLinkTarget
 * regains control, and this task's file list does not include that
 * module — see the file header's own note on this gap.
 */
function sendNotFound(res: Response, renderNotFound: RenderNotFound, slug: string): void {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.status(404).end(renderNotFound(slug));
}

// [T2.5.3] The value reflected in the 404 template's "cd /<value>" line
// for 'reserved-path' and 'invalid-path' — the only two terminal kinds
// with a real request PATH but no validated `slug` of their own (see
// host.ts's own RequestTarget union: neither variant carries a field at
// all, so the path has to come from `req` directly). The one leading
// slash is stripped so the template's own hardcoded "/" prefix does not
// double up; nothing else is decoded or normalized, so what a visitor
// sees is exactly the path they requested. 'invalid-path' is not named by
// the brief's own six-item list — it gets this same treatment because
// it is structurally identical to 'reserved-path' in host.ts's union: a
// path that could not become a slug lookup, just for a different reason.
function describeRequestedPath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

/**
 * Builds the redirect middleware from dependencies resolved once at boot.
 * `not-ours` (a host this deployment did not construct, or the app./api.
 * hosts Nest itself owns) calls `next()` and falls through to Nest's
 * router. Every other kind — this deployment addressed the request, one
 * way or another — terminates here with S2.5's branded 404 (`sendNotFound`,
 * above) and `Cache-Control: no-store`, so nothing downstream ever caches
 * a wrong answer. `handle-root` additionally logs at error level and
 * increments the alarm counter before answering (T2.1.5) — see the file
 * header for why.
 */
export function createRedirectMiddleware(deps: RedirectMiddlewareDeps): RequestHandler {
  const { parseRequestTarget, logger, handleRootHitsCounter, renderNotFound } = deps;
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
    // behavior change: every kind still terminates in a 404 one way or
    // another. What changes is that a SEVENTH RequestTarget kind added
    // later (host.ts) without a matching case here fails `tsc` instead
    // of silently landing in `default` with no per-kind decision ever
    // made about it — exactly the kind of gap this discriminated union
    // exists to make impossible.
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
        // [T2.5.3, decision 2] '' — there is no slug at all for "/" on a
        // handle host, matching the brief's own framing exactly.
        sendNotFound(res, renderNotFound, '');
        return;

      case 'link':
        // T2.4.3 — the only kind that does real work. handleLinkTarget
        // owns its ENTIRE response (307 on a hit, 404 on a miss), so this
        // returns immediately.
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
      case 'invalid-path':
        // [T2.5.3, decision 2] Neither variant carries a slug or a path
        // field of its own (host.ts) — describeRequestedPath reads
        // req.path directly. No alarm, no side effect beyond the 404.
        sendNotFound(res, renderNotFound, describeRequestedPath(req.path));
        return;

      case 'reserved-handle':
        // [T2.5.3, decision 2] '' — deliberately, even though req.path is
        // technically available here too: the interesting fact about
        // this branch is the HOST (a segment nobody can ever claim), and
        // the path that happened to follow it says nothing about that.
        // No alarm, no side effect beyond the 404.
        sendNotFound(res, renderNotFound, '');
        return;

      default: {
        // Deliberately does NOT throw: an unrecognized kind still gets
        // the exact same terminal 404 every other kind gets, preserving
        // this commit's runtime behavior. `tsc` — not a runtime branch —
        // is the enforcement mechanism: if this line stops compiling, a
        // case is missing above.
        const _exhaustive: never = target;
        void _exhaustive;
        sendNotFound(res, renderNotFound, '');
        return;
      }
    }
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
    | 'resolveTenant'
    | 'resolveLink'
    | 'lookupNetwork'
    | 'getDailySalt'
    | 'enqueueCapture'
    | 'logger'
    | 'openRedirectRejectedCounter'
    | 'renderNotFound'
  > & {
    /** T2.4.4 — built once at boot by `createRedirectMiddleware` above,
     * via enqueue.ts's `createLogEnqueueFailure(logger)`. Not a
     * `RedirectMiddlewareDeps` field itself (it is DERIVED from `logger`,
     * which already is one) — see that function's own comment. */
    readonly logEnqueueFailure: LogEnqueueFailure;
  },
): Promise<void> {
  const {
    resolveTenant,
    resolveLink,
    lookupNetwork,
    getDailySalt,
    enqueueCapture,
    logger,
    logEnqueueFailure,
    openRedirectRejectedCounter,
    renderNotFound,
  } = deps;

  let tenantId: string | null;
  let link: CachedLink | null;
  try {
    tenantId = await resolveTenant(handle);
    if (tenantId === null) {
      // [T2.5.3, decision 2] `slug` — the "unknown handle" outcome: the
      // handle itself didn't resolve, but the requested slug is still the
      // one piece of per-request identity worth reflecting, same as every
      // other 404 this function produces.
      sendNotFound(res, renderNotFound, slug);
      return;
    }

    link = await resolveLink(tenantId, slug);
    if (link === null) {
      // No link_id to attach an event to — events.link_id is NOT NULL by
      // design. Enqueueing nothing here is not an oversight; it is the
      // only honest option for a slug that does not resolve. Covers BOTH
      // "unknown slug" and "archived link" — resolveLinkFromDb
      // (resolve-link.ts) returns null for both by design, and this
      // function has no way (and no need) to tell them apart.
      sendNotFound(res, renderNotFound, slug);
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
    // never the request. Not named by the brief's own six-item list — a
    // genuine infrastructure failure mid-resolution, reported here per
    // this task's own dispatch instruction to surface (not silently fold
    // in) every terminal 404 the brief didn't name.
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    logger.error('Link resolution failed; answering 404 rather than leaving the request hanging', {
      errorType,
      handle,
      slug,
    });
    sendNotFound(res, renderNotFound, slug);
    return;
  }

  // T2.4.5 [security] — the read-time open-redirect guard. `link` here is
  // the RESOLVED record handleLinkTarget is about to redirect to,
  // regardless of which tier answered it: resolveLink (resolve-link.ts)
  // composes a Redis cache hit and a Postgres fallback behind the exact
  // same `CachedLink | null` return type, and by design this function
  // never learns which one it got (see resolve-link.ts's own header for
  // why that composition is the hot path's single entry point). Validation
  // on WRITE (T1.1.11's `createLinkSchema`, apps/api's link-creation
  // endpoint) is not enough on its own: it only constrains what THIS
  // application ever writes, and both stores have a second writer —
  // anyone with `redis-cli`, a compromised worker, or direct SQL access
  // can place a row or cache entry this check never saw.
  //
  // The two stores are NOT equally exposed here, though, and this guard's
  // placement reflects that rather than pretending otherwise:
  //   - Redis IS already covered. Every `link:{tenant}:{slug}` read goes
  //     through packages/contracts/src/cache.ts's `parseCachedLink`
  //     (T2.2.1), which runs the exact same `zDestination` check below and
  //     folds a failure into an ordinary cache MISS before it ever
  //     reaches resolveLink's return value — resolve-link.test.ts's own
  //     "[security] a well-formed but schema-invalid payload" case proves
  //     this. A destination poisoned directly in Redis therefore never
  //     reaches this line as part of a non-null `link`.
  //   - Postgres is NOT covered anywhere else. resolveLinkFromDb
  //     (resolve-link.ts, T2.2.4) returns `resolveLinkBySlug`'s row by
  //     STRUCTURAL CAST — a `SELECT` result assigned straight into
  //     `CachedLink`'s shape, never run through `CachedLinkSchema` or
  //     `zDestination`. The DB's own CHECK constraint (T1.1.5) only
  //     enforces `^https?://`, which a `zDestination`-max-length-exceeding
  //     destination or an `http`-prefixed-but-unparseable one both still
  //     satisfy. This is the gap a prior security review flagged and this
  //     task exists to close.
  //
  // Given that asymmetry, this check runs unconditionally on every 'link'
  // request rather than living inside resolve-link.ts gated to the
  // Postgres tier only: `handleLinkTarget` has no way to tell which tier
  // answered without resolveLink's return type growing a source tag
  // purely for this guard's benefit, which would ripple into every other
  // caller of that composition for no behavioural gain. Running one
  // `zDestination.safeParse` on an already-valid, Redis-sourced
  // destination costs a single regex/URL-parse on a short string — not
  // the "twice" this comment's own task brief warns against, which meant
  // re-running `CachedLinkSchema`'s full object shape (link_id/tenant_id
  // included) a second time, not this narrower, cheaper check. What this
  // buys: ONE guard, unconditional, that stays correct even if
  // `parseCachedLink`'s own protection is ever weakened — this is
  // deliberately not "trust the Redis tier already checked it".
  //
  // [fix round 1] This guard has no opinion on HEADER safety — an
  // embedded CR/LF passes `zDestination` (it constrains scheme and
  // length, not the full character set) and is not response-splitting
  // ONLY because encodeDestinationForHeader (T2.4.1, ./redirect-response.ts)
  // percent-encodes it before it ever reaches a header. That property
  // belongs to that function, not this guard — recorded here so nobody
  // later "simplifies" the encoder on the assumption this guard already
  // covers header safety.
  const destinationCheck = zDestination.safeParse(link.destination);
  if (!destinationCheck.success) {
    // [security] Never the destination itself — it is attacker-controlled
    // content the instant it reached here by an unvalidated path, and may
    // itself embed credentials or log-injection payloads. `link_id` is
    // how an operator finds the offending row; the SCHEME — extracted
    // without ever invoking `new URL()` on the untrusted string a second
    // time, and hard-capped at REJECTED_SCHEME_MAX_LENGTH so a pathological
    // scheme can never smuggle most of the destination back out through
    // this log line, see describeRejectedScheme's own comment — is the
    // diagnostic signal for what kind of attack this is.
    logger.error(
      'Resolved destination failed the read-time open-redirect guard; refusing to redirect. ' +
        'A destination this deployment itself validates at write time should never reach ' +
        'here — this means a Redis or Postgres value was written to directly, bypassing ' +
        'every application-level check.',
      { linkId: link.link_id, rejectedScheme: describeRejectedScheme(link.destination) },
    );
    openRedirectRejectedCounter.inc();
    // Same terminal shape every other 404 on this path uses: no Location
    // header is ever set (it never reaches sendLinkRedirect, below), and
    // — same reasoning as the link-miss branch above — there is no
    // meaningful click to record for a destination that cannot be served,
    // so nothing is enqueued either. [T2.5.3, decision 2] `slug`, same as
    // every other branch in this function — never `link.destination`,
    // which is exactly the attacker-controlled value this log line above
    // already refuses to echo.
    sendNotFound(res, renderNotFound, slug);
    return;
  }

  // The response, sent. Everything below this line runs AFTER the
  // visitor already has their 307 — see this function's own header
  // comment for why even the synchronous reads are deferred this far.
  //
  // [fix round 1] `destinationCheck.data`, NOT `link.destination`. Zod's
  // `z.url()` trims the input before validating it and returns the
  // TRIMMED string as its parse output — `zDestination` never calls
  // `.normalize()`, so that trimmed value is `destinationCheck.data`, and
  // it can differ from `link.destination` on a COLD POSTGRES hit (a
  // Redis hit is unaffected: parseCachedLink, T2.2.1, already hands back
  // the schema's own parsed value, never the raw cache bytes).
  // `link.destination` still passes the guard above either way — the
  // guard only checks `.success` — so using it here would silently
  // redirect to (and let a cold hit's own cache backfill persist) a
  // value the guard never actually validated. No character in the gap
  // `.trim()` closes is exploitable against `encodeDestinationForHeader`
  // TODAY (verified by hand: only tab/space/NBSP overlap, and each either
  // lands the browser on the same validated host via its own leading-trim
  // or degrades to inert) — but that safety is `encodeDestinationForHeader`
  // behaving incidentally well for a purpose it was never written for, not
  // a guarantee this guard makes. Using the validated string is what
  // makes "validated" and "served" provably the same value, independent
  // of that incidental behavior.
  sendLinkRedirect(res, destinationCheck.data);
  if (res.statusCode !== 307) {
    // sendLinkRedirect itself 404'd: an unencodable destination
    // (encodeDestinationForHeader's own `null` case, ./redirect-response.ts).
    // No successful redirect happened, so — same reasoning as the
    // link-miss branch above — there is nothing honest to enqueue.
    //
    // [T2.5.3, reported gap] This is the ONE terminal 404 on the redirect
    // path that does NOT get S2.5's branded body: by the time control
    // returns here, sendLinkRedirect has already called
    // `res.status(404).end()` with no body of its own — the response is
    // closed, and there is nothing left to attach a body to. Giving this
    // outcome the branded document would mean changing sendLinkRedirect's
    // own contract (e.g. exporting its encode check so this function
    // could decide the 404 itself, ahead of calling it), which touches
    // ./redirect-response.ts — a file outside this task's own `files`
    // line, and one the epic's review culture has already gone several
    // rounds on (see that file's own header). Left as a named, tested gap
    // (not-found-routing.test.ts) rather than silently worked around.
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

// T2.4.5 [security] — a single capturing-group regex, matched against the
// SCHEME grammar RFC 3986 §3.1 defines (a letter, then any run of
// letters/digits/`+`/`-`/`.`, terminated by `:`), never against the
// destination's own semantics. Deliberately NOT `new URL(destination)`:
// that is exactly the WHATWG parse the guard above already ran (via
// `zDestination`) and already knows failed — re-parsing an untrusted
// string a second time to describe why it failed would be pointless work
// on a path already producing a 404, and a `new URL()` failure carries no
// extra diagnostic value `.protocol` wouldn't have given anyway. A plain
// regex also has no failure mode of its own to guard against: unlike
// `new URL()`, it cannot throw.
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

// [fix round 1, security] `zDestination` rejects for reasons OTHER than
// scheme grammar — a PROTOCOL MISMATCH (any scheme that isn't http/https)
// is the common case, and SCHEME_PATTERN's own character class
// (`[a-zA-Z0-9+.-]`) is permissive enough that a destination like
// `'a'.repeat(2000) + ':x'` is a syntactically valid URL (`new URL()`
// accepts it; only the protocol check fails, not the length bound) whose
// entire 2000-character run would otherwise be captured verbatim as the
// "scheme" — echoing essentially the whole attacker-controlled
// destination into an `error` log, exactly what this guard's own log
// line promises never to do. REJECTED_SCHEME_MAX_LENGTH hard-caps the
// captured group before it is ever logged, rather than trying to
// second-guess what a "real" scheme looks like (an allowlist would need
// updating every time a legitimate-but-unusual scheme shows up in a
// rejection, for zero security benefit — the cap's only job is bounding
// attacker-controlled output, not classifying it). 32 is comfortably
// longer than any real IANA-registered scheme (the longest few, e.g.
// "microsoft-edge", are under 20 characters) and short enough that even
// a maximally crafted payload never leaks more than a fixed, small
// prefix.
const REJECTED_SCHEME_MAX_LENGTH = 32;

/**
 * Describes ONLY the scheme of a rejected destination — never the
 * destination itself, and never more than {@link REJECTED_SCHEME_MAX_LENGTH}
 * characters of it (see that constant's own comment) — for the
 * open-redirect guard's error log, above. Four shapes, each named
 * distinctly so an operator reading the log doesn't have to guess:
 *   - `javascript:alert(1)` / `data:text/html,x` -> `"javascript"` /
 *     `"data"`: a real, dangerous scheme. This is the case the guard
 *     exists for.
 *   - `//evil.com` -> `"(protocol-relative)"`: no scheme at all, but the
 *     `//` prefix is its own recognizable attack shape (inherits whatever
 *     scheme the CURRENT page is loaded under), worth naming specifically
 *     rather than folding into the generic "no scheme" case below.
 *   - `/relative` (or anything else with no leading scheme and no `//`
 *     prefix) -> `"(no scheme)"`.
 *   - anything whose scheme text exceeds the cap -> the first
 *     {@link REJECTED_SCHEME_MAX_LENGTH} characters plus a trailing `…`,
 *     so the log line itself signals truncation rather than looking like
 *     a short, complete scheme.
 * A destination that merely exceeds `zDestination`'s length bound, or is
 * `http(s)`-prefixed but fails full URL parsing (both pass the DB's own
 * loose `^https?://` CHECK constraint) still reports its real scheme
 * (`"https"`, say) — accurate, and exactly what "the rejected scheme" the
 * task brief asks for means for a destination whose scheme was never the
 * problem.
 */
function describeRejectedScheme(destination: string): string {
  if (destination.startsWith('//')) return '(protocol-relative)';
  const match = SCHEME_PATTERN.exec(destination);
  if (!match) return '(no scheme)';
  const scheme = match[1] ?? '(no scheme)';
  return scheme.length <= REJECTED_SCHEME_MAX_LENGTH ? scheme : `${scheme.slice(0, REJECTED_SCHEME_MAX_LENGTH)}…`;
}

