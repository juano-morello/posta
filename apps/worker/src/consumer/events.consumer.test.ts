import 'reflect-metadata';
import { Queue } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { EVENTS_QUEUE, newId } from '@posta/core';
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
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink }),
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

  it('never hands a job that fails eventJobSchema validation to the sink, and the job ends failed', async () => {
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
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink }),
      );

      // `ip` is not a key eventJobSchema (.strict()) allows — invariant 6's
      // own enforcement mechanism (packages/core/src/queue/events-queue.ts).
      // No `defaultJobOptions` on this Queue, so BullMQ's own default of a
      // single attempt applies — the job reaches 'failed' fast.
      const job = await queue.add('capture', {
        ...buildCaptureEvent(),
        ip: '203.0.113.5',
      });

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe('failed');
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
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink, logger }),
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

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, meta] = errorSpy.mock.calls[0] ?? [];
      expect(message).toContain(event.event_id);
      expect(message).toContain(sinkError.message);
      expect(meta).toEqual({
        eventId: event.event_id,
        linkId: event.link_id,
        tenantId: event.tenant_id,
      });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
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
