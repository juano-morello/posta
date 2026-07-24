import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { All, Controller, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { Counter, Registry, register } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import { makeRequestTargetParser } from './host';
import {
  consoleErrorLogger,
  createHandleRootHitsCounter,
  createRedirectMiddleware,
  HANDLE_ROOT_HITS_COUNTER_NAME,
} from './middleware';

// T2.1.4 [INV-2] — proves the ordering claim, not just the branching:
// the redirect middleware must be mounted on the Express instance BEFORE
// NestFactory.create wires up Nest's router, so any request it decides to
// terminate itself never reaches Nest's DI/controller stack at all. A
// unit test calling createRedirectMiddleware()'s returned handler
// directly (the second describe block below) proves the branching logic,
// but NOT the ordering — a middleware that behaved identically but got
// mounted AFTER Nest's router would pass that test just as well while
// leaving invariant 2 violated. So this file also boots a REAL app the
// same way main.ts will: `express()` -> `server.use(middleware)` ->
// `NestFactory.create(Module, new ExpressAdapter(server))`.
//
// The Nest module under test answers EVERY path with the body 'nest' via
// a catch-all controller, deliberately promiscuous: "a request to
// <handle>.<domain>/promo never returns 'nest'" is therefore a genuine
// assertion about interception, not a coincidence of Nest having no
// route for /promo. Conversely, api.<domain>/v1/ping and
// app.<domain>/dashboard MUST still reach it — parseHandleFromHost
// refuses app/api as handles (host.ts), so they arrive as `not-ours` and
// the middleware must call next() rather than swallow them, or
// api.<domain>/v1/* (all of CRUD, per CLAUDE.md's routing table) would
// stop being served.
//
// http.request (not fetch) is used to drive these requests: the Fetch
// spec lists `Host` among the forbidden request headers a caller may not
// set, and Node's own fetch (undici) honours that — a manual check
// confirmed a fetch() call with `headers: { Host: ... }` silently sends
// the real socket host instead. node:http's request() has no such
// restriction, needs no extra dependency, and is a handful of lines —
// simpler than adding supertest as a devDependency for this one file.
//
// The catch-all controller/module below apply Nest's Controller/All/
// Module decorators as PLAIN FUNCTION CALLS rather than `@Decorator`
// syntax. That is not a style preference: apps/api/tsconfig.json (the
// nearest tsconfig for any file under apps/api/src/redirect/) EXCLUDES
// `src/**/*.test.ts` from its own program, and Vite/Vitest's per-file
// tsconfig resolution (oxc's transform, in this Vite major) walks up the
// directory tree for the nearest APPLICABLE config — since this file is
// excluded from the one it would otherwise find, resolution falls back
// to defaults, i.e. `experimentalDecorators: false`. Under that default,
// `@Decorator` class/method syntax is parsed as valid native (TC39
// stage-3) syntax and left untransformed, which Node's `vm.Script`
// (Vitest's module evaluator) cannot execute without an experimental
// flag — confirmed by hand: an `@Decorator() class Foo {}` in a sibling
// *.test.ts file throws `SyntaxError: Invalid or unexpected token` at
// the `@` the instant the file is evaluated, before any test runs.
// `tsconfig.test.json` at the repo root DOES set
// experimentalDecorators/emitDecoratorMetadata, but it governs the
// separate `typecheck:tests` `tsc --noEmit` pass (T0.5.7), not Vite's
// runtime transform, so it does not help here. Since `@Controller()` /
// `@All()` / `@Module()` are themselves ordinary functions that mutate
// their target via `Reflect.defineMetadata` and only exist as `@`-syntax
// for TypeScript's sugar, calling them directly reproduces byte-for-byte
// identical runtime metadata with no special transform requirement at
// all — the safe fix that touches only this file, rather than a
// vitest.config.ts/tsconfig change with repo-wide blast radius that is
// out of this task's scope.

const DOMAIN = 'example.test';

class CatchAllController {
  handleEverything(): string {
    return 'nest';
  }
}
Controller()(CatchAllController);
All('*path')(
  CatchAllController.prototype,
  'handleEverything',
  Object.getOwnPropertyDescriptor(CatchAllController.prototype, 'handleEverything')!,
);

class TestAppModule {}
Module({ controllers: [CatchAllController] })(TestAppModule);

interface RawResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
}

