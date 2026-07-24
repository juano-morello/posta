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

    if (target.kind === 'handle-root') {
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
    }

    res.set('Cache-Control', 'no-store');
    res.status(404).end();
  };
}
