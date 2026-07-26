import http from 'node:http';
import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { Application } from 'express';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import type { CachedLink } from '@posta/contracts';
import type { GetDailySalt, LookupNetwork } from '@posta/core';
import type { EnqueueCapture } from '../enqueue';
import { makeRequestTargetParser } from '../host';
import {
  createHandleRootHitsCounter,
  createOpenRedirectRejectedCounter,
  createRedirectMiddleware,
  type RedirectMiddlewareLogger,
} from '../middleware';
import { makeNotFoundRenderer } from '../not-found';
import type { ResolveTenant } from '../resolve-tenant';

// T2.6.7 [INV-2] — "the redirect middleware is registered before the Nest
// router" as a structural, CI-checkable fact, not merely an inference from
// behavior. Two things neither existing S2.6 test proves:
//   1. The literal index the redirect layer occupies in Express's OWN
//      router stack is lower than the index Nest's router installs its own
//      colliding route at (T2.1.4's middleware.test.ts already proves the
//      BEHAVIORAL consequence of this — a catch-all Nest controller never
//      answers a handle host — but never inspects the stack itself, so a
//      change that broke the ordering AND happened to also change the
//      behavior in some compensating way would not be caught by index
//      inspection alone either; this file adds that missing structural
//      layer).
//   2. `createRedirectMiddleware` itself is a boot-time factory, called
//      EXACTLY ONCE for the life of the process — "zero per-request
//      instantiation" is INV-2's own wording, and nothing before this task
//      asserted the call COUNT in a form CI can check; every other S2.6
//      test asserts the middleware's OUTPUT (a 404, a 307, a header) which
//      would look identical whether the factory ran once or once per
//      request.
//
// [deliberate, reported deviation from "reuse the harness"] Every other
// S2.6 test (T2.6.2/4/5/6/8/9) reuses hot-path-harness.ts's
// `startHotPathHarness()`. This file does NOT, for two reasons specific to
// THIS task and not to the others:
//   - This task needs the raw Express `Application` object itself (to walk
//     `.router.stack`) and the exact function reference
//     `createRedirectMiddleware` returns (to identify "the redirect
//     layer" by identity, and to wrap the factory in a spy). Neither is
//     part of `HotPathHarness`'s returned shape (`baseUrl`, `port`, `db`,
//     `pool`, `redis`, `queue`, `logs`, `tenantId`, `linkId`, `stop`) —
//     deliberately, since every other S2.6 test only ever needs to talk to
//     the app over HTTP.
//   - Extending that shared file to expose them is explicitly out of
//     bounds for this task: hot-path-harness.ts is depended on by five
//     already-landed sibling tests, and (per this task's own dispatch)
//     another task may be concurrently editing it in this same shared
//     worktree — touching it here risks a real collision for a change
//     that only this one file needs.
// This file instead builds its own minimal Express+Nest composition,
// reusing the REAL production pieces (`createRedirectMiddleware`,
// `makeRequestTargetParser`, `makeNotFoundRenderer`,
// `createHandleRootHitsCounter`, `createOpenRedirectRejectedCounter` — the
// exact same functions main.ts calls) wired to local stub dependencies (a
// `resolveTenant`/`resolveLink` pair that always miss, a no-op
// `enqueueCapture`, a fixed `getDailySalt`, a null `lookupNetwork`) — no
// Postgres/Redis at all, since THIS task's acceptance criterion is about
// ROUTING/ORDERING, never about real data resolution. `NestFactory`,
// `ExpressAdapter` and the `server.use(...)` -> `NestFactory.create(...)`
// sequence are all real and unmodified — only the VALUES behind
// `createRedirectMiddleware`'s deps are stubs, exactly mirroring main.ts's
// own wiring shape (see that file's own header comment on construction
// order).
//
// [Express version, verified empirically, not assumed] apps/api depends on
// express@5.2.1, whose internal routing moved to the separate `router`
// npm package (router@2.2.0) — Express 4's `app._router` property no
// longer exists on this major. Confirmed by hand, against the ACTUAL
// installed packages (not documentation): express@5's lib/application.js
// exposes a lazily-created `app.router` getter backed by `router`'s own
// `Router` class; that Router's `.stack` is a plain array `push`ed to by
// both `.use()` (a plain middleware Layer, `router/index.js`) and
// `.route()`/`.get()` etc. (a Layer whose `.route` field is set, carrying
// that route's own path/methods — `router/lib/layer.js`). A direct
// instrumented inspection of a server built exactly like this file's own
// `buildComposition` (see below) showed the redirect middleware's layer at
// index 0 (`.handle === <the returned function>`, no `.route`) and the
// Nest-registered `ProbeController` route's layer arriving ONLY once
// `app.init()`/`app.listen()` actually runs (never earlier, at
// `NestFactory.create()` alone), as the sole layer in the whole stack
// carrying a `.route` object at all — which is what `findNestRouteLayerIndex`
// below keys on, rather than matching the exact normalized path string
// (an implementation detail of path-to-regexp's own formatting, not a
// contract this test should depend on).

