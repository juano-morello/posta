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

  await app.listen(env.API_PORT);
}

void bootstrap();
