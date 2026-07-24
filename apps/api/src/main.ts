import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { Request, Response } from 'express';
import { formatEnvFailures, loadEnv, makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import { AppModule } from './app.module';
import { apiEnvSchema } from './env';
import { makeRequestTargetParser } from './redirect/host';
import {
  consoleErrorLogger,
  createHandleRootHitsCounter,
  createRedirectMiddleware,
} from './redirect/middleware';

// T0.3.8 — fail fast on invalid env (S0.3). The very first thing this
// process does, before NestFactory.create or anything else: validate
// process.env against apiEnvSchema. On failure, print EVERY missing or
// invalid key at once — never a failing value, even for a secret, see
// loadEnv/formatEnvFailures in @posta/contracts — and exit non-zero.
// Without this, a missing DATABASE_URL would surface later as a mystery
// 500 on first query instead of a named, boot-time failure.
const envResult = loadEnv(apiEnvSchema, process.env);
if (!envResult.ok) {
  console.error(formatEnvFailures(envResult.failures));
  process.exit(1);
}
const env = envResult.data;

async function bootstrap(): Promise<void> {
  // T2.1.4 [INV-2] — the redirect hot path must never pay for Nest's
  // DI/controller ceremony, so it cannot be a Nest middleware/guard: it
  // has to be mounted on the raw Express instance BEFORE Nest's router
  // exists at all. That means construction order is inverted from the
  // pre-E2 version of this file (which let NestFactory.create build its
  // own Express instance internally): build `server` ourselves first,
  // mount the redirect middleware on it, and only THEN hand it to
  // NestFactory.create via ExpressAdapter. Ordering by construction — the
  // redirect middleware physically cannot run after a router that does
  // not exist yet when `server.use()` below executes — rather than by
  // hoping `app.use()` on a Nest-created instance happens to run first.
  //
  // makeUrlBuilders + resolveReservedHandles + makeRequestTargetParser +
  // createHandleRootHitsCounter are each called exactly ONCE, right here,
  // from already-validated env — never inside the returned middleware
  // handler, which is what keeps the hot path free of per-request
  // allocation. No registry override is passed, so the counter registers
  // against prom-client's own default registry (matches
  // createDefaultPartitionRowsGauge's production call in the worker).
  const server = express();

  const urls = makeUrlBuilders({
    domain: env.POSTA_LINK_DOMAIN,
    protocol: env.POSTA_PROTOCOL,
    appSubdomain: env.POSTA_APP_SUBDOMAIN,
    apiSubdomain: env.POSTA_API_SUBDOMAIN,
  });
  const parseRequestTarget = makeRequestTargetParser({
    urls,
    reservedHandles: resolveReservedHandles(env.POSTA_RESERVED_HANDLES),
  });
  const handleRootHitsCounter = createHandleRootHitsCounter();

  server.use(
    createRedirectMiddleware({
      parseRequestTarget,
      logger: consoleErrorLogger,
      handleRootHitsCounter,
    }),
  );

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(server),
  );

  // Mounted directly on the underlying HTTP adapter, ahead of the Nest
  // router. The redirect middleware above mounts the same way, one level
  // lower still (on `server` itself, before Nest ever sees it) — this
  // health route was the first thing to use that pattern; T2.1.4 pushed
  // it one step further.
  app.use('/health', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  // T0.7.8 (revised in review) — SIGTERM-clean shutdown, scoped to
  // SIGTERM only. `enableShutdownHooks()` with NO signals argument (this
  // file's first version) listens for EVERY ShutdownSignal Nest defines —
  // SIGHUP/SIGINT/SIGQUIT/SIGILL/SIGTRAP/SIGABRT/SIGBUS/SIGFPE/SIGSEGV/
  // SIGUSR2/SIGTERM — including several real crash signals. Attempting an
  // async graceful drain from a SIGSEGV/SIGBUS handler is a Nest
  // anti-pattern: the process is already in an undefined state. Scoping
  // to `['SIGTERM']` fixes that.
  //
  // This also replaces a hand-rolled `process.on('SIGTERM', () =>
  // app.close())` this file used to have ALONGSIDE enableShutdownHooks():
  // enableShutdownHooks() itself installs Nest's own internal SIGTERM
  // listener, and that listener already runs app.close()'s exact hook
  // chain (see NestApplicationContext.close() /
  // listenToShutdownSignals() in @nestjs/core — both call
  // callDestroyHook -> callBeforeShutdownHook -> dispose ->
  // callShutdownHook). Having both meant a single SIGTERM ran that chain
  // TWICE, concurrently, via two separate listeners — harmless today with
  // zero providers implementing lifecycle hooks, but once E1/E3 add a
  // Postgres/Redis provider with `onModuleDestroy() { await
  // pgPool.end(); }`, that hook would fire twice per SIGTERM: a second
  // pool.end() on an already-closing pool.
  //
  // `useProcessExit: true` makes Nest call `process.exit(0)` itself once
  // the chain completes, rather than re-sending the signal for the OS's
  // default disposition to terminate the process — explicit beats
  // relying on signal redelivery. Nest's own internal listener already
  // guards against a second SIGTERM re-entering mid-drain, and already
  // logs and calls `process.exit(1)` if any shutdown hook throws (see
  // listenToShutdownSignals' try/catch) — no hand-rolled equivalent of
  // either belongs here.
  //
  // Extension point for E1/E3: a Postgres/Redis provider implementing
  // `onModuleDestroy()` (or `beforeApplicationShutdown()`) is where pool
  // teardown goes. Nest's callDestroyHook() walks every provider
  // automatically, so this file needs no further changes when that lands.
  app.enableShutdownHooks(['SIGTERM'], { useProcessExit: true });

  await app.listen(env.API_PORT);
}

bootstrap().catch((error: unknown) => {
  // The bare `void bootstrap();` this replaces printed an
  // unhandled-rejection trace (and, depending on Node's
  // --unhandled-rejections setting, could leave the process hanging
  // instead of exiting) if bootstrap() ever rejected — e.g. API_PORT
  // already in use. Log plainly and exit non-zero instead: a container
  // that fails to bind its port should crash-loop visibly, not sit idle
  // failing every health check silently. The exit is in `finally` so a
  // console.error that itself throws (e.g. EPIPE on a closed stderr)
  // can't suppress it — the exit must be unconditional.
  try {
    console.error('Fatal error during bootstrap:', error);
  } finally {
    process.exit(1);
  }
});
