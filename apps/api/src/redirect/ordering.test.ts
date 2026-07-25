import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import express from 'express';
import type { Response } from 'express';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import type { CachedLink } from '@posta/contracts';
import { createEnqueueCapture, createEnqueueDroppedCounter, type EnqueueQueue } from './enqueue';
import { makeRequestTargetParser } from './host';
import {
  consoleErrorLogger,
  createHandleRootHitsCounter,
  createRedirectMiddleware,
  type RedirectMiddlewareLogger,
} from './middleware';
import type { ResolveTenant } from './resolve-tenant';

// T2.4.3 [INV-1] — this file is the ONE place that proves the story's
// whole invariant directly: "resolve -> res.redirect(307, ...) -> THEN
// enqueue" is a strict ORDERING guarantee, not merely "both eventually
// happen". A hand-built Response double (middleware.test.ts's own makeRes)
// has no real res.end() a timing assertion could trust — Express's real
// `Response#end` is what a live client actually waits on, so every test
// below drives a REAL http server, exactly like middleware.test.ts's own
// Nest-mounted describe block and redirect-response.test.ts's real-Express
// block already do for their own concerns.
//
// What is deliberately NOT re-tested here: resolve-tenant.test.ts and
// resolve-link.test.ts already prove resolveTenant/resolveLink's own
// correctness against real Postgres/Redis, and enqueue.test.ts already
// proves createEnqueueCapture's in-flight cap against a real BullMQ queue.
// This file stubs both resolution tiers and the queue's own `add()` — the
// only thing under test here is the ORDER handleLinkTarget calls them in,
// and that a slow/rejecting queue never costs the redirect. Reusing real
// containers for that would only add latency and noise to an assertion
// that has nothing to do with Postgres or Redis correctness.

const DOMAIN = 'example.test';
const HANDLE = 'juano';
const SLUG = 'promo';
const TENANT_ID = 'tenant-1';
const LINK_ID = 'link-1';
const DESTINATION = 'https://example.test/dest';

const resolveTenantStub: ResolveTenant = async (handle) => (handle === HANDLE ? TENANT_ID : null);

async function resolveLinkStub(tenantId: string, slug: string): Promise<CachedLink | null> {
  if (slug !== SLUG) return null;
  return { link_id: LINK_ID, tenant_id: tenantId, destination: DESTINATION };
}

interface TimelineEntry {
  readonly label: 'res.end' | 'queue.add';
  readonly at: number;
}

interface TestServer {
  readonly port: number;
  readonly timeline: TimelineEntry[];
  readonly addCalls: number;
  close(): Promise<void>;
}

/** The pieces beyond `addImpl` a handful of tests below need to swap out
 * — resolveLink (an unencodable destination), lookupNetwork (a
 * capture-pipeline throw), and logger (to inspect what gets logged when
 * it does). Everything else stays the shared happy-path stub. */
interface ServerOverrides {
  readonly resolveLink?: (tenantId: string, slug: string) => Promise<CachedLink | null>;
  readonly lookupNetwork?: (ip: string, cfCountry?: string | null) => { asn: number | null; country: string | null };
  readonly logger?: RedirectMiddlewareLogger;
}

/**
 * Boots a real Express + http server hosting ONLY createRedirectMiddleware
 * — no Nest catch-all is needed here (T2.1.4's own real-server test
 * already proves the mount-ordering claim against Nest; this file only
 * needs a real res.end()). `addImpl` is the piece every test below
 * controls: what the stubbed BullMQ queue's `add()` does and how long it
 * takes to settle. `overrides` swaps the handful of other deps a few
 * tests need — see {@link ServerOverrides}.
 *
 * `res.end` is monkey-patched on every response BEFORE the redirect
 * middleware runs, recording a timeline entry the instant the ORIGINAL
 * end() is invoked — i.e. the exact moment headers/status are flushed to
 * the socket, not some proxy for it.
 */
function buildServer(
  addImpl: (name: string, data: unknown) => Promise<unknown>,
  overrides: ServerOverrides = {},
): Promise<TestServer> {
  const timeline: TimelineEntry[] = [];
  let addCalls = 0;

  const app = express();
  app.use((_req, res: Response, next) => {
    const originalEnd = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      timeline.push({ label: 'res.end', at: performance.now() });
      return originalEnd(...args);
    }) as typeof res.end;
    next();
  });

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

  const queue: EnqueueQueue = {
    add: (name, data) => {
      addCalls += 1;
      timeline.push({ label: 'queue.add', at: performance.now() });
      return addImpl(name, data);
    },
  };
  const droppedCounter = createEnqueueDroppedCounter(new Registry());
  const enqueueCapture = createEnqueueCapture({ queue, droppedCounter });

  app.use(
    createRedirectMiddleware({
      parseRequestTarget,
      logger: overrides.logger ?? consoleErrorLogger,
      handleRootHitsCounter: createHandleRootHitsCounter(new Registry()),
      resolveTenant: resolveTenantStub,
      resolveLink: overrides.resolveLink ?? resolveLinkStub,
      lookupNetwork: overrides.lookupNetwork ?? (() => ({ asn: null, country: null })),
      getDailySalt: async () => 'ordering-test-salt-not-a-real-secret',
      enqueueCapture,
    }),
  );

  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        timeline,
        get addCalls() {
          return addCalls;
        },
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.once('error', reject);
  });
}

interface RedirectResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly receivedAt: number;
}

