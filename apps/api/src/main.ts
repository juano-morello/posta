import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { formatEnvFailures, loadEnv } from '@posta/contracts';
import { AppModule } from './app.module';
import { apiEnvSchema } from './env';

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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Mounted directly on the underlying HTTP adapter, ahead of the Nest
  // router. The redirect middleware E2 adds will mount the same way, so
  // the hot path never pays for Nest's controller/DI ceremony — this
  // health route is the first thing to use that pattern.
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
