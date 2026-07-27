import 'reflect-metadata';
import { Queue } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { EVENTS_DLQ_QUEUE, EVENTS_JOB_OPTIONS, EVENTS_QUEUE, newId } from '@posta/core';
import { startRedisContainer, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module';
import { DlqService, type EventsDlqJobPayload } from './dlq.service';
import type { EventsConsumerLogger, EventSink } from './events.consumer';

// T3.1.5 [E3, S3.1] — DlqService is the ONE writer EVENTS_DLQ_QUEUE has
// (see dlq.service.ts's own header for the consolidation decision):
// T3.1.4's EventsConsumer.routeToDlq() (a decode failure, on attempt 1)
// and this task's EventsConsumer.onFailed() (a job that decodes fine but
// exhausts every EVENTS_JOB_OPTIONS.attempts at sink.handle()) both call
// DlqService.send(), and neither writes to the queue any other way.
//
// Two describe blocks, deliberately different levels:
//   - "DlqService — unit" exercises send()/depth() directly against a
//     real testcontainers-backed Queue<EventsDlqJobPayload> — no BullMQ
//     Worker, no AppModule, no consumer. This is the fast, isolated
//     proof that the service's own two methods do what they say.
//   - "EventsConsumer — attempts-exhausted..." boots the REAL production
//     wiring (AppModule.forRoot(), same discipline as
//     events.consumer.test.ts / malformed-job.test.ts) and proves the
//     genuinely hard part this task exists for: BullMQ's own 'failed'
//     event fires on EVERY failed attempt (verified against the
//     installed bullmq@5.80.10 source — Worker.handleFailed(),
//     node_modules/bullmq/dist/cjs/classes/worker.js, calls
//     `job.moveToFailed()` — which decides retry-or-terminal internally
//     — and THEN unconditionally emits 'failed', regardless of which way
//     that decision went), so EventsConsumer.onFailed() must tell "will
//     retry" apart from "truly, finally done" itself. The first test
//     proves the "done" half creates exactly ONE DLQ entry (not five, one
//     per attempt) carrying the full original payload, the error message,
//     and attemptsMade === 5. The second test proves the "will retry"
//     half — attempts 1-4 — creates NONE.

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

describe('DlqService — unit (real BullMQ queue, no consumer)', () => {
  let redis: RedisContainerHandle;

  beforeAll(async () => {
    redis = await startRedisContainer();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('send() writes exactly one job to EVENTS_DLQ_QUEUE carrying reason, the full raw payload, the error message, attemptsMade, originalJobId, and an ISO 8601 failedAt', async () => {
    const queue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    const service = new DlqService(queue);

    try {
      const payload = { some: 'raw-job-data', nested: { n: 1 } };
      const error = new Error('sink rejected forever');

      await service.send('attempts-exhausted', payload, error, {
        originalJobId: 'job-123',
        attemptsMade: 5,
      });

      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);

      const entry = jobs[0]!.data;
      expect(entry.reason).toBe('attempts-exhausted');
      expect(entry.rawPayload).toEqual(payload);
      expect(entry.errorMessage).toBe('sink rejected forever');
      expect(entry.attemptsMade).toBe(5);
      expect(entry.originalJobId).toBe('job-123');
      expect(entry.issues).toEqual([]);
      expect(new Date(entry.failedAt).toISOString()).toBe(entry.failedAt);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('send() carries the provided issues array through unchanged when supplied', async () => {
    const queue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    const service = new DlqService(queue);

    try {
      const issues = [{ path: 'ip', message: 'Unrecognized key', code: 'unrecognized_keys' }];

      await service.send('schema-validation-failed', { ip: '203.0.113.5' }, new Error('parse failed'), {
        originalJobId: 'job-456',
        attemptsMade: 1,
        issues,
      });

      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data.issues).toEqual(issues);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('depth() reflects the number of jobs currently sitting in the DLQ', async () => {
    const queue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    const service = new DlqService(queue);

    try {
      expect(await service.depth()).toBe(0);

      await service.send('attempts-exhausted', {}, new Error('e1'), {
        originalJobId: 'a',
        attemptsMade: 5,
      });
      await service.send('schema-validation-failed', {}, new Error('e2'), {
        originalJobId: 'b',
        attemptsMade: 1,
        issues: [],
      });

      expect(await service.depth()).toBe(2);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

describe('EventsConsumer — attempts-exhausted routes to the DLQ (real BullMQ, testcontainers Redis)', () => {
  let redis: RedisContainerHandle;

  beforeAll(async () => {
    redis = await startRedisContainer();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('creates exactly ONE DLQ entry (not five) after a sink that always throws exhausts every EVENTS_JOB_OPTIONS attempt, carrying the full original payload, the error message, and attemptsMade === 5', async () => {
    const sinkError = new Error('accumulator write failed forever');
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
    const dlqQueue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    let app: INestApplicationContext | undefined;
    try {
      app = await NestFactory.createApplicationContext(
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink, logger }),
      );

      const event = buildCaptureEvent();
      // Explicit EVENTS_JOB_OPTIONS on THIS job (not the queue's own
      // defaultJobOptions, which this raw `new Queue()` never sets) — the
      // same 5 attempts / exponential-from-1000ms policy
      // apps/api/src/redirect/enqueue.ts's createEventsQueue applies via
      // its queue-level default.
      const job = await queue.add('capture', event, EVENTS_JOB_OPTIONS);

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe('failed');
        },
        { timeout: 45_000, interval: 200 },
      );

      const failedJob = await queue.getJob(job.id ?? '');
      expect(failedJob?.attemptsMade).toBe(5);
      expect(handle).toHaveBeenCalledTimes(5);

      const dlqJobs = await dlqQueue.getJobs(['waiting']);
      expect(dlqJobs).toHaveLength(1);

      const entry = dlqJobs[0]!.data;
      expect(entry.reason).toBe('attempts-exhausted');
      expect(entry.rawPayload).toEqual(event);
      expect(entry.errorMessage).toBe(sinkError.message);
      expect(entry.attemptsMade).toBe(5);
      expect(entry.originalJobId).toBe(job.id);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await dlqQueue.obliterate({ force: true });
      await dlqQueue.close();
      await app?.close();
    }
  });

  it('does NOT create a DLQ entry for an intermediate failure — a job that fails twice and then succeeds never reaches the DLQ', async () => {
    let callCount = 0;
    const handle = vi.fn(async (_event: CaptureEvent): Promise<void> => {
      void _event;
      callCount += 1;
      if (callCount <= 2) {
        throw new Error(`transient failure #${callCount}`);
      }
    });
    const sink: EventSink = { handle };

    const queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    const dlqQueue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    let app: INestApplicationContext | undefined;
    try {
      app = await NestFactory.createApplicationContext(
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink }),
      );

      const event = buildCaptureEvent();
      const job = await queue.add('capture', event, EVENTS_JOB_OPTIONS);

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe('completed');
        },
        { timeout: 30_000, interval: 100 },
      );

      const completedJob = await queue.getJob(job.id ?? '');
      // 2 failed attempts (attemptsMade 1 and 2, both < 5 — BullMQ's own
      // 'failed' event fires for both, and EventsConsumer.onFailed() must
      // no-op both times) followed by 1 successful attempt.
      expect(completedJob?.attemptsMade).toBe(3);
      expect(handle).toHaveBeenCalledTimes(3);

      const dlqJobs = await dlqQueue.getJobs(['waiting']);
      expect(dlqJobs).toHaveLength(0);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await dlqQueue.obliterate({ force: true });
      await dlqQueue.close();
      await app?.close();
    }
  });
});
