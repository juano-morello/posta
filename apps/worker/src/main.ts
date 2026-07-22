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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // The worker is a BullMQ consumer with no routed API of its own — this
  // is the only endpoint it serves, so Kubernetes can probe liveness
  // without the consumer needing a real router.
  app.use('/health', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  // T0.7.8 — SIGTERM-clean shutdown. See apps/api/src/main.ts for the
  // fuller rationale; same contract here. enableShutdownHooks() wires
  // Nest's termination lifecycle for whatever providers this app gains
  // later (there are no BullMQ consumers or Postgres/Redis pools yet in
  // E0 — E1/E3 add them).
  app.enableShutdownHooks();

  // Explicit SIGTERM handling because Node as PID 1 gets none by
  // default — without this, a rolling deploy would let Kubernetes'
  // SIGKILL fallback do the killing instead of the process draining and
  // exiting on its own. app.close() is also where the BullMQ consumer's
  // "stop accepting new jobs, finish the in-flight one" and the
  // Postgres/Redis pool teardown land once those exist (E1/E3) — this is
  // the extension point, not a placeholder that gets rewritten.
  process.on('SIGTERM', () => {
    void (async () => {
      await app.close();
      process.exit(0);
    })();
  });

  await app.listen(env.WORKER_PORT);
}

bootstrap().catch((error: unknown) => {
  // T0.7.8 — see apps/api/src/main.ts: the bare `void bootstrap();` this
  // replaces left a rejected bootstrap() as an unhandled rejection
  // instead of a clean, logged, non-zero exit.
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
