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

  await app.listen(env.WORKER_PORT);
}

void bootstrap();
