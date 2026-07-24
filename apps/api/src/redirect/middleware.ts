import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ParseRequestTarget } from './host';

// T2.1.4 [INV-2] — the redirect hot path itself: a raw Express middleware
// mounted on the Express instance BEFORE NestFactory.create wires up
// Nest's router (see main.ts). A redirect must never pay for Nest's
// DI/controller ceremony, so this file has none: no decorators, no
// providers, nothing `new`ed per request.
//
// Dependency shape: `deps` carries ONLY `parseRequestTarget` — the brief
// for this story describes the eventual factory as
// `createRedirectMiddleware({ redis })`, but at T2.1.4 the middleware does
// not read Redis at all (that starts at T2.2.3's cached slug lookup). An
// unused `redis` field today would be dead config threaded through for no
// reason, so it is deliberately deferred to the task that first reads it
// rather than added speculatively (YAGNI). `parseRequestTarget` itself is
// built ONCE at boot (see main.ts: makeUrlBuilders + resolveReservedHandles
// + makeRequestTargetParser, all called a single time) and closed over
// here — this factory is called exactly once, and the handler it returns
// allocates nothing beyond the `target` it computes for the request it is
// currently serving.
//
// Scope, deliberately narrow — everything below is a LATER task, not a
// bug:
//   - T2.1.5 adds the handle-root alarm (error log + counter) and makes
//     reserved-path/reserved-handle skip work explicitly proven zero-cost.
//   - T2.5.2/T2.5.3 give the 404 a branded HTML body; a bare empty 404 is
//     correct here.
//   - S2.2 onward add the actual 'link' kind's slug resolution, Redis
//     lookup and enqueue.
// Every RequestTarget kind other than 'not-ours' therefore gets the exact
// same bare 404 for now — the branching those later tasks need doesn't
// exist yet because building it here would be scope creep this task's
// brief explicitly rules out.

export interface RedirectMiddlewareDeps {
  /** Built once at boot — see main.ts. Never constructed per request. */
  readonly parseRequestTarget: ParseRequestTarget;
}

/**
 * Builds the redirect middleware from dependencies resolved once at boot.
 * `not-ours` (a host this deployment did not construct, or the app./api.
 * hosts Nest itself owns) calls `next()` and falls through to Nest's
 * router. Every other kind — this deployment addressed the request, one
 * way or another — terminates here with a bare 404 and
 * `Cache-Control: no-store`, so nothing downstream ever caches a wrong
 * answer.
 */
export function createRedirectMiddleware(deps: RedirectMiddlewareDeps): RequestHandler {
  const { parseRequestTarget } = deps;

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

    res.set('Cache-Control', 'no-store');
    res.status(404).end();
  };
}
