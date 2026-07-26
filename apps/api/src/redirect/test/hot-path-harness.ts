import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Queue } from 'bullmq';
import express from 'express';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { Registry } from 'prom-client';
import { makeUrlBuilders, resolveReservedHandles, zCsvList } from '@posta/contracts';
import type { CaptureEvent } from '@posta/contracts';
import { bioPages, newId, createDailySalt, type DbClient } from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
} from '@posta/core/testing';
import { AppModule } from '../../app.module';
import { createEnqueueCapture, createEnqueueDroppedCounter, createEventsQueue } from '../enqueue';
import { makeRequestTargetParser } from '../host';
import {
  createHandleRootHitsCounter,
  createOpenRedirectRejectedCounter,
  createRedirectMiddleware,
} from '../middleware';
import { makeNotFoundRenderer } from '../not-found';
import { resolveLink } from '../resolve-link';
import { seedLink, seedTenant } from '../resolve-test-support';
import { createResolveTenant } from '../resolve-tenant';

// T2.6.1 — the FOUNDATION harness for S2.6, "the invariant suite". Every
// other S2.6 test (T2.6.2-T2.6.9) reuses THIS ONE factory rather than
// each booting its own Postgres+Redis+app stack: extends the
// testcontainers Postgres harness (T1.1.2, packages/core/src/test/
// pg-container.ts) with the sibling Redis 7 harness (T2.2.7,
// redis-container.ts), boots the REAL redirect hot path — the actual
// production composition main.ts wires (createResolveTenant, resolveLink,
// createDailySalt, createEventsQueue, createRedirectMiddleware — the
// SAME functions, not a reimplementation of them) — on an ephemeral port,
// wrapped in a real Nest application exactly like main.ts's own
// ExpressAdapter/NestFactory sequence, and seeds one tenant + handle +
// link.
//
// Deliberately NOT `main.ts` itself, reused as a module: that file
// validates `process.env` against `apiEnvSchema` and calls
// `process.exit(1)` at MODULE-LOAD time (before any function in it ever
// runs), and its own `bootstrap()` hardcodes `app.listen(env.API_PORT)` —
// a fixed port `zPort` itself refuses to be `0`. Importing it directly
// would risk killing the whole vitest worker on any env mismatch, and
// could never satisfy this task's own "ephemeral port" requirement. This
// file instead calls the SAME boot-time factories main.ts calls, wired to
// this harness's own containers and an `app.listen(0)`.
//
// lookupNetwork is the one dependency NOT wired to something real: the
// GeoIP mmdb files (`data/geoip/*.mmdb`) are `git`-ignored (fetched by
// `pnpm geo:fetch`, S0.7's decision log), not guaranteed present in every
// environment this harness runs in. Wiring the real reader would make
// every S2.6 test's own pass/fail depend on an optional local asset —
// exactly the fragility open-redirect.test.ts and not-found-routing.test.ts
// already avoid by stubbing this same dependency. Every OTHER dependency
// here is real: real Postgres, real Redis, the real cache/tombstone
// ladders, a real daily salt, and a real BullMQ producer.
//
// Env: every config knob the redirect composition below actually reads
// is set on `process.env` first and read back through it (see `setEnv`),
// mirroring CLAUDE.md's "config comes only from env" for the pieces that
// matter here — DATABASE_URL/REDIS_URL genuinely point at the two
// containers this factory just started. `API_PORT` is the one deliberate
// exception: this harness calls `app.listen(0)` directly rather than
// threading a port through env, which `zPort` (packages/contracts/src/env.ts)
// would refuse for the literal `'0'` an ephemeral port needs.

/** A non-production test domain — 'example.test' is the SAME literal
 * every other integration test file in this directory already uses
 * (open-redirect.test.ts, not-found-routing.test.ts, resolve-tenant.test.ts),
 * and is not one of the two brand domains tests/conventions/no-literal-domain.test.ts
 * forbids repo-wide. */
