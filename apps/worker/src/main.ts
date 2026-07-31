import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  //
  // [T3.1.6] databaseUrl/batchSize/batchIntervalMs/shutdownTimeoutMs are
  // the SAME "validate once here, pass down" discipline as redisUrl —
  // env.DATABASE_URL_WORKER (the writer role), env.EVENT_BATCH_SIZE/
  // env.EVENT_BATCH_INTERVAL_MS (S3.3's batching knobs), and
  // env.SHUTDOWN_TIMEOUT_MS (this task) are each read from process.env
  // exactly once, right here, and nowhere deeper in the app. `dbPoolMax`
  // and every `AppModuleConfig` override (`flush`/`eventSink`/`logger`/
  // `shutdownLogger`) are deliberately left unset — production relies on
  // `createDbClient`'s own `DB_POOL_MAX` env fallback and every other
  // component's real default (app.module.ts's own header explains each).
  //
  // [T3.4.4] r2Endpoint/r2AccessKeyId/r2SecretAccessKey/r2Bucket — the
  // SAME "validate once, pass down" discipline, extended to the four
  // R2_* vars workerEnvSchema already validates (env.ts, T0.3.6).
  // app.module.ts's own `buildProductionFlush` is what actually
  // constructs `createR2Client()` from these; this file's only job is
  // handing down the already-validated values, never re-reading
  // `process.env` itself.
  //
  // [T3.7.5] r2AccountId — the same discipline, extended to
  // env.R2_ACCOUNT_ID, which workerEnvSchema now validates as OPTIONAL
  // (may be `undefined`, unlike the other four R2_* vars above): its own
  // `.superRefine` guarantees at least one of R2_ENDPOINT / R2_ACCOUNT_ID
  // is non-empty, not that this one specifically is set. createR2Client
  // (packages/core/src/r2/client.ts, T3.7.4) reads it only to derive
  // R2_ENDPOINT when that var is left empty — production's own shape.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot({
      redisUrl: env.REDIS_URL,
      databaseUrl: env.DATABASE_URL_WORKER,
      batchSize: env.EVENT_BATCH_SIZE,
      batchIntervalMs: env.EVENT_BATCH_INTERVAL_MS,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      r2Endpoint: env.R2_ENDPOINT,
      r2AccessKeyId: env.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY,
      r2Bucket: env.R2_BUCKET_EVENTS,
      r2AccountId: env.R2_ACCOUNT_ID,
    }),
  );

  // [T3.1.7] `GET /health` is now served by the real `HealthController`
  // (health.controller.ts), registered through `AppModule.forRoot()`
  // above — it reports queue depth, DLQ depth, and flush staleness
  // instead of this file's former hand-rolled `app.use('/health', ...)`
  // middleware, which always answered `200 ok` regardless of actual
  // worker health. See that file's own header for the full rationale.

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
