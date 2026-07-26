import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import type { CachedLink } from '@posta/contracts';
import { createEnqueueCapture, createEnqueueDroppedCounter, type EnqueueQueue } from './enqueue';
import { makeRequestTargetParser } from './host';
import {
  consoleErrorLogger,
  createHandleRootHitsCounter,
  createOpenRedirectRejectedCounter,
  createRedirectMiddleware,
  type RedirectMiddlewareLogger,
} from './middleware';
import { makeNotFoundRenderer } from './not-found';
import type { ResolveTenant } from './resolve-tenant';

// T2.5.3 — wires renderNotFound (T2.5.2) into every terminal 404 branch
// the redirect middleware itself decides. This file proves the WIRING,
// not the document's own content (not-found.test.ts already owns that:
// escaping, the 4 KB budget, the dark-island tokens) — every assertion
// here is "did THIS branch get the SAME document renderNotFound(x) would
// produce for the value this task decided to show", plus the invariant
// this task's brief calls out by name: a 404 never enqueues.
//
// A real Express + http server, exactly like ordering.test.ts's own
// approach (not open-redirect.test.ts's containers) — no Postgres/Redis
// correctness is under test here, resolveTenant/resolveLink are plain
// stubs, so a real server is enough to prove headers/body/status without
// any container overhead.
//
// [decision 2, recorded here per the dispatch's own request] What each
// branch reflects as its "slug":
//   - 'link' (unknown handle, unknown slug, archived, rejected
//     destination, and the Postgres-failure branch below): the decoded,
//     already-`isValidSlug`-validated `slug` the request actually asked
//     for — the one piece of per-request identity every one of these
//     outcomes shares.
//   - 'handle-root': '' — there is no slug at all (`/` has nothing after
//     it), matching the brief's own framing.
//   - 'reserved-path' / 'invalid-path': the raw request path with its
//     one leading slash stripped (a full path, not a validated slug —
//     `invalid-path` is not named by the brief's own six-item list, but
//     it is structurally identical to reserved-path in host.ts's own
//     union, so it gets the same treatment).
//   - 'reserved-handle': '' — deliberately, even though req.path is
//     technically available here too. The brief's own decision-2 framing
//     ("reserved-handle has neither") is followed literally: the
//     interesting fact about this branch is the HOST, and the path that
//     happened to follow it says nothing about that.
//
// [T2.5.3 fix round 1] A SEVENTH terminal outcome — an unencodable
// destination (a lone UTF-16 surrogate embedded in an otherwise-valid
// destination) — used to be answered entirely inside sendLinkRedirect
// (./redirect-response.ts) with a bare `res.status(404).end()`, before
// handleLinkTarget (middleware.ts) ever regained control to attach a
// body. The review round that followed this task's first pass flagged
// that as an "in all cases" gap against S2.5's own acceptance criterion
// (dark-island styling in ALL cases) and asked for it closed: sendLinkRedirect
// now returns a boolean instead of finalizing the response itself on
// failure, so handleLinkTarget can route this outcome through the SAME
// sendNotFound every other terminal branch uses. The describe block below
// (previously "known gap") now asserts the branded body IS served here,
// so the gap cannot silently reopen.

const DOMAIN = 'example.test';
const HANDLE = 'juano';
const TENANT_ID = 'tenant-1';
const LINK_ID = 'link-1';
const DESTINATION = 'https://example.test/dest';
const REJECTED_DESTINATION = 'javascript:alert(1)';
const UNENCODABLE_DESTINATION = `https://example.test/x${String.fromCharCode(0xd800)}x`;

const KNOWN_SLUG = 'promo';
const ARCHIVED_SLUG = 'archived-promo';
const REJECTED_SLUG = 'poisoned';
const UNENCODABLE_SLUG = 'bad-encoding';

const urls = makeUrlBuilders({
  domain: DOMAIN,
  protocol: 'http',
  appSubdomain: 'app',
  apiSubdomain: 'api',
});
const renderNotFound = makeNotFoundRenderer({ urls });

const resolveTenantStub: ResolveTenant = async (handle) => (handle === HANDLE ? TENANT_ID : null);

