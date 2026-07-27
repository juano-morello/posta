import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { createDbClient, EVENTS_DLQ_QUEUE, EVENTS_QUEUE, type DbClient } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';
import { BatchAccumulator, type BatchFlushCallback } from './batch/accumulator';
import { createFlushBatch } from './batch/flush';
import {
  AccumulatingEventSink,
  BATCH_ACCUMULATOR,
  consoleErrorLogger,
  EVENT_SINK,
  EVENTS_CONSUMER_LOGGER,
  EventsConsumer,
  type EventSink,
  type EventsConsumerLogger,
} from './consumer/events.consumer';
import { DlqService } from './consumer/dlq.service';
import {
  consoleErrorLogger as shutdownConsoleErrorLogger,
  SHUTDOWN_LOGGER,
  SHUTDOWN_TIMEOUT_MS,
  ShutdownService,
  type ShutdownLogger,
} from './consumer/shutdown';
import { FLUSH_INTERVAL_MS, HealthController } from './health.controller';

/** The DI token the worker's real Postgres `DbClient` (packages/core's
 * `createDbClient`, T1.1.1) is registered under — internal to this
 * module, not part of `AppModuleConfig`: nothing outside `forRoot()`
 * needs to override or reach past the `BatchAccumulator` it feeds
 * `createFlushBatch({ db })`. */