export const HARNESS_DOMAIN = 'example.test';
export const HARNESS_HANDLE = 'juano';
export const HARNESS_SLUG = 'promo';
export const HARNESS_DESTINATION = 'https://example.test/dest';

const REDIS_LOOKUP_TIMEOUT_MS = '1000';
const LINK_CACHE_TTL_SECONDS = '3600';
const MAX_INFLIGHT_ENQUEUES = '1000';
const RESERVED_HANDLES = 'app,api,www,admin,static,assets,cdn,mail,blog,docs,status';

/**
 * Builds a `setEnv(name, value)` scoped to ONE harness instance, plus the
 * `restore()` that undoes every override it made. `setEnv` writes
 * `process.env[name]` and returns the SAME value, so every downstream
 * `const` below is provably the value `process.env` actually holds —
 * never a hardcoded literal living a second, separate life next to an env
 * var nothing reads back.
 *
 * [fix round 1] `process.env` is GLOBAL, process-wide state — Vitest's
 * default `isolate: true` resets each test FILE's own module registry,
 * but does not snapshot-and-restore `process.env` between files a worker
 * happens to run one after another. Without `restore()`, this harness's
 * OWN `setEnv('REDIS_URL', ...)` call leaked past this file's own test
 * run and broke tests/infra/redis-policy.test.ts (which reads
 * `process.env.REDIS_URL` once, at module load, specifically to prove it
 * fails loudly when unset) whenever that file happened to load in the
 * same worker afterward — a real, observed cross-file failure, not a
 * hypothetical one. `restore()` (called from `stop()`) puts every
 * overridden key back to its ORIGINAL value (or deletes it, if it was
 * never set), so this harness's env footprint never outlives its own
 * lifecycle.
 */