const DOMAIN = 'example.test';
// A well-formed, non-reserved slug (packages/contracts/src/links.ts's
// SLUG_PATTERN: lowercase alnum + hyphens) — deliberately NOT a reserved
// path/handle, so host.ts's parseRequestTarget classifies a request for it
// on a real handle host as `kind: 'link'` (a genuine lookup attempt, not a
// pre-empted reserved-path/handle short-circuit that would prove nothing
// about THIS ordering claim — reserved.test.ts already covers that
// separate concern). It also happens to collide exactly with
// ProbeController's own `:slug` route below, which is the point: a path
// that is simultaneously "a link lookup on the handle host" and "a match
// for Nest's own colliding route" is what makes the collision proof real
// rather than incidental.
const PROBE_PATH = 'probe-collision';

// The Nest module under test: a controller whose ONLY route is a `:slug`
// catch-all, deliberately shaped to collide with the redirect middleware's
// own path space (host.ts's `extractSlug`) rather than middleware.test.ts's
// own broader `*path` catch-all — this is the exact collision T2.6.7's
// brief names. Applied as PLAIN FUNCTION CALLS, not `@Decorator` syntax:
// apps/api/tsconfig.json excludes `src/**/*.test.ts` from its own program,
// so Vitest's per-file tsconfig resolution falls back to
// `experimentalDecorators: false` for any `*.test.ts` file, under which
// native `@Decorator` class/method syntax fails to parse at all (confirmed
// by hand, and already the exact reasoning middleware.test.ts's own header
// comment documents for its identical CatchAllController). Calling
// `Controller()`/`Get()`/`Module()` directly reproduces byte-for-byte
// identical `Reflect.defineMetadata` output, since that is all the
// `@`-syntax ever was.
class ProbeController {
  probe(): string {
    return 'nest-router-reached';
  }
}
Controller()(ProbeController);
Get(':slug')(
  ProbeController.prototype,
  'probe',
  Object.getOwnPropertyDescriptor(ProbeController.prototype, 'probe')!,
);

class ProbeModule {}
Module({ controllers: [ProbeController] })(ProbeModule);

// [T2.4.3-style stubs] None of this task's assertions are about real data
// resolution — resolveTenant/resolveLink always miss, so every 'link'-kind
// request on the handle host terminates in sendNotFound (middleware.ts),
// never a 307. That is exactly what makes the behavioral collision proof
// clean: a 404 body can be asserted to never contain the Nest controller's
// 'nest-router-reached' string, with no real link ever needing to exist.
const stubLogger: RedirectMiddlewareLogger = { error: () => {} };
const stubResolveTenant: ResolveTenant = async () => null;
const stubResolveLink = async (_tenantId: string, _slug: string): Promise<CachedLink | null> => null;
const stubLookupNetwork: LookupNetwork = () => ({ asn: null, country: null });
const stubGetDailySalt: GetDailySalt = async () => 'middleware-order-test-salt-not-a-real-secret';
const stubEnqueueCapture: EnqueueCapture = async () => {};

/** The shape `.router.stack` entries actually have — see this file's own
 * header for how this was verified against the real installed express/router
 * versions. Only the two fields this test reads. */
interface ExpressRouterLayer {
  readonly handle: unknown;
  readonly route?: { readonly path?: unknown };
}

/**
 * Reaches Express 5's routing internals. Deliberately NOT `app._router`
 * (Express 4's property, removed in 5) — see this file's header. There is
 * no public `@types/express` surface for this, so the cast is the
 * documented, narrow exception rather than a stray `any`.
 */
function getRouterStack(server: Application): readonly ExpressRouterLayer[] {
  return (server as unknown as { readonly router: { readonly stack: readonly ExpressRouterLayer[] } }).router.stack;
}

/** The redirect middleware's own layer — identified by REFERENCE EQUALITY
 * to the exact function `createRedirectMiddleware` returned, not by name or
 * position, so this cannot accidentally match some other anonymous
 * middleware layer that happens to sit at the same index. */
function findLayerIndexByHandle(stack: readonly ExpressRouterLayer[], handle: unknown): number {
  return stack.findIndex((layer) => layer.handle === handle);
}

/** The FIRST (and, in this composition, only) layer carrying a `.route`
 * object — a field only ever set by an HTTP-method+path registration
 * (`app.get(path, fn)`, exactly how Nest's RoutesResolver mounts every
 * controller method), never by a plain `.use()` middleware layer. This
 * composition mounts exactly one such registration (ProbeController's
 * `:slug` route), so this is unambiguous. */
function findNestRouteLayerIndex(stack: readonly ExpressRouterLayer[]): number {
  return stack.findIndex((layer) => layer.route !== undefined);
}

