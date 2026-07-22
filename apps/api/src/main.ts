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

  // T0.7.8 — SIGTERM-clean shutdown. Wires Nest's own termination
  // lifecycle (onModuleDestroy -> beforeApplicationShutdown ->
  // onApplicationShutdown on every provider); there are no providers with
  // state to close yet in E0 (no Postgres/Redis pools exist until
  // E1/E3), but every one this app gains later just needs its own
  // lifecycle hook, not a change here.
  app.enableShutdownHooks();

  // Node running as PID 1 (every one of these containers, no init
  // system) does not get default OS signal handling — without an
  // explicit listener, SIGTERM is simply ignored and Kubernetes' rolling
  // deploys kill in-flight redirects at the full 30s grace-period
  // timeout instead of the process exiting the moment it's actually
  // done draining. app.close() stops the HTTP server from accepting new
  // connections and lets in-flight ones finish (and reruns the
  // lifecycle hooks above, harmlessly, if enableShutdownHooks's own
  // listener hasn't already); THIS is also the extension point E1/E3
  // will fill in with `await pgPool.end()` / `await redis.quit()` once
  // those pools exist.
  process.on('SIGTERM', () => {
    void (async () => {
      await app.close();
      process.exit(0);
    })();
  });

  await app.listen(env.API_PORT);
}

bootstrap().catch((error: unknown) => {
  // T0.7.8 — the bare `void bootstrap();` this replaces printed an
  // unhandled-rejection trace (and, depending on Node's
  // --unhandled-rejections setting, could leave the process hanging
  // instead of exiting) if bootstrap() ever rejected — e.g. API_PORT
  // already in use. Log plainly and exit non-zero instead: a container
  // that fails to bind its port should crash-loop visibly, not sit idle
  // failing every health check silently.
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