function createEnvSetter(): { setEnv(name: string, value: string): string; restore(): void } {
  const original = new Map<string, string | undefined>();

  return {
    setEnv(name, value) {
      if (!original.has(name)) original.set(name, process.env[name]);
      process.env[name] = value;
      return value;
    },
    restore() {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

export interface HotPathHarness {
  /** The ephemeral-port URL of the booted app, e.g. `http://127.0.0.1:54231`
   * — a request against the seeded link still needs its own `Host` header
   * (`${HARNESS_HANDLE}.${HARNESS_DOMAIN}`); this is only the connection
   * target. */
  readonly baseUrl: string;
  /** The bare port number `baseUrl` embeds — convenience for a test that
   * wants to assert the port itself is gone after `stop()`, without
   * re-parsing `baseUrl`. */
  readonly port: number;
  /** A live Drizzle client against the seeded Postgres container. */
  readonly db: DbClient['db'];
  /** The raw `pg` Pool underneath `db` — for a test that needs a plain
   * SQL statement `db`'s query builder doesn't cover (mirrors
   * PgContainerHandle's own `pool` field, and open-redirect.test.ts's own
   * `pg.pool.query(...)` use of it). */
  readonly pool: PgContainerHandle['pool'];
  /** A live, already-connected ioredis client against the seeded Redis
   * container — the SAME client the redirect composition's cache/salt
   * tiers read and write. */
  readonly redis: Redis;
  /** The REAL BullMQ `events` queue (enqueue.ts's own createEventsQueue),
   * so a test can read actual job payloads back with `queue.getJobs(...)`,
   * not merely count calls against a stub. */
  readonly queue: Queue<CaptureEvent>;
  /** Every line the redirect composition's own logger recorded, in call
   * order — so a test can assert on logging (e.g. "no IP ever appears
   * here") without wiring its own spy. */
  readonly logs: readonly string[];
  /** The seeded tenant's `user.id` (invariant 9: tenant_id == user_id). */
  readonly tenantId: string;
  /** The seeded link's `links.id`. */
  readonly linkId: string;
  /** Closes the Nest app (releasing the port), the events queue's own
   * dedicated Redis connection, then both containers — see this
   * function's own doc comment below for the exact ordering and why.
   * Idempotent: safe to call more than once. */
  stop(): Promise<void>;
}

/** Structurally satisfies every logger seam the redirect composition
 * needs at once — RedirectMiddlewareLogger#error (middleware.ts),
 * ResolveLogger#warn (resolve-redis.ts), and DailySaltLogger#error
 * (packages/core/src/redis/salt.ts) all just need `.error`/`.warn` with
 * this exact signature. One recording double, one `logs` array, instead
 * of a separate spy per seam that a test would have to merge back
 * together itself (open-redirect.test.ts's own `makeCombinedLogger` does
 * the identical merge, for the identical reason). */
function makeCapturingLogger(): {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  readonly logs: string[];
} {
  const logs: string[] = [];

  function record(level: 'error' | 'warn', message: string, meta?: Record<string, unknown>): void {
    logs.push(meta !== undefined ? `[${level}] ${message} ${JSON.stringify(meta)}` : `[${level}] ${message}`);
  }

  return {
    logs,
    error: (message, meta) => record('error', message, meta),
    warn: (message, meta) => record('warn', message, meta),
  };
}

/** Seeds exactly one tenant (a `user` row, invariant 9), one `bio_pages`
 * row claiming {@link HARNESS_HANDLE}, and one `links` row at
 * {@link HARNESS_SLUG} pointing at {@link HARNESS_DESTINATION} — the "one
 * tenant + handle + link" this task's own brief asks for. Reuses
 * resolve-test-support.ts's `seedTenant`/`seedLink` for the halves it
 * already covers (the `user` row, the `links` row) rather than
 * duplicating either insert; only the `bio_pages` row (the handle->tenant
 * claim resolveTenant's own Postgres tier depends on) is new here, since
 * resolve-test-support.ts's own `seedTenant` deliberately omits it — its
 * existing callers reach the link tier directly, already knowing
 * `tenantId`, and never need a handle to resolve from. */
async function seedHarnessData(
  pg: PgContainerHandle,
): Promise<{ tenantId: string; linkId: string }> {
  const tenantId = await seedTenant(pg);
  await pg.db.insert(bioPages).values({ id: newId(), tenantId, handle: HARNESS_HANDLE });
  const linkId = await seedLink(pg, tenantId, HARNESS_SLUG, HARNESS_DESTINATION);
  return { tenantId, linkId };
}

/**
 * Boots a fresh Postgres + Redis testcontainers pair, seeds one tenant +
 * handle + link, and boots the real redirect hot path — the actual
 * production composition (see this file's own header) — as a real
 * Express+Nest app on an OS-assigned ephemeral port. Callers own the
 * returned handle's lifecycle: always call `stop()` (typically from an
 * `afterAll`), or both containers and the listening port outlive the
 * test run.
 */
export async function startHotPathHarness(): Promise<HotPathHarness> {
  const [pg, redis] = await Promise.all([startPgContainer(), startRedisContainer()]);

  const { tenantId, linkId } = await seedHarnessData(pg);

  const registry = new Registry();
  const logger = makeCapturingLogger();
  const { setEnv, restore: restoreEnv } = createEnvSetter();

  const domain = setEnv('POSTA_LINK_DOMAIN', HARNESS_DOMAIN);
  const appSubdomain = setEnv('POSTA_APP_SUBDOMAIN', 'app');
  const apiSubdomain = setEnv('POSTA_API_SUBDOMAIN', 'api');
  // Parsed the SAME way apiEnvSchema does (zCsvList), then handed to
  // resolveReservedHandles exactly like main.ts's own
  // `resolveReservedHandles(env.POSTA_RESERVED_HANDLES)` — this list is
  // already RESERVED_HANDLES' own default set (reserved.ts), so this
  // round trip changes nothing about the RESULT, only proves the env var
  // this harness sets is the one actually driving it, not a second,
  // unread copy sitting next to it.
  const reservedHandles = zCsvList.parse(setEnv('POSTA_RESERVED_HANDLES', RESERVED_HANDLES));
  setEnv('DATABASE_URL', pg.url);
  setEnv('REDIS_URL', redis.url);
  const timeoutMs = Number(setEnv('REDIS_LOOKUP_TIMEOUT_MS', REDIS_LOOKUP_TIMEOUT_MS));
  const cacheTtlSeconds = Number(setEnv('LINK_CACHE_TTL_SECONDS', LINK_CACHE_TTL_SECONDS));
  const maxInflight = Number(setEnv('MAX_INFLIGHT_ENQUEUES', MAX_INFLIGHT_ENQUEUES));

  const urls = makeUrlBuilders({ domain, protocol: 'http', appSubdomain, apiSubdomain });
  const parseRequestTarget = makeRequestTargetParser({
    urls,
    reservedHandles: resolveReservedHandles(reservedHandles),
  });
  const renderNotFound = makeNotFoundRenderer({ urls });

  const resolveTenant = createResolveTenant({ db: pg.db, redis: redis.client, logger, timeoutMs });
  const resolveLinkForRedirect = (tenant: string, slug: string) =>
    resolveLink(tenant, slug, { db: pg.db, redis: redis.client, logger, timeoutMs, cacheTtlSeconds });
  // See this file's own header for why this is a stub, not
  // createNetworkLookup(openGeoDatabases(...)) — the real reader depends
  // on a git-ignored, fetched-on-demand asset this harness must not
  // require just to boot.
  const lookupNetwork = () => ({ asn: null, country: null });
  const getDailySalt = createDailySalt({ redis: redis.client, logger });

  const eventsQueue = createEventsQueue(redis.url);
  const enqueueDroppedCounter = createEnqueueDroppedCounter(registry);
  const enqueueCapture = createEnqueueCapture({ queue: eventsQueue, droppedCounter: enqueueDroppedCounter, maxInflight });

  const server = express();
  server.use(
    createRedirectMiddleware({
      parseRequestTarget,
      logger,
      handleRootHitsCounter: createHandleRootHitsCounter(registry),
      resolveTenant,
      resolveLink: resolveLinkForRedirect,
      lookupNetwork,
      getDailySalt,
      enqueueCapture,
      openRedirectRejectedCounter: createOpenRedirectRejectedCounter(registry),
      renderNotFound,
    }),
  );

  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(server), {
    logger: false,
  });
  // Mirrors main.ts's own health route, mounted the same way (directly on
  // the Nest-wrapped adapter, ahead of Nest's own router).
  app.use('/health', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  await app.listen(0);
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let stopped = false;
  /**
   * Closes, in order: the Nest app (releases the ephemeral port), THEN
   * the events queue's own dedicated Redis connection (enqueue.ts's
   * createEventsQueue never shares `redis.client`'s connection — see that
   * file's own header), THEN both containers — and finally, unconditionally
   * (even if any step above threw), this harness's own env overrides via
   * {@link createEnvSetter}'s `restore()`. That order matters: closing the
   * queue's connection AFTER the container that backs it is already
   * stopped would have nothing left to gracefully close against.
   * Idempotent via the `stopped` guard — pg's own `pool.end()` and
   * ioredis's `quit()` both throw if called a second time, which would
   * otherwise make a second `stop()` call (this task's own idempotency
   * requirement) fail instead of being a harmless no-op.
   */
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    try {
      await app.close();
      await eventsQueue.close();
      await Promise.all([pg.stop(), redis.stop()]);
    } finally {
      restoreEnv();
    }
  }

  return {
    baseUrl,
    port,
    db: pg.db,
    pool: pg.pool,
    redis: redis.client,
    queue: eventsQueue,
    logs: logger.logs,
    tenantId,
    linkId,
    stop,
  };
}
