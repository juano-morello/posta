import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // The worker is a BullMQ consumer with no routed API of its own — this
  // is the only endpoint it serves, so Kubernetes can probe liveness
  // without the consumer needing a real router.
  app.use('/health', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  const port = Number(process.env.WORKER_PORT ?? 3002);
  await app.listen(port);
}

void bootstrap();