function requestLink(port: number, path: string): Promise<RedirectResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, headers: { Host: `${HANDLE}.${DOMAIN}` } },
      (res) => {
        const receivedAt = performance.now();
        res.resume();
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, receivedAt });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Polls `predicate` until it returns true or `timeoutMs` elapses. Used
 * instead of a fixed sleep so these tests wait exactly as long as the
 * post-redirect capture/enqueue continuation actually takes, no longer. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const openServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe('redirect -> enqueue ordering (T2.4.3) [INV-1]', () => {
  it('the res.end timestamp strictly precedes the first queue.add call', async () => {
    const server = await buildServer(() => Promise.resolve('job-1'));
    openServers.push(server);

    const response = await requestLink(server.port, `/${SLUG}`);
    expect(response.status).toBe(307);

    await waitFor(() => server.addCalls === 1);

    const firstResEnd = server.timeline.find((entry) => entry.label === 'res.end');
    const firstQueueAdd = server.timeline.find((entry) => entry.label === 'queue.add');
    expect(firstResEnd).toBeDefined();
    expect(firstQueueAdd).toBeDefined();
    // Both the timeline's own ORDER (res.end recorded before queue.add)
    // and the raw timestamps agree — belt and braces against a timeline
    // array that happened to be built in the right order by accident.
    expect(server.timeline.indexOf(firstResEnd!)).toBeLessThan(server.timeline.indexOf(firstQueueAdd!));
    expect(firstResEnd!.at).toBeLessThan(firstQueueAdd!.at);
  });

  it('a queue.add() that rejects after 500ms still delivers the 307 in under 15ms', async () => {
    const server = await buildServer(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('queue down')), 500)),
    );
    openServers.push(server);

    // One warm-up request first — connection/JIT warm-up noise is not
    // what this assertion cares about; the SLOW QUEUE never blocking the
    // redirect is.
    await requestLink(server.port, `/${SLUG}`);
    await waitFor(() => server.addCalls === 1);

    const startedAt = performance.now();
    const response = await requestLink(server.port, `/${SLUG}`);
    const elapsedMs = response.receivedAt - startedAt;

    expect(response.status).toBe(307);
    expect(elapsedMs).toBeLessThan(15);
  });

  it('produces no unhandled rejection when the enqueue rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    const server = await buildServer(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('queue down')), 500)),
    );
    openServers.push(server);

    try {
      const response = await requestLink(server.port, `/${SLUG}`);
      expect(response.status).toBe(307);

      await waitFor(() => server.addCalls === 1);
      // Wait past the 500ms rejection point (plus margin) so the
      // internal .catch() has actually had a chance to run — this is the
      // window in which a missing .catch() would surface as an
      // unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 700));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandled).toEqual([]);
  });

  it('a 404 path (unresolvable slug) enqueues nothing at all', async () => {
    const server = await buildServer(() => Promise.resolve('job-1'));
    openServers.push(server);

    const response = await requestLink(server.port, '/does-not-exist');

    expect(response.status).toBe(404);
    // No link_id exists for an unresolved slug — events.link_id is NOT
    // NULL by design, so there is nothing honest to enqueue. Give the
    // (non-existent) post-redirect continuation a moment it would need if
    // it were ever wrongly triggered, then assert it never was.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.addCalls).toBe(0);
  });

  it('an unencodable destination 404s via sendLinkRedirect itself and enqueues nothing', async () => {
    const BAD_SLUG = 'bad-destination';
    // A lone, unpaired UTF-16 surrogate — encodeDestinationForHeader's own
    // `null` case (middleware.ts, T2.4.1 fix round 2): there is no valid
    // Location for this destination, so sendLinkRedirect itself 404s
    // instead of returning a 307.
    const unencodableDestination = `https://example.test/x${String.fromCharCode(0xd800)}x`;
    const server = await buildServer(() => Promise.resolve('job-1'), {
      resolveLink: async (tenantId, slug) =>
        slug === BAD_SLUG ? { link_id: LINK_ID, tenant_id: tenantId, destination: unencodableDestination } : null,
    });
    openServers.push(server);

    const response = await requestLink(server.port, `/${BAD_SLUG}`);

    expect(response.status).toBe(404);
    expect(response.location).toBeUndefined();
    // No successful redirect happened, so — same reasoning as an
    // unresolved slug — there is nothing honest to enqueue.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.addCalls).toBe(0);
  });

  it('a capture-pipeline failure after the redirect still leaves the 307 delivered, enqueues nothing, and logs safely', async () => {
    const errorLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger: RedirectMiddlewareLogger = {
      error: (message, meta) => {
        errorLogs.push(meta !== undefined ? { message, meta } : { message });
      },
    };
    const server = await buildServer(() => Promise.resolve('job-1'), {
      lookupNetwork: () => {
        throw new Error('geoip reader exploded');
      },
      logger,
    });
    openServers.push(server);

    const response = await requestLink(server.port, `/${SLUG}`);
    expect(response.status).toBe(307);

    await waitFor(() => errorLogs.length === 1);
    // Never called: the throw happened before buildCapturePayload/enqueue
    // ever ran.
    expect(server.addCalls).toBe(0);

    expect(errorLogs).toHaveLength(1);
    const [{ message, meta } = { message: '', meta: undefined }] = errorLogs;
    expect(message).toContain('Capture failed');
    // The SAFE shape: only the error's constructor name and the
    // identity/context fields already known (tenantId, slug) — never the
    // request, never the raw error object or its message.
    expect(meta).toMatchObject({ errorType: 'Error', tenantId: TENANT_ID, slug: SLUG });
    expect(JSON.stringify({ message, meta })).not.toContain('geoip reader exploded');
  });
});
