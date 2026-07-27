import 'reflect-metadata';
import { Queue } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { EVENTS_DLQ_QUEUE, EVENTS_QUEUE, newId } from '@posta/core';
import { startRedisContainer, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module';
import {
  DEFAULT_WORKER_CONCURRENCY,
  readWorkerConcurrency,
  type EventsConsumerLogger,
  type EventSink,
} from './events.consumer';

// T3.1.3 [E3, S3.1] — EventsConsumer drains EVENTS_QUEUE via a real
// @nestjs/bullmq `@Processor`/`WorkerHost`, discovered through the SAME
// `AppModule.forRoot()` DI wiring main.ts boots with (T3.1.2) — not a
// hand-rolled `new Worker(...)`, and not a parallel test-only module,
// so this proves the actual production wiring, the same way
// enqueue.test.ts's own "real BullMQ" block proves the producer side.
// `AppModuleConfig.eventSink` (app.module.ts) is what makes this
// possible without @nestjs/testing (not a worker dependency): a test
// substitute goes in through the exact same DI token
// (`EVENT_SINK`) production wiring uses for `NoopEventSink`, so nothing
// here is a special test-only code path.
//
// `NestFactory.createApplicationContext` — no HTTP listener needed for a
// consumer with no routes of its own; main.ts uses `NestFactory.create`
// only because it also serves `/health`.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// [T3.1.6] AppModule.forRoot() now always provisions a real Postgres
// DbClient + BatchAccumulator (app.module.ts) — even here, where every
// test overrides `eventSink`, so that wiring is provisioned but never
// actually queried. Same placeholder-config precedent as
// dlq.service.test.ts's own UNUSED_ACCUMULATOR_CONFIG (see that file for
// the full rationale, including why `dbPoolMax` must be set explicitly —
// leaving it unset makes createDbClient() read `process.env.DB_POOL_MAX`,
// unset here, and NestFactory's default `abortOnError: true` turns that
// into a hard `process.abort()` instead of a catchable rejection): this
// connection string only has to satisfy createDbClient()'s own
// construction-time validation (a non-empty string) — `pg.Pool` never
// connects eagerly — and no query is ever issued against it in this file.
// [T3.4.4] `flush` is a no-op for the identical reason — see
// dlq.service.test.ts's own updated comment for the full rationale
// (BATCH_ACCUMULATOR would otherwise need real `r2*` config this file
// has no use for).
const UNUSED_DATABASE_URL = 'postgresql://unused:unused@localhost:5432/unused';
const UNUSED_ACCUMULATOR_CONFIG = {
  databaseUrl: UNUSED_DATABASE_URL,
  dbPoolMax: 5,
  batchSize: 100,
  batchIntervalMs: 2_000,
  shutdownTimeoutMs: 5_000,
  flush: async (): Promise<void> => {},
};

function buildCaptureEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: 'tenant-1',
    link_id: 'link-1',
    slug: 'promo',
    http_method: 'GET',
    user_agent: null,
    referer: null,
    accept: null,
    accept_language: null,
    sec_fetch_site: null,
    sec_fetch_mode: null,
    sec_fetch_dest: null,
    sec_fetch_user: null,
    sec_purpose: null,
    sec_ch_ua: null,
    sec_ch_ua_mobile: null,
    sec_ch_ua_platform: null,
    purpose: null,
    x_purpose: null,
    x_moz: null,
    country: null,
    asn: null,
    visitor_hash: null,
    ...overrides,
  };
}

