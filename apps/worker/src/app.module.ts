import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EVENTS_DLQ_QUEUE, EVENTS_QUEUE } from '@posta/core';
import {
  consoleErrorLogger,
  EVENT_SINK,
  EVENTS_CONSUMER_LOGGER,
  EventsConsumer,
  NoopEventSink,
  type EventSink,
  type EventsConsumerLogger,
} from './consumer/events.consumer';

// T3.1.2 [E3, S3.1] — establishes the worker's BullMQ ROOT CONNECTION so
// T3.1.3 (the consumer, a `@Processor`/`WorkerHost` class with tuned
// concurrency) has something to attach to. This task adds no queue and
// no processor — `BullModule.registerQueue()`/`@Processor` are T3.1.3's
// job, not this one. "Root connection, no consumer yet" is deliberate:
// see this file's own header below for why the connection seam is
// established here rather than deferred alongside the consumer.
//
// [T3.1.3 update] `BullModule.registerQueue({ name: EVENTS_QUEUE })`,
// `EventsConsumer`, and the `EVENT_SINK` provider now live in THIS
// dynamic module rather than a separate one, so `AppModule.forRoot()`
// stays the single thing main.ts (production) and
// events.consumer.test.ts (a real testcontainers-Redis integration test)
// both boot through — the test proves the actual production wiring,
// never a parallel test-only module. `AppModuleConfig.eventSink` is an
// optional override specifically so that test can substitute an
// observing sink through the same `EVENT_SINK` DI token production uses
// for `NoopEventSink`, without needing `@nestjs/testing` (not a
// dependency of this app) or `overrideProvider`.
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
  /** Overrides the `EVENT_SINK` DI token `EventsConsumer` injects.
   * Defaults to `NoopEventSink` when omitted — production (main.ts)
   * never sets this. events.consumer.test.ts passes its own observing
   * sink here to assert what the consumer actually decoded, against a
   * real testcontainers Redis, with no database involved (T3.3.1 lands
   * the real accumulator sink later). */
  readonly eventSink?: EventSink;
  /** Overrides the `EVENTS_CONSUMER_LOGGER` DI token `EventsConsumer`
   * injects. Defaults to `consoleErrorLogger` when omitted — same
   * override shape as `eventSink` above, for the same reason: a test
   * substitutes a spy through the real production DI wiring rather than
   * a parallel one. */
  readonly logger?: EventsConsumerLogger;
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
        // T3.1.3 — no `connection` override here: leaving it unset means
        // this queue's options fall back to the shared config the
        // `BullModule.forRoot()` import above just registered (globally,
        // by `@nestjs/bullmq`'s own design), so there is exactly one
        // Redis connection definition in this module, not two that could
        // drift apart.
        BullModule.registerQueue({ name: EVENTS_QUEUE }),
        // T3.1.4 — same "no connection override, share BullModule.forRoot()'s
        // config" discipline as EVENTS_QUEUE above. EventsConsumer
        // (./consumer/events.consumer.ts) injects the `Queue` instance
        // this registration produces via `@InjectQueue(EVENTS_DLQ_QUEUE)`
        // to route a job that fails eventJobSchema validation here
        // instead of burning EVENTS_QUEUE's own retry attempts on it. No
        // `@Processor` for this queue yet — draining EVENTS_DLQ_QUEUE is
        // T3.1.5's job, not this one (events-queue.ts's own header).
        BullModule.registerQueue({ name: EVENTS_DLQ_QUEUE }),
      ],
      providers: [
        EventsConsumer,
        { provide: EVENT_SINK, useValue: config.eventSink ?? new NoopEventSink() },
        { provide: EVENTS_CONSUMER_LOGGER, useValue: config.logger ?? consoleErrorLogger },
      ],
    };
  }
}