/**
 * A minimal Express Response double shared by every isolated-handler test
 * below (T2.1.4's original three, plus T2.1.5's alarm and reserved-path
 * ones) — hoisted to module scope in T2.1.5 so all of them exercise the
 * identical fake rather than near-duplicate copies drifting apart.
 */
function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: undefined as number | undefined,
    ended: false,
    set(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
    headers,
  };
  return res;
}

/**
 * The exact shape of RedirectMiddlewareLogger#error, spelled out so
 * `vi.fn<LoggerErrorFn>()` produces a Mock whose call signature is
 * structurally assignable to RedirectMiddlewareLogger — an untyped
 * `vi.fn()` infers `(...args: any[]) => any`, which typechecks fine at
 * the call site but fails `tsc --noEmit -p tsconfig.test.json` (T2.6.1's
 * separate, stricter typecheck pass) when assigned to the interface.
 */
type LoggerErrorFn = (message: string, meta?: Record<string, unknown>) => void;

/**
 * Reads a Counter's current registered value off a dedicated Registry —
 * the shape T2.1.5's brief calls out explicitly (getMetricsAsJSON /
 * getSingleMetric), so these tests assert the real value prom-client has
 * recorded rather than merely that `.inc()` was called.
 */
async function getCounterValue(registry: Registry, name: string): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((entry) => entry.name === name);
  return metric?.values[0]?.value ?? 0;
}

