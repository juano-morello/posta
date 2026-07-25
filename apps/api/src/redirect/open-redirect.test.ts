import type { Request, RequestHandler, Response } from 'express';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkKey, newId } from '@posta/core';
import { startPgContainer, startRedisContainer, type PgContainerHandle, type RedisContainerHandle } from '@posta/core/testing';
import { makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import type { EnqueueCapture } from './enqueue';
import { makeRequestTargetParser } from './host';
import {
  createHandleRootHitsCounter,
  createOpenRedirectRejectedCounter,
  createRedirectMiddleware,
  OPEN_REDIRECT_REJECTED_COUNTER_NAME,
  type RedirectMiddlewareLogger,
} from './middleware';
import { resolveLink } from './resolve-link';
import type { ResolveLogger } from './resolve-redis';
import { seedLink, seedTenant, CONTAINER_TEST_TIMEOUT_MS } from './resolve-test-support';
import type { ResolveTenant } from './resolve-tenant';

// T2.4.5 [security] — the read-time open-redirect guard's own integration
// suite, run against REAL Postgres and Redis (startPgContainer /
// startRedisContainer, @posta/core/testing) rather than doubles: "planted
// directly into the store" has to mean an actual second writer, bypassing
// every application-level check this codebase has — a stub standing in
// for either store would prove nothing about whether the guard sits below
// the REAL read path.
//
// [security review context, worth reading before touching either group
// below] The two stores are NOT symmetric threats, and this file's two
// describe blocks are shaped around that asymmetry rather than papering
// over it:
//
//   - The POSTGRES group is what actually exercises the NEW guard.
//     resolveLinkFromDb (resolve-link.ts, T2.2.4) returns a Postgres row
//     by structural cast — never run through CachedLinkSchema/zDestination
//     — so a malicious `destination` column value reaches handleLinkTarget
//     as a real, non-null CachedLink. This is the exact gap T2.4.5 exists
//     to close.
//
//   - The REDIS group proves the wider safety property (no open redirect,
//     regardless of entry point) rather than the guard's own error path.
//     Every `link:{tenant}:{slug}` read already goes through
//     packages/contracts/src/cache.ts's `parseCachedLink` (T2.2.1), which
//     runs the SAME zDestination check and folds a failure into an
//     ordinary cache MISS before resolveLink ever returns a non-null
//     value — verified by hand against this exact build: `javascript:`,
//     `//evil.com`, `data:...` and `/relative` all fail `zDestination`
//     unconditionally (there is no way to construct a schema-valid
//     envelope carrying one of them), so a value planted directly into
//     Redis via the normal JSON envelope categorically cannot reach this
//     guard — resolve-link.test.ts's own "[security] a well-formed but
//     schema-invalid payload" case already proves that failure mode in
//     isolation. Seeding a MATCHING poisoned row into Postgres for the
//     same slug would make these 4 cases "pass", but only by routing
//     through the Postgres tier under test above — deleting the Redis
//     `.set()` call would not change the outcome, which is exactly the
//     "asserts nothing" test shape this epic's own review culture flags.
//     So the Redis group asserts what is actually true here: no open
//     redirect, no destination leaked into ANY log line, and (as a
//     regression trip-wire) exactly one `warn` — not `error` — because
//     the EXISTING T2.2.1 protection, not this task's new guard, is what
//     catches it. If that protection were ever weakened, resolveLink
//     WOULD start returning the poisoned value, and this guard would then
//     be the backstop that catches it — this file's Postgres group is
//     what proves that backstop works.
//
// Two extra Postgres cases beyond the four canonical payloads — an
// oversized destination and an http-prefixed-but-unparseable one — per
// the task brief: both pass the DB's own `links_destination_absolute_url_check`
// CHECK constraint (`~* '^https?://'`, packages/core/src/schema/links.ts)
// and a naive `^https?://` regex, so they are precisely what reusing the
// full `zDestination` object (WHATWG parsing + a length bound), rather
// than a hand-rolled scheme check, buys over the DB constraint alone.
//
// [setup note] The four CANONICAL payloads do NOT themselves satisfy that
// same CHECK constraint (none of them start with `http(s)://`), so a
// normal `INSERT` — even one that skips every APPLICATION-level check —
// still cannot write them: Postgres enforces its own CHECK on every
// write, unconditionally. Reaching them at all requires the constraint
// itself to be gone, which is exactly what "an operator with direct SQL
// access" (this task's own threat model, mirroring "an operator with
// redis-cli" for the cache side) can do. `beforeAll` below drops that
// constraint once, for this file's own disposable container only.

const DOMAIN = 'example.test';
const HANDLE = 'juano';

interface FakeResponse {
  statusCode: number | undefined;
  ended: boolean;
  readonly headers: Record<string, string>;
  set(name: string, value: string): FakeResponse;
  status(code: number): FakeResponse;
  end(): FakeResponse;
}

function makeRes(): FakeResponse {
  const headers: Record<string, string> = {};
  const res: FakeResponse = {
    statusCode: undefined,
    ended: false,
    headers,
    set(name, value) {
      headers[name] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res;
}

/** Dispatches one request through the real middleware and waits for the
 * response to end, INCLUDING one extra macrotask beyond that: the
 * open-redirect guard's own log/counter side effects are synchronous
 * (part of the same tick that ends the response), but resolveLink's
 * fire-and-forget cache backfill/tombstone writes (backfillLinkCache /
 * writeLinkTombstone, resolve-link.ts) are NOT — they are already in
 * flight by the time this function returns and settle on a LATER
 * microtask/macrotask. Every assertion below reads `logger.calls` only
 * after this extra flush, so a follow-up warn from either of those never
 * races a test's own assertions. */
async function dispatch(
  middleware: RequestHandler,
  path: string,
): Promise<FakeResponse> {
  const req = { headers: { host: `${HANDLE}.${DOMAIN}` }, path } as unknown as Request;
  const res = makeRes();
  middleware(req, res as unknown as Response, () => {
    throw new Error('dispatch: next() should never be called for a link target');
  });

  const deadline = Date.now() + 5000;
  while (!res.ended) {
    if (Date.now() > deadline) throw new Error('dispatch: response never ended');
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Let any fire-and-forget follow-up (backfillLinkCache, writeLinkTombstone)
  // settle before the caller inspects logger.calls — see this function's
  // own doc comment.
  await new Promise((resolve) => setImmediate(resolve));

  return res;
}

interface LogCall {
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

/** A single spy satisfying BOTH RedirectMiddlewareLogger (`.error`, used
 * by the guard itself) and ResolveLogger (`.warn`, used by resolveLink's
 * own Redis-side validation) — recording every call from either into one
 * timeline, so "the destination never appears in anything this request
 * logged" can be asserted across BOTH layers with a single check, not two
 * separately-trusted ones. */
function makeCombinedLogger(): RedirectMiddlewareLogger & ResolveLogger & { readonly calls: LogCall[] } {
  const calls: LogCall[] = [];
  return {
    calls,
    error(message, meta) {
      calls.push(meta !== undefined ? { level: 'error', message, meta } : { level: 'error', message });
    },
    warn(message, meta) {
      calls.push(meta !== undefined ? { level: 'warn', message, meta } : { level: 'warn', message });
    },
  };
}

async function getCounterValue(registry: Registry, name: string): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((entry) => entry.name === name);
  return metric?.values[0]?.value ?? 0;
}

const CANONICAL_PAYLOADS: ReadonlyArray<{ readonly label: string; readonly destination: string }> = [
  { label: 'javascript', destination: 'javascript:alert(1)' },
  { label: 'protocol-relative', destination: '//evil.com' },
  { label: 'data', destination: 'data:text/html,x' },
  { label: 'relative', destination: '/relative' },
];

// Both pass the DB's own CHECK constraint and a naive `^https?://` regex —
// see this file's own header for why that is precisely the point.
const OVERLONG_DESTINATION = `https://example.test/${'x'.repeat(2100)}`; // > zDestination's 2048-char bound
const UNPARSEABLE_DESTINATION = 'https://[invalid'; // http-prefixed, fails WHATWG URL parsing

describe('open-redirect guard (T2.4.5) [security]', () => {
  let pg: PgContainerHandle;
  let redis: RedisContainerHandle;
  let tenantId: string;
  let registry: Registry;
  let logger: RedirectMiddlewareLogger & ResolveLogger & { calls: LogCall[] };
  let enqueueCalls: number;
  let middleware: RequestHandler;

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPgContainer(), startRedisContainer()]);

    // Drop the write-time CHECK constraint on THIS disposable container
    // only — see the file header for why the four canonical payloads
    // cannot be seeded at all while it stands, and why removing it here
    // is an honest stand-in for "an operator with direct SQL access",
    // this task's own stated threat model.
    await pg.pool.query('ALTER TABLE links DROP CONSTRAINT links_destination_absolute_url_check');

    tenantId = await seedTenant(pg);

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
    const resolveTenantStub: ResolveTenant = async (handle) => (handle === HANDLE ? tenantId : null);

    registry = new Registry();
    logger = makeCombinedLogger();

    const enqueueCapture: EnqueueCapture = async () => {
      enqueueCalls += 1;
    };

    middleware = createRedirectMiddleware({
      parseRequestTarget,
      logger,
      handleRootHitsCounter: createHandleRootHitsCounter(registry),
      openRedirectRejectedCounter: createOpenRedirectRejectedCounter(registry),
      resolveTenant: resolveTenantStub,
      // The REAL production composition (resolve-link.ts), wired to the
      // REAL containers above — never a stub. This is the exact closure
      // shape main.ts builds (resolveLinkForRedirect) over its own boot
      // deps.
      resolveLink: (tenant, slug) =>
        resolveLink(tenant, slug, {
          db: pg.db,
          redis: redis.client,
          logger,
          timeoutMs: 1_000,
          cacheTtlSeconds: 3600,
        }),
      lookupNetwork: () => ({ asn: null, country: null }),
      getDailySalt: async () => 'open-redirect-test-salt-not-a-real-secret',
      enqueueCapture,
    });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  }, CONTAINER_TEST_TIMEOUT_MS);

  beforeEach(() => {
    enqueueCalls = 0;
  });

  describe('a destination planted directly into Postgres (the gap this task closes)', () => {
    it.each([
      ...CANONICAL_PAYLOADS,
      { label: 'overlong', destination: OVERLONG_DESTINATION },
      { label: 'http-prefixed-but-unparseable', destination: UNPARSEABLE_DESTINATION },
    ])('rejects a $label destination: 404, no Location, one error log, no leak, no enqueue', async ({ destination }) => {
      const slug = `pg-${newId()}`.toLowerCase();
      const linkId = await seedLink(pg, tenantId, slug, destination);

      const callsBefore = logger.calls.length;
      const counterBefore = await getCounterValue(registry, OPEN_REDIRECT_REJECTED_COUNTER_NAME);

      const res = await dispatch(middleware, `/${slug}`);

      expect(res.statusCode).toBe(404);
      expect(res.headers['Location']).toBeUndefined();
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(enqueueCalls).toBe(0);

      const callsForThisRequest = logger.calls.slice(callsBefore);
      const errorCalls = callsForThisRequest.filter((call) => call.level === 'error');
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0]?.meta).toMatchObject({ linkId });
      expect(errorCalls[0]?.meta?.['rejectedScheme']).toBeDefined();

      // [security] The rejected destination itself never appears in
      // anything this request logged — not in the guard's own error line,
      // and not in the fire-and-forget cache-backfill warn that also
      // fires for a Postgres-sourced hit (backfillLinkCache, resolve-link.ts).
      expect(JSON.stringify(callsForThisRequest)).not.toContain(destination);

      expect(await getCounterValue(registry, OPEN_REDIRECT_REJECTED_COUNTER_NAME)).toBe(counterBefore + 1);
    });
  });

  describe('a destination planted directly into Redis (already closed by T2.2.1 — see file header)', () => {
    it.each(CANONICAL_PAYLOADS)(
      'a $label destination never reaches res.redirect: 404, no Location, no leak, no enqueue',
      async ({ destination }) => {
        const slug = `redis-${newId()}`.toLowerCase();
        // Written DIRECTLY via the raw client — never through
        // backfillLinkCache's own CachedLinkSchema.parse — the literal
        // "second writer with redis-cli" this task's brief describes. No
        // matching Postgres row exists for this slug: this group is
        // testing what Redis poisoning ALONE does, not a combined attack.
        await redis.client.set(
          linkKey(tenantId, slug),
          JSON.stringify({ link_id: newId(), tenant_id: tenantId, destination }),
        );

        const callsBefore = logger.calls.length;

        const res = await dispatch(middleware, `/${slug}`);

        expect(res.statusCode).toBe(404);
        expect(res.headers['Location']).toBeUndefined();
        expect(res.headers['Cache-Control']).toBe('no-store');
        expect(enqueueCalls).toBe(0);

        const callsForThisRequest = logger.calls.slice(callsBefore);
        // [security] The core property: regardless of WHICH layer caught
        // it, the destination never appears in anything logged.
        expect(JSON.stringify(callsForThisRequest)).not.toContain(destination);

        // Regression trip-wire, not the guard's own behavior: exactly one
        // WARN (lookupCachedLink's own "failed to parse" log,
        // resolve-link.ts) and ZERO errors. If T2.2.1's own Redis-read
        // validation were ever weakened, resolveLink would start
        // returning this poisoned value as a genuine hit instead of a
        // parse failure — at which point THIS guard (T2.4.5) would be the
        // one to catch it, and this assertion is what would go red first:
        // zero warns, one error, exactly the Postgres group's own shape
        // above.
        const warnCalls = callsForThisRequest.filter((call) => call.level === 'warn');
        const errorCalls = callsForThisRequest.filter((call) => call.level === 'error');
        expect(warnCalls).toHaveLength(1);
        expect(errorCalls).toHaveLength(0);
      },
    );
  });
});