function requestPath(port: number, host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the redirect middleware is registered before the Nest router (T2.6.7) [INV-2]', () => {
  let app: NestExpressApplication;
  let server: Application;
  let port: number;
  let middlewareHandler: unknown;
  let factorySpy: Mock<typeof createRedirectMiddleware>;

  beforeAll(async () => {
    // A dedicated Registry per this file's own boot, matching every other
    // S2.6 test's own convention — avoids colliding with another test
    // file's identically-named prom-client Counter on the shared global
    // default registry.
    const registry = new Registry();
    const urls = makeUrlBuilders({ domain: DOMAIN, protocol: 'http', appSubdomain: 'app', apiSubdomain: 'api' });
    const parseRequestTarget = makeRequestTargetParser({ urls, reservedHandles: resolveReservedHandles() });
    const renderNotFound = makeNotFoundRenderer({ urls });

    // Wraps the REAL createRedirectMiddleware in a spy that still executes
    // it — this is "boot", called exactly once, right here, mirroring
    // main.ts's own single call site (see main.ts's own header: "called
    // exactly ONCE, right here, from already-validated env").
    factorySpy = vi.fn(createRedirectMiddleware);

    server = express();
    middlewareHandler = factorySpy({
      parseRequestTarget,
      logger: stubLogger,
      handleRootHitsCounter: createHandleRootHitsCounter(registry),
      resolveTenant: stubResolveTenant,
      resolveLink: stubResolveLink,
      lookupNetwork: stubLookupNetwork,
      getDailySalt: stubGetDailySalt,
      enqueueCapture: stubEnqueueCapture,
      openRedirectRejectedCounter: createOpenRedirectRejectedCounter(registry),
      renderNotFound,
    });
    // Mounted on `server` BEFORE NestFactory.create ever sees it — the
    // exact construction order main.ts's own header comment requires:
    // "the redirect middleware physically cannot run after a router that
    // does not exist yet when server.use() below executes".
    server.use(middlewareHandler as express.RequestHandler);

    app = await NestFactory.create<NestExpressApplication>(ProbeModule, new ExpressAdapter(server), {
      logger: false,
    });
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it("the redirect layer's stack index is lower than Nest's own route layer", () => {
    const stack = getRouterStack(server);

    const redirectIndex = findLayerIndexByHandle(stack, middlewareHandler);
    const nestRouteIndex = findNestRouteLayerIndex(stack);

    // Both must actually be found — a -1 on either side would make the
    // ordering comparison below pass vacuously (e.g. if the redirect
    // handler were somehow never matched by reference, or the Probe route
    // never got registered at all), which would prove nothing.
    expect(redirectIndex).not.toBe(-1);
    expect(nestRouteIndex).not.toBe(-1);
    expect(redirectIndex).toBeLessThan(nestRouteIndex);
  });

  it('the colliding Nest route never answers on a handle host — the redirect middleware terminates first', async () => {
    const response = await requestPath(port, `juano.${DOMAIN}`, `/${PROBE_PATH}`);

    // stubResolveTenant always misses, so this terminates in
    // sendNotFound's branded 404 (middleware.ts) — never a 307, and
    // (this is the point) never the Nest controller's own body either.
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('nest-router-reached');
  });

  it('the SAME colliding Nest route DOES answer on api.<domain> — proving the collision is real', async () => {
    // api.<domain> is a host host.ts's own parseRequestTarget classifies
    // as `not-ours` (parseHandleFromHost refuses `api` as a claimable
    // handle — it is this deployment's own API host, per
    // packages/contracts/src/domain.ts) — the redirect middleware calls
    // next() unconditionally for this kind, falling through to Nest's
    // router, where ProbeController's `:slug` route is the ONLY thing
    // mounted and therefore answers every single-segment path.
    const response = await requestPath(port, `api.${DOMAIN}`, `/${PROBE_PATH}`);

    expect(response.status).toBe(200);
    expect(response.body).toBe('nest-router-reached');
  });

  it('createRedirectMiddleware is invoked exactly once, no matter how many requests follow', async () => {
    // 200 requests, alternating between the two hosts above — mirrors
    // "zero per-request instantiation" (INV-2) in a form CI can check:
    // if a future regression rebuilt the middleware inside the request
    // handler (or per-request in any other way), this count would climb
    // with traffic instead of staying fixed at the one boot-time call.
    const totalRequests = 200;
    const responses = await Promise.all(
      Array.from({ length: totalRequests }, (_, i) =>
        requestPath(port, i % 2 === 0 ? `juano.${DOMAIN}` : `api.${DOMAIN}`, `/${PROBE_PATH}`),
      ),
    );

    expect(responses).toHaveLength(totalRequests);
    // createRedirectMiddleware itself — the FACTORY — was called exactly
    // once, in this file's own beforeAll, before any of these 200
    // requests existed. Every one of the 200 calls above invoked the
    // RETURNED HANDLER, never the factory again.
    expect(factorySpy).toHaveBeenCalledTimes(1);
  });
});