async function resolveLinkStub(tenantId: string, slug: string): Promise<CachedLink | null> {
  if (slug === KNOWN_SLUG) return { link_id: LINK_ID, tenant_id: tenantId, destination: DESTINATION };
  if (slug === REJECTED_SLUG) return { link_id: LINK_ID, tenant_id: tenantId, destination: REJECTED_DESTINATION };
  if (slug === UNENCODABLE_SLUG) {
    return { link_id: LINK_ID, tenant_id: tenantId, destination: UNENCODABLE_DESTINATION };
  }
  // ARCHIVED_SLUG falls through to here too — resolveLinkFromDb (T2.2.4)
  // returns null for BOTH an unknown slug and an archived one (its own
  // doc comment: "a revoked link must resolve to nothing ... this
  // function does not distinguish the two to its caller"), so there is
  // no separate code path this stub could exercise for "archived" that
  // "unknown" does not already cover.
  return null;
}

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface TestServer {
  readonly port: number;
  readonly addCalls: number;
  close(): Promise<void>;
}

interface ServerOverrides {
  readonly resolveTenant?: ResolveTenant;
  readonly resolveLink?: (tenantId: string, slug: string) => Promise<CachedLink | null>;
  readonly logger?: RedirectMiddlewareLogger;
}

function buildServer(overrides: ServerOverrides = {}): Promise<TestServer> {
  let addCalls = 0;

  const app = express();
  const parseRequestTarget = makeRequestTargetParser({
    urls,
    reservedHandles: resolveReservedHandles(),
  });

  const queue: EnqueueQueue = {
    add: () => {
      addCalls += 1;
      return Promise.resolve('job-id');
    },
  };
  const droppedCounter = createEnqueueDroppedCounter(new Registry());
  const enqueueCapture = createEnqueueCapture({ queue, droppedCounter });

  app.use(
    createRedirectMiddleware({
      parseRequestTarget,
      logger: overrides.logger ?? consoleErrorLogger,
      handleRootHitsCounter: createHandleRootHitsCounter(new Registry()),
      openRedirectRejectedCounter: createOpenRedirectRejectedCounter(new Registry()),
      resolveTenant: overrides.resolveTenant ?? resolveTenantStub,
      resolveLink: overrides.resolveLink ?? resolveLinkStub,
      lookupNetwork: () => ({ asn: null, country: null }),
      getDailySalt: async () => 'not-found-routing-test-salt-not-a-real-secret',
      enqueueCapture,
      renderNotFound,
    }),
  );

  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
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

function requestPath(port: number, host: string, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const openServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

// [S2.5 fan-out review, MEDIUM, defence in depth] The two hardening
// headers every terminal 404 must carry, asserted here as literals rather
// than imported from middleware.ts on purpose: importing the constant
// under test would make this assertion tautological — it would keep
// passing if someone widened the policy to `default-src *`, which is
// exactly the regression worth catching.
//
// `default-src 'none'` costs this document nothing functionally:
// not-found.ts's own T2.5.2 invariant is that it has ZERO external
// dependencies by design (no script, style, image, font or fetch of any
// kind, enforced by that file's own src/href-parsing test). The CSP is
// therefore pure backstop should the escaper (T2.5.1) or the template
// (T2.5.2) ever regress. `style-src 'unsafe-inline'` is the single
// exception, matching the template's own one `<style>` block —
// tightening it to a nonce or hash would require per-request template
// generation, which not-found.ts's header comment explicitly rules out.
const EXPECTED_NOT_FOUND_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** Every 404 assertion in this file shares this shape: status, all four
 * headers, the exact rendered body for the value this task decided that
 * branch reflects, and — checked PER branch, never in aggregate, per the
 * dispatch's own instruction — that queue.add() was never called. A fixed
 * 50ms grace period (mirroring ordering.test.ts's identical "a 404 path
 * enqueues nothing at all" case) gives a wrongly-added fire-and-forget
 * continuation a moment it would need if one were ever mistakenly wired
 * to one of these branches, before asserting it never ran.
 *
 * [S2.5 fan-out review] The CSP and nosniff assertions live in this
 * SHARED helper, not in one representative test, for the same reason
 * sendNotFound is a single chokepoint in middleware.ts: a header set on
 * eight branches and forgotten on the ninth is precisely the failure this
 * shape exists to make impossible. Every branch below proves it
 * independently. */
async function expectBrandedNotFound(
  server: TestServer,
  host: string,
  path: string,
  expectedSlug: string,
): Promise<void> {
  const response = await requestPath(server.port, host, path);

  expect(response.status).toBe(404);
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-security-policy']).toBe(EXPECTED_NOT_FOUND_CSP);
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.body).toBe(renderNotFound(expectedSlug));

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(server.addCalls).toBe(0);
}

describe('the 404 branches named by T2.5.3\'s own brief', () => {
  it('unknown handle: a syntactically valid handle no tenant owns', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `ghost.${DOMAIN}`, `/${KNOWN_SLUG}`, KNOWN_SLUG);
  });

  it('unknown slug: a valid handle, a slug that never resolved', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, '/does-not-exist', 'does-not-exist');
  });

  it('archived link: same branch as unknown slug (resolveLinkFromDb collapses both to null by design)', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, `/${ARCHIVED_SLUG}`, ARCHIVED_SLUG);
  });

  it('reserved path: /favicon.ico never reaches a lookup', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, '/favicon.ico', 'favicon.ico');
  });

  it('handle-root: "/" on a handle host shows no slug at all', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, '/', '');
  });

  it('rejected destination: the read-time open-redirect guard refuses to redirect', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, `/${REJECTED_SLUG}`, REJECTED_SLUG);
  });
});