describe('EventsConsumer — real BullMQ (testcontainers Redis)', () => {
  let redis: RedisContainerHandle;

  beforeAll(async () => {
    redis = await startRedisContainer();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('drains 20 queued jobs and hands the sink 20 decoded payloads with event_id unchanged', async () => {
    const handle = vi.fn(async (_event: CaptureEvent): Promise<void> => {
      void _event;
    });
    const sink: EventSink = { handle };

    const queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    let app: INestApplicationContext | undefined;
    try {
      app = await NestFactory.createApplicationContext(
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink, ...UNUSED_ACCUMULATOR_CONFIG }),
      );

      const events = Array.from({ length: 20 }, (_unused, index) =>
        buildCaptureEvent({ slug: `promo-${index}` }),
      );

      await Promise.all(events.map((event) => queue.add('capture', event)));

      await vi.waitFor(
        () => {
          expect(handle).toHaveBeenCalledTimes(20);
        },
        { timeout: 30_000, interval: 100 },
      );

      const receivedIds = handle.mock.calls.map(([event]) => event.event_id).sort();
      const expectedIds = events.map((event) => event.event_id).sort();
      expect(receivedIds).toEqual(expectedIds);

      // Not just the IDs match — the whole decoded payload round-trips
      // unchanged, proving this went through eventJobSchema.parse rather
      // than some partial pick of the job data.
      const firstExpected = events[0];
      const firstReceived = handle.mock.calls.find(
        ([event]) => event.event_id === firstExpected?.event_id,
      )?.[0];
      expect(firstReceived).toEqual(firstExpected);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await app?.close();
    }
  });

  it('never hands a job that fails eventJobSchema validation to the sink, and the job ends completed (routed to the DLQ, not retried)', async () => {
    // [T3.1.4 update] This test previously asserted the job ended
    // 'failed', on the theory that a decode failure should exhaust
    // EVENTS_JOB_OPTIONS.attempts like any other processing error. T3.1.4
    // changed that deliberately: a payload that can't parse never parses
    // on a retry either, so burning all 5 attempts on it was pure waste.
    // events.consumer.ts now routes a decode failure straight to
    // EVENTS_DLQ_QUEUE and acks the original job instead — see
    // malformed-job.test.ts for the full DLQ-routing assertions (DLQ
    // contents, no-payload-in-logs); this test's own job here is only to
    // keep proving the "sink is never called" half against the real
    // production DI wiring, and that the job's own terminal state
    // actually changed to match.
    const handle = vi.fn(async (_event: CaptureEvent): Promise<void> => {
      void _event;
    });
    const sink: EventSink = { handle };

    const queue = new Queue(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    let app: INestApplicationContext | undefined;
    try {
      app = await NestFactory.createApplicationContext(
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink, ...UNUSED_ACCUMULATOR_CONFIG }),
      );

      // `ip` is not a key eventJobSchema (.strict()) allows — invariant 6's
      // own enforcement mechanism (packages/core/src/queue/events-queue.ts).
      const job = await queue.add('capture', {
        ...buildCaptureEvent(),
        ip: '203.0.113.5',
      });

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe('completed');
        },
        { timeout: 30_000, interval: 100 },
      );

      expect(handle).not.toHaveBeenCalled();
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await app?.close();
    }
  });

  it('logs a sink failure with event context and still lets BullMQ see the original error unchanged', async () => {
    // [fix-forward, silent-failure review] Proves the log-then-rethrow
    // path added to process()'s sink-failure branch: the job still ends
    // failed with BullMQ's own `failedReason` carrying the ORIGINAL sink
    // error unchanged, AND the injected logger receives the event's
    // identifying context — not the whole CaptureEvent.
    const sinkError = new Error('accumulator write failed');
    const handle = vi.fn(async (_event: CaptureEvent): Promise<void> => {
      void _event;
      throw sinkError;
    });
    const sink: EventSink = { handle };

    const errorSpy = vi.fn();
    const logger: EventsConsumerLogger = { error: errorSpy };

    const queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    let app: INestApplicationContext | undefined;
    try {
      app = await NestFactory.createApplicationContext(
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink, logger, ...UNUSED_ACCUMULATOR_CONFIG }),
      );

      const event = buildCaptureEvent();
      // No `defaultJobOptions` — BullMQ's own default of a single attempt
      // applies, so the job reaches 'failed' fast, same as the decode
      // -failure test above.
      const job = await queue.add('capture', event);

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe('failed');
        },
        { timeout: 30_000, interval: 100 },
      );

      expect(handle).toHaveBeenCalledTimes(1);
      // `job` is the snapshot `queue.add()` returned, from BEFORE
      // processing — `failedReason` only lands in Redis once the worker
      // marks it failed, so it must be re-fetched to see it. The rethrown
      // error is the SAME one sink.handle() rejected with — BullMQ's
      // retry machinery is unaffected by the log-wrap.
      const failedJob = await queue.getJob(job.id ?? '');
      expect(failedJob?.failedReason).toBe(sinkError.message);

      // [T3.1.5 update] A single-attempt job (no `defaultJobOptions`, same
      // as before) is now ALSO "exhausted" the instant it fails —
      // EventsConsumer's new `onFailed()` 'failed'-event handler
      // (dlq.service.ts's `DlqService.send()`) routes it to
      // `EVENTS_DLQ_QUEUE` and logs a second, distinct line once that
      // succeeds. This test's OWN original concern — the sink failure
      // itself is logged, once, with the event's identifying context,
      // before BullMQ's retry/attempts machinery ever sees it — is still
      // exactly what the FIRST call below asserts; the second call is
      // `onFailed()`'s own routing confirmation, asserted separately so
      // this test keeps proving both without conflating them.
      expect(errorSpy).toHaveBeenCalledTimes(2);
      const [message, meta] = errorSpy.mock.calls[0] ?? [];
      expect(message).toContain(event.event_id);
      expect(message).toContain(sinkError.message);
      expect(meta).toEqual({
        eventId: event.event_id,
        linkId: event.link_id,
        tenantId: event.tenant_id,
      });

      const [dlqMessage, dlqMeta] = errorSpy.mock.calls[1] ?? [];
      expect(dlqMessage).toContain('exhausted all 1 attempt(s)');
      expect(dlqMessage).toContain(EVENTS_DLQ_QUEUE);
      expect(dlqMeta).toEqual({ jobId: job.id });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await app?.close();
    }
  });

  it('a throwing logger never masks the original sink error, and onFailed() still completes the DLQ routing', async () => {
    // [security/silent-failure fix, review round 1] Proves
    // EventsConsumer's safeLog() wrapper across BOTH of the risk
    // categories its own doc comment describes, with a logger that
    // throws on every call: (1) process()'s sink-failure branch — BullMQ
    // DOES await this promise, so `failedJob.failedReason` must still be
    // the ORIGINAL sink error, never the logger's own thrown error
    // replacing it; (2) onFailed() — a plain @OnWorkerEvent listener
    // BullMQ never awaits — must still complete normally and write
    // exactly one DLQ entry despite the same throwing logger, rather than
    // becoming a genuine unhandled rejection (mirrors
    // apps/worker/src/batch/accumulator.test.ts's own precedent test for
    // the identical risk in runFlush()).
    const sinkError = new Error('accumulator write failed');
    const loggerError = new Error('logger transport down');
    const handle = vi.fn(async (_event: CaptureEvent): Promise<void> => {
      void _event;
      throw sinkError;
    });
    const sink: EventSink = { handle };
    const logger: EventsConsumerLogger = {
      error: () => {
        throw loggerError;
      },
    };

    const queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    const dlqQueue = new Queue(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    let app: INestApplicationContext | undefined;
    try {
      // Earlier tests in this describe block share one Redis container
      // and never obliterate EVENTS_DLQ_QUEUE themselves (a pre-existing
      // gap, not something this test's own fix touches) — worse, several
      // of them DO obliterate EVENTS_QUEUE in their own `finally`, which
      // resets ITS auto-increment job-id counter, so a later test's
      // auto-generated `job.id` can coincidentally collide with an
      // `originalJobId` an earlier, never-cleaned-up DLQ entry already
      // recorded. Filtering by id is therefore not reliable either —
      // clearing this queue's own state up front is what actually
      // guarantees the length assertion below means what it says.
      await dlqQueue.obliterate({ force: true });

      app = await NestFactory.createApplicationContext(
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink, logger, ...UNUSED_ACCUMULATOR_CONFIG }),
      );

      // No `defaultJobOptions` — a single attempt, same as the test above,
      // so this job is both 'failed' and immediately "exhausted".
      const job = await queue.add('capture', buildCaptureEvent());

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe('failed');
        },
        { timeout: 30_000, interval: 100 },
      );

      const failedJob = await queue.getJob(job.id ?? '');
      expect(failedJob?.failedReason).toBe(sinkError.message);

      // onFailed() runs asynchronously off BullMQ's own 'failed' event,
      // decoupled from the job's own state transition above — waited for
      // separately rather than assumed to have already happened by the
      // time job.getState() settled.
      await vi.waitFor(
        async () => {
          const dlqJobs = await dlqQueue.getJobs(['waiting']);
          expect(dlqJobs).toHaveLength(1);
          expect((dlqJobs[0]!.data as { originalJobId?: unknown }).originalJobId).toBe(job.id);
        },
        { timeout: 30_000, interval: 100 },
      );
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await dlqQueue.obliterate({ force: true });
      await dlqQueue.close();
      await app?.close();
    }
  });
});

describe('readWorkerConcurrency', () => {
  it('defaults to DEFAULT_WORKER_CONCURRENCY (8) when WORKER_CONCURRENCY is unset', () => {
    expect(readWorkerConcurrency({})).toBe(DEFAULT_WORKER_CONCURRENCY);
    expect(DEFAULT_WORKER_CONCURRENCY).toBe(8);
  });

  it('parses a valid positive integer string', () => {
    expect(readWorkerConcurrency({ WORKER_CONCURRENCY: '16' })).toBe(16);
  });

  it.each(['banana', '0', '-1', '3.5', ''])(
    'throws rather than silently falling back on an invalid value: %j',
    (value) => {
      expect(() => readWorkerConcurrency({ WORKER_CONCURRENCY: value })).toThrow();
    },
  );
});