function request(port: number, host: string, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('createRedirectMiddleware — mounted ahead of the Nest router', () => {
  let app: NestExpressApplication;
  let port: number;

  beforeAll(async () => {
    const server = express();

    const urls = makeUrlBuilders({
      domain: DOMAIN,
      protocol: 'http',
      appSubdomain: 'app',
      apiSubdomain: 'api',
    });
    const parseRequestTarget = makeRequestTargetParser({
      urls,
      reservedHandles: resolveReservedHandles(),
    });

    // Mirrors the ordering main.ts must use: mount on `server` BEFORE
    // NestFactory.create ever sees it. A dedicated Registry avoids
    // colliding with another test file's own posta_handle_root_hits
    // Counter registered against prom-client's shared global default.
    server.use(
      createRedirectMiddleware({
        parseRequestTarget,
        logger: consoleErrorLogger,
        handleRootHitsCounter: createHandleRootHitsCounter(new Registry()),
      }),
    );

    app = await NestFactory.create<NestExpressApplication>(
      TestAppModule,
      new ExpressAdapter(server),
      { logger: false },
    );
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('never returns the Nest catch-all body for a tenant link host', async () => {
    const response = await request(port, `juano.${DOMAIN}`, '/promo');

    expect(response.body).not.toBe('nest');
    expect(response.status).toBe(404);
  });

  it('still reaches the Nest catch-all for the API host', async () => {
    const response = await request(port, `api.${DOMAIN}`, '/v1/ping');

    expect(response.body).toBe('nest');
  });

  it('still reaches the Nest catch-all for the dashboard host', async () => {
    const response = await request(port, `app.${DOMAIN}`, '/dashboard');

    expect(response.body).toBe('nest');
  });

  it('still reaches the Nest catch-all for a foreign domain', async () => {
    const response = await request(port, 'evil.com', '/anything');

    expect(response.body).toBe('nest');
  });

  it('sets Cache-Control: no-store on the intercepted 404', async () => {
    const response = await request(port, `juano.${DOMAIN}`, '/promo');

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('404s a reserved handle without reaching Nest', async () => {
    const response = await request(port, `www.${DOMAIN}`, '/promo');

    expect(response.status).toBe(404);
    expect(response.body).not.toBe('nest');
  });

  it('404s the handle root without reaching Nest', async () => {
    const response = await request(port, `juano.${DOMAIN}`, '/');

    expect(response.status).toBe(404);
    expect(response.body).not.toBe('nest');
  });

  it('404s a reserved path without reaching Nest', async () => {
    const response = await request(port, `juano.${DOMAIN}`, '/favicon.ico');

    expect(response.status).toBe(404);
    expect(response.body).not.toBe('nest');
  });

  it('404s an invalid path without reaching Nest', async () => {
    const response = await request(port, `juano.${DOMAIN}`, '/PROMO');

    expect(response.status).toBe(404);
    expect(response.body).not.toBe('nest');
  });
});

describe('createRedirectMiddleware — handler behavior in isolation', () => {
  const urls = makeUrlBuilders({
    domain: DOMAIN,
    protocol: 'http',
    appSubdomain: 'app',
    apiSubdomain: 'api',
  });
  const parseRequestTarget = makeRequestTargetParser({
    urls,
    reservedHandles: resolveReservedHandles(),
  });
  const middleware = createRedirectMiddleware({
    parseRequestTarget,
    logger: consoleErrorLogger,
    handleRootHitsCounter: createHandleRootHitsCounter(new Registry()),
  });

  it('calls next() exactly once for a not-ours host and touches nothing else', () => {
    const req = { headers: { host: `api.${DOMAIN}` }, path: '/v1/ping' } as never;
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.ended).toBe(false);
    expect(res.statusCode).toBeUndefined();
  });

  it('treats a missing Host header as not-ours and falls through', () => {
    const req = { headers: {}, path: '/promo' } as never;
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.ended).toBe(false);
  });

  it('404s with Cache-Control: no-store for a link target, without calling next()', () => {
    const req = { headers: { host: `juano.${DOMAIN}` }, path: '/promo' } as never;
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.ended).toBe(true);
  });
});

// T2.1.5 — mirrors createDefaultPartitionRowsGauge's own coverage test
// (apps/worker/src/partitions/partition-maintenance.job.test.ts): the
// `...(registry ? { registers: [registry] } : {})` spread has two
// branches, and every other test in this file deliberately exercises
// only the "a registry was given" one (to avoid colliding with another
// test file's own posta_handle_root_hits Counter on prom-client's shared
// global default registry). This is the one place that intentionally
// exercises the omitted-registry default, so it must clean up
// immediately after asserting.
describe('createHandleRootHitsCounter — both registry paths (coverage)', () => {
  it('registers on the given registry when one is provided', () => {
    const registry = new Registry();

    const counter = createHandleRootHitsCounter(registry);

    expect(registry.getSingleMetric(HANDLE_ROOT_HITS_COUNTER_NAME)).toBe(counter);
  });

  it("falls back to prom-client's shared default registry when none is provided", () => {
    try {
      const counter = createHandleRootHitsCounter();

      expect(register.getSingleMetric(HANDLE_ROOT_HITS_COUNTER_NAME)).toBe(counter);
    } finally {
      register.removeSingleMetric(HANDLE_ROOT_HITS_COUNTER_NAME);
    }
  });
});

// T2.1.5 — "/" on a handle host means the Cloudflare Origin Rule
// (path == "/" -> Next) is misconfigured: the bio page's visitor is
// getting a 404 instead of their page, and without a signal here nobody
// would ever find out. A fresh Registry + Counter + spy logger per test
// (via beforeEach) so "exactly 1" and "exactly 2" assertions below can
// never be polluted by a previous test's increment or log call.
describe('createRedirectMiddleware — handle-root alarm (T2.1.5)', () => {
  const urls = makeUrlBuilders({
    domain: DOMAIN,
    protocol: 'http',
    appSubdomain: 'app',
    apiSubdomain: 'api',
  });
  const parseRequestTarget = makeRequestTargetParser({
    urls,
    reservedHandles: resolveReservedHandles(),
  });

  let registry: Registry;
  let handleRootHitsCounter: Counter<string>;
  let logger: { error: ReturnType<typeof vi.fn<LoggerErrorFn>> };
  let middleware: ReturnType<typeof createRedirectMiddleware>;

  beforeEach(() => {
    registry = new Registry();
    handleRootHitsCounter = createHandleRootHitsCounter(registry);
    logger = { error: vi.fn<LoggerErrorFn>() };
    middleware = createRedirectMiddleware({ parseRequestTarget, logger, handleRootHitsCounter });
  });

  it('404s "/" on a handle host, with Cache-Control: no-store and no next()', () => {
    const req = { headers: { host: `juano.${DOMAIN}` }, path: '/' } as never;
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.ended).toBe(true);
  });

  it('emits exactly one error log naming the handle', () => {
    const req = { headers: { host: `juano.${DOMAIN}` }, path: '/' } as never;

    middleware(req, makeRes() as never, vi.fn());

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.error.mock.calls[0] as [
      string,
      Record<string, unknown> | undefined,
    ];
    expect(message).toContain('juano');
    expect(meta).toMatchObject({ handle: 'juano' });
  });

  it('increments posta_handle_root_hits by exactly 1', async () => {
    const req = { headers: { host: `juano.${DOMAIN}` }, path: '/' } as never;

    middleware(req, makeRes() as never, vi.fn());

    expect(await getCounterValue(registry, HANDLE_ROOT_HITS_COUNTER_NAME)).toBe(1);
  });

  it('two separate handle-root hits log twice and increment by exactly 2 — no per-layer double counting', async () => {
    const req = { headers: { host: `juano.${DOMAIN}` }, path: '/' } as never;

    middleware(req, makeRes() as never, vi.fn());
    middleware(req, makeRes() as never, vi.fn());

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(await getCounterValue(registry, HANDLE_ROOT_HITS_COUNTER_NAME)).toBe(2);
  });
});

// T2.1.5 — reserved paths (and the other non-alarm kinds already covered
// by T2.1.4) must answer immediately with no side effect beyond the 404
// itself. The brief's verify line asks for "no Redis GET, no Postgres
// query, no enqueue" — that is a STRUCTURAL fact at this task, not a
// behavioral one: the middleware holds no Redis client and no database
// handle at all yet (see RedirectMiddlewareDeps' own comment in
// middleware.ts — `redis` is deliberately deferred to T2.2.3, the first
// task that reads it). There is nothing to spy on here. What these tests
// assert instead: the observable response (404, no-store, no next()) and
// that neither of the alarm's two side effects — the error log, the
// counter increment — fire for anything other than handle-root. The
// end-to-end "zero lookups against a real client" assertion lands at
// T2.6.5, once `redis` actually exists on this middleware's deps.
describe('createRedirectMiddleware — reserved paths short-circuit, no alarm (T2.1.5)', () => {
  const urls = makeUrlBuilders({
    domain: DOMAIN,
    protocol: 'http',
    appSubdomain: 'app',
    apiSubdomain: 'api',
  });
  const parseRequestTarget = makeRequestTargetParser({
    urls,
    reservedHandles: resolveReservedHandles(),
  });

  let registry: Registry;
  let handleRootHitsCounter: Counter<string>;
  let logger: { error: ReturnType<typeof vi.fn<LoggerErrorFn>> };
  let middleware: ReturnType<typeof createRedirectMiddleware>;

  beforeEach(() => {
    registry = new Registry();
    handleRootHitsCounter = createHandleRootHitsCounter(registry);
    logger = { error: vi.fn<LoggerErrorFn>() };
    middleware = createRedirectMiddleware({ parseRequestTarget, logger, handleRootHitsCounter });
  });

  it.each([['/favicon.ico'], ['/robots.txt'], ['/.well-known/x']])(
    '404s %s immediately with no-store, no alarm log, no counter increment',
    async (path) => {
      const req = { headers: { host: `juano.${DOMAIN}` }, path } as never;
      const res = makeRes();
      const next = vi.fn();

      middleware(req, res as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(404);
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(logger.error).not.toHaveBeenCalled();
      expect(await getCounterValue(registry, HANDLE_ROOT_HITS_COUNTER_NAME)).toBe(0);
    },
  );

  it('a reserved-handle target 404s with no alarm log and no counter increment', async () => {
    const req = { headers: { host: `www.${DOMAIN}` }, path: '/promo' } as never;
    const res = makeRes();

    middleware(req, res as never, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(logger.error).not.toHaveBeenCalled();
    expect(await getCounterValue(registry, HANDLE_ROOT_HITS_COUNTER_NAME)).toBe(0);
  });

  it('an invalid-path target 404s with no alarm log and no counter increment', async () => {
    const req = { headers: { host: `juano.${DOMAIN}` }, path: '/PROMO' } as never;
    const res = makeRes();

    middleware(req, res as never, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(logger.error).not.toHaveBeenCalled();
    expect(await getCounterValue(registry, HANDLE_ROOT_HITS_COUNTER_NAME)).toBe(0);
  });
});