describe('additional terminal branches this task also wires (not named by the brief\'s six)', () => {
  it('reserved handle: a host segment nobody can ever claim', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `www.${DOMAIN}`, '/anything', '');
  });

  it('invalid path: a path that could never be a slug (uppercase)', async () => {
    const server = await buildServer();
    openServers.push(server);

    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, '/PROMO', 'PROMO');
  });

  it('a caught Postgres failure during resolution still gets the branded body', async () => {
    const server = await buildServer({
      resolveTenant: async () => {
        throw new Error('connect ECONNREFUSED postgresql://posta:s3cret@db:5432/posta');
      },
    });
    openServers.push(server);

    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, `/${KNOWN_SLUG}`, KNOWN_SLUG);
  });
});

describe('the hardening headers are scoped to the 404, never the hot path', () => {
  // [S2.5 fan-out review] The negative half of the decision above, tested
  // rather than only commented. A 307 has no body for a CSP to constrain
  // and a `Location`-only response has no content type to sniff, so both
  // headers would be pure per-click overhead on the ONE path that runs on
  // every single redirect — INV-2's "the redirect route is lean". Without
  // this test, a later "set security headers globally" refactor (helmet,
  // or a blanket app.use) would silently land them on the hot path and
  // nothing would object.
  it('a successful 307 carries neither the CSP nor nosniff', async () => {
    const server = await buildServer();
    openServers.push(server);

    const response = await requestPath(server.port, `${HANDLE}.${DOMAIN}`, `/${KNOWN_SLUG}`);

    expect(response.status).toBe(307);
    expect(response.headers.location).toBe(DESTINATION);
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBeUndefined();
  });
});

describe('the formerly-unwired seventh branch (T2.5.3 fix round 1) — no case is unbranded anymore', () => {
  it('an unencodable destination now gets the SAME branded body every other branch uses', async () => {
    const server = await buildServer();
    openServers.push(server);

    // sendLinkRedirect (./redirect-response.ts) now returns `false` for
    // this destination instead of ending the response itself, so
    // handleLinkTarget's own sendNotFound call produces the identical
    // document, headers and status every other terminal branch in this
    // file already gets — asserted with the SAME shared helper, not a
    // one-off inline check, specifically so this case cannot drift from
    // the others again.
    await expectBrandedNotFound(server, `${HANDLE}.${DOMAIN}`, `/${UNENCODABLE_SLUG}`, UNENCODABLE_SLUG);
  });
});
