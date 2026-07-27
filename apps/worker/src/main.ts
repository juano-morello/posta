import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { formatEnvFailures, loadEnv } from '@posta/contracts';
import { AppModule } from './app.module';
import { workerEnvSchema } from './env';

// T0.3.8 — fail fast on invalid env (S0.3). Same contract as the API's
// main.ts: validate process.env against workerEnvSchema before anything
// else runs, print every missing/invalid key (never a value) on
// failure, and exit non-zero.
const envResult = loadEnv(workerEnvSchema, process.env);
if (!envResult.ok) {
  console.error(formatEnvFailures(envResult.failures));
  process.exit(1);
}
const env = envResult.data;

async function bootstrap(): Promise<void> {
  // T3.1.2 [E3, S3.1] — AppModule.forRoot() wires the BullMQ root
  // connection (BullModule.forRoot, app.module.ts) from env.REDIS_URL,
  // already validated above. See app.module.ts's own header for why this
  // is a DynamicModule factory rather than a bare `@Module({})`: the
  // module needs the already-validated REDIS_URL passed in, not a second
  // read of process.env.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({ redisUrl: env.REDIS_URL }),
  );

  // The worker is a BullMQ consumer with no routed API of its own — this
  // is the only endpoint it serves, so Kubernetes can probe liveness
  // without the consumer needing a real router.
  app.use('/health', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  // T0.7.8 (revised in review) — SIGTERM-clean shutdown, scoped to
  // SIGTERM only. See apps/api/src/main.ts for the full rationale; same
  // contract here. In short: an unscoped `enableShutdownHooks()` listens
  // for EVERY ShutdownSignal Nest defines, including real crash signals
  // (SIGSEGV/SIGBUS/SIGFPE/SIGILL) — a Nest anti-pattern, since an async
  // graceful drain from a crash-signal handler runs in an undefined
  // process state. It also used to run ALONGSIDE a hand-rolled
  // `process.on('SIGTERM', () => app.close())`, which double-ran the
  // exact same onModuleDestroy -> beforeApplicationShutdown ->
  // onApplicationShutdown chain per SIGTERM (enableShutdownHooks installs
  // its own internal listener that does exactly what app.close() does).
  // Inert with zero lifecycle-hook providers today, but a real bug once
  // E1/E3 add a BullMQ consumer or Postgres/Redis provider with its own
  // onModuleDestroy().
  //
  // `useProcessExit: true` makes Nest call `process.exit(0)` itself once
  // the chain completes. Nest's own internal listener already guards
  // against a second SIGTERM re-entering mid-drain, and already logs and
  // exits 1 if any shutdown hook throws — no hand-rolled equivalent
  // belongs here.
  //
  // Extension point for E1/E3: the BullMQ consumer's "stop accepting new
  // jobs, finish the in-flight one" and the Postgres/Redis pool teardown
  // land in a provider's `onModuleDestroy()` — Nest's callDestroyHook()
  // walks every provider automatically, so this file needs no further
  // changes when that lands.
  app.enableShutdownHooks(['SIGTERM'], { useProcessExit: true });

  await app.listen(env.WORKER_PORT);
}

bootstrap().catch((error: unknown) => {
  // See apps/api/src/main.ts: the bare `void bootstrap();` this replaces
  // left a rejected bootstrap() as an unhandled rejection instead of a
  // clean, logged, non-zero exit. The exit is in `finally` so a
  // console.error that itself throws can't suppress it.
  try {
    console.error('Fatal error during bootstrap:', error);
  } finally {
    process.exit(1);
  }
});