const DB_CLIENT = Symbol('DB_CLIENT');

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
  /** [T3.1.6] Already validated by workerEnvSchema — main.ts's
   * `env.DATABASE_URL_WORKER` (the writer role, CLAUDE.md), passed
   * through the same "validate once, pass down" discipline as
   * `redisUrl`. Feeds `createDbClient()` (packages/core, T1.1.1), which
   * backs both the production `flushBatch` (below) and, transitively,
   * `AccumulatingEventSink`/`ShutdownService`'s shared
   * `BatchAccumulator`. */
  readonly databaseUrl: string;
  /** [T3.1.6] Overrides `createDbClient()`'s own `max` — production
   * (main.ts) leaves this unset and relies on `createDbClient`'s
   * documented `process.env.DB_POOL_MAX` fallback (already set in
   * .env.example/docker-compose/k8s manifests for real deployments).
   * shutdown.test.ts passes a small explicit value instead, matching
   * `packages/core/src/test/pg-container.ts`'s own `CONTAINER_POOL_MAX`
   * precedent — vitest's own test process never loads `.env`, and unlike
   * CI's dedicated `migrate-from-empty` job, the main `ci` job that runs
   * `pnpm test` never sets `DB_POOL_MAX` either. */
  readonly dbPoolMax?: number;
  /** [T3.1.6] Already validated by workerEnvSchema — main.ts's
   * `env.EVENT_BATCH_SIZE`/`env.EVENT_BATCH_INTERVAL_MS`, passed through
   * to the production `BatchAccumulator<CaptureEvent>` this module now
   * constructs. */
  readonly batchSize: number;
  readonly batchIntervalMs: number;
  /** [T3.1.6] Already validated by workerEnvSchema — main.ts's
   * `env.SHUTDOWN_TIMEOUT_MS`, passed through to `ShutdownService`. */
  readonly shutdownTimeoutMs: number;
  /** [T3.1.6] Overrides the flush callback the production
   * `BatchAccumulator<CaptureEvent>` uses. Defaults to
   * `createFlushBatch({ db })` (against the real `databaseUrl` above)
   * when omitted — production (main.ts) never sets this.
   * shutdown.test.ts substitutes a controllable delay to prove the
   * `SHUTDOWN_TIMEOUT_MS` bound without needing a genuinely wedged
   * Postgres write. */
  readonly flush?: BatchFlushCallback<CaptureEvent>;
  /** Overrides the `EVENT_SINK` DI token `EventsConsumer` injects.
   * Defaults to `AccumulatingEventSink` (T3.1.6) when omitted —
   * production (main.ts) never sets this. events.consumer.test.ts and
   * dlq.service.test.ts pass their own observing sink here to assert
   * what the consumer actually decoded, against a real testcontainers
   * Redis, with no database involved. */
  readonly eventSink?: EventSink;
  /** Overrides the `EVENTS_CONSUMER_LOGGER` DI token `EventsConsumer`
   * injects. Defaults to `consoleErrorLogger` when omitted — same
   * override shape as `eventSink` above, for the same reason: a test
   * substitutes a spy through the real production DI wiring rather than
   * a parallel one. */
  readonly logger?: EventsConsumerLogger;
  /** [T3.1.6] Overrides the `SHUTDOWN_LOGGER` DI token `ShutdownService`
   * injects. Defaults to shutdown.ts's own `consoleErrorLogger` when
   * omitted — same override shape as `logger` above: shutdown.test.ts
   * substitutes a spy to assert the `SHUTDOWN_TIMEOUT_MS` timeout path
   * actually logs. */
  readonly shutdownLogger?: ShutdownLogger;
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
        // config" discipline as EVENTS_QUEUE above. `DlqService`
        // (./consumer/dlq.service.ts) injects the `Queue` instance this
        // registration produces via `@InjectQueue(EVENTS_DLQ_QUEUE)` — the
        // ONE writer both of EventsConsumer's DLQ paths (a decode failure,
        // and T3.1.5's attempts-exhausted path) call through, rather than
        // either writing to this queue directly. No `@Processor` for this
        // queue yet — draining EVENTS_DLQ_QUEUE is a later task's job, not
        // this one (events-queue.ts's own header).
        BullModule.registerQueue({ name: EVENTS_DLQ_QUEUE }),
      ],
      // T3.1.7 — HealthController serves `GET /health`, replacing main.ts's
      // former hand-rolled `app.use('/health', ...)` middleware (T3.1.2)
      // that always answered `200 ok`. See health.controller.ts's own
      // header for the full design rationale.
      controllers: [HealthController],
      providers: [
        EventsConsumer,
        // T3.1.5 — a normal class provider, not exposed through
        // `AppModuleConfig`: unlike `EVENT_SINK`/`EVENTS_CONSUMER_LOGGER`,
        // no test needs to substitute a fake `DlqService` — every DLQ test
        // (dlq.service.test.ts) either exercises the class directly
        // against a real testcontainers Redis `Queue`, or boots THIS real
        // wiring end to end, same "real BullMQ, no mocks" discipline as
        // the rest of this module.
        DlqService,
        // T3.1.6 — the worker's real Postgres connection, constructed
        // exactly once per booted app (Nest providers are singletons by
        // default within a module), from the already-validated
        // `databaseUrl`/`dbPoolMax` above. Nothing outside this factory
        // ever calls `process.env` for it.
        {
          provide: DB_CLIENT,
          useFactory: (): DbClient => {
            // `exactOptionalPropertyTypes: true` (tsconfig.base.json)
            // treats an explicit `max: undefined` property as distinct
            // from an OMITTED `max` key — `DbClientOptions.max` is typed
            // `max?: number`, not `max?: number | undefined`, so the
            // object literal must genuinely leave the key out when
            // `config.dbPoolMax` is unset, not merely set it to
            // `undefined`. The conditional spread below is what makes
            // "unset dbPoolMax" behave exactly like "key never
            // mentioned", so createDbClient's own resolvePoolMax()
            // still falls through to its `process.env.DB_POOL_MAX`
            // fallback (this file's own header, `dbPoolMax`'s doc
            // comment) rather than seeing a `max` key present at all.
            const client = createDbClient({
              connectionString: config.databaseUrl,
              ...(config.dbPoolMax !== undefined ? { max: config.dbPoolMax } : {}),
            });
            // [defensive, T3.1.6] A long-lived worker pool must never let
            // an IDLE pooled connection's backend-side error (a network
            // blip, a Postgres restart) become an uncaught exception —
            // `pg`'s Pool forwards a client's own 'error' event onto the
            // Pool itself (installed `pg-pool` source), and an 'error'
            // event with zero listeners throws synchronously in Node
            // (EventEmitter's own documented behavior). The affected
            // client is already removed from the pool by `pg-pool`
            // itself before this fires — there is nothing to do here
            // besides make sure the failure stays VISIBLE instead of
            // silently swallowed or crashing the process. Deliberately
            // separate from ShutdownService's own scope (shutdown.ts's
            // header) — this guards the LIVE process, not shutdown.
            client.pool.on('error', (error: Error) => {
              console.error('Worker Postgres pool reported an idle-connection error', {
                message: error.message,
              });
            });
            return client;
          },
        },
        // T3.1.6 — the shared `BatchAccumulator<CaptureEvent>`: exactly
        // ONE instance, injected into BOTH `AccumulatingEventSink`
        // (feeds it via `add()`) and `ShutdownService` (drains it via
        // `flushNow()` on SIGTERM) through the same `BATCH_ACCUMULATOR`
        // token — see events.consumer.ts's own header for why that
        // sharing is load-bearing, not incidental. `config.flush`
        // overrides the callback entirely (shutdown.test.ts's wedged-flush
        // scenario); production falls back to the real
        // `createFlushBatch({ db })` (T3.3.2) against the DbClient above.
        {
          provide: BATCH_ACCUMULATOR,
          useFactory: (dbClient: DbClient): BatchAccumulator<CaptureEvent> => {
            const flush = config.flush ?? createFlushBatch({ db: dbClient.db });
            return new BatchAccumulator<CaptureEvent>({
              batchSize: config.batchSize,
              batchIntervalMs: config.batchIntervalMs,
              flush,
            });
          },
          inject: [DB_CLIENT],
        },
        {
          provide: EVENT_SINK,
          useFactory: (accumulator: BatchAccumulator<CaptureEvent>): EventSink =>
            config.eventSink ?? new AccumulatingEventSink(accumulator),
          inject: [BATCH_ACCUMULATOR],
        },
        { provide: EVENTS_CONSUMER_LOGGER, useValue: config.logger ?? consoleErrorLogger },
        { provide: SHUTDOWN_TIMEOUT_MS, useValue: config.shutdownTimeoutMs },
        { provide: SHUTDOWN_LOGGER, useValue: config.shutdownLogger ?? shutdownConsoleErrorLogger },
        ShutdownService,
        // T3.1.7 — HealthController's own staleness-threshold input.
        // `config.batchIntervalMs` is already validated (env.EVENT_BATCH_
        // INTERVAL_MS, passed through above to BATCH_ACCUMULATOR's own
        // useFactory) — this is the SAME value, exposed under a second
        // token because HealthController has no reason to depend on the
        // accumulator's own construction options object to read it.
        { provide: FLUSH_INTERVAL_MS, useValue: config.batchIntervalMs },
      ],
    };
  }
}
