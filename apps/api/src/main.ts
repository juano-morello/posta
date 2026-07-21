import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Mounted directly on the underlying HTTP adapter, ahead of the Nest
  // router. The redirect middleware E2 adds will mount the same way, so
  // the hot path never pays for Nest's controller/DI ceremony — this
  // health route is the first thing to use that pattern.
  app.use('/health', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
