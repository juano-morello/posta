import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

// T3.1.2 [E3, S3.1] — establishes the worker's BullMQ ROOT CONNECTION so
// T3.1.3 (the consumer, a `@Processor`/`WorkerHost` class with tuned
// concurrency) has something to attach to. This task adds no queue and
// no processor — `BullModule.registerQueue()`/`@Processor` are T3.1.3's
// job, not this one. "Root connection, no consumer yet" is deliberate:
// see this file's own header below for why the connection seam is
// established here rather than deferred alongside the consumer.
//
// TWO ESTABLISHED PRECEDENTS, one judgment call:
//   1. apps/api's main.ts builds its BullMQ producer
//      (createEventsQueue(env.REDIS_URL), apps/api/src/redirect/enqueue.ts)
//      entirely OUTSIDE Nest's DI, by hand in bootstrap() — AppModule
//      there stays `@Module({})`. That is deliberate for the redirect hot
//      path [INV-2]: "the redirect route is lean... Nest's structure
//      earns its keep on CRUD, not here."
//   2. `@nestjs/bullmq`'s own idiomatic pattern is `BullModule.forRoot()`
//      in `AppModule.imports`, which is how a later `@Processor`
//      (T3.1.3) attaches to a Worker via DI — `BullExplorer`
//      (`@nestjs/bullmq`) discovers `@Processor`-decorated classes at
//      module-init time and wires them to whatever `BullModule.forRoot()`
//      configured, with no manual `new Worker(...)` anywhere.
// The worker is NOT the hot path — it is a background batch consumer,
// closer to a "CRUD-shaped" service where Nest's DI earns its keep, and
// T3.1.3's consumer needs exactly the seam `@nestjs/bullmq` provides
// (`@Processor extends WorkerHost`, discovered via DI). So: pattern 2,
// here, deliberately different from api's pattern 1 — the two processes
// have different hot-path constraints, not an inconsistency to "fix".
//
// `AppModule.forRoot(config)` (a DynamicModule factory), not a bare
// `@Module({})` reading `process.env` internally, because env.REDIS_URL
// is validated ONCE in main.ts (workerEnvSchema, T0.3.6) — this module
// must receive that already-validated value as a parameter rather than
// re-reading `process.env.REDIS_URL` itself, which is exactly what the
// "config from env only, read in exactly one place" invariant forbids a
// second copy of.
export interface AppModuleConfig {
  /** Already validated by workerEnvSchema (env.ts) — main.ts's
   * `env.REDIS_URL`, passed through, never re-read from process.env
   * here. */
  readonly redisUrl: string;
}

@Module({})
export class AppModule {
  static forRoot(config: AppModuleConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        BullModule.forRoot({
          connection: {
            url: config.redisUrl,
            // BullMQ's own documented requirement for a connection a
            // Worker attaches to — unlike a producer-only Queue
            // (createEventsQueue's `hasBlockingConnection === false`,
            // packages/core/src/queue/events-queue.ts /
            // apps/api/src/redirect/enqueue.ts), a Worker's connection
            // IS a blocking connection type, and BullMQ's own connection
            // layer enforces this itself if it is left unset. T3.1.3's
            // `@Processor`/`WorkerHost` will attach to THIS connection,
            // so the requirement is load-bearing here, not defensive
            // boilerplate copied from the producer side.
            maxRetriesPerRequest: null,
          },
        }),
      ],
    };
  }
}
