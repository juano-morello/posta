import 'reflect-metadata';
import { Queue } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { EVENTS_DLQ_QUEUE, EVENTS_QUEUE, newId } from '@posta/core';
import { startRedisContainer, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module';
import type { EventsConsumerLogger, EventSink, EventsDlqJobPayload } from './events.consumer';

// T3.1.4 [E3, S3.1][security] — a job whose data fails eventJobSchema
// validation will NEVER decode on a retry (the schema doesn't change
// between attempts), so burning all 5 of EVENTS_JOB_OPTIONS.attempts on
// it before giving up (events.consumer.test.ts's OLD "ends failed"
// expectation, now superseded — see that file's own T3.1.4 update) only
// delays the inevitable and costs consumer slots for nothing. This suite
// proves the replacement behavior: the job is routed to EVENTS_DLQ_QUEUE
// (raw payload + the Zod issue list) and the ORIGINAL job is acked —
// completed, not failed — after exactly one attempt, with no retry ever
// scheduled.
//
// [security] the raw payload is unvalidated external input (this is
// exactly the case where invariant 6 could be violated — a stray `ip`
// key smuggled past capture) and per this task's brief must reach the
// DLQ record ONLY, never stdout/the injected logger. `secretMarker`
// below is embedded in the malformed payload specifically so the
// "never logged" assertion has teeth: a marker absent from every
// captured log call is meaningfully stronger evidence than merely
// checking the log message doesn't equal the empty string.
//
// Same "real BullMQ, real testcontainers Redis, boot through
// AppModule.forRoot() (production wiring)" discipline as
// events.consumer.test.ts — no parallel test-only module, no mocked
// BullMQ.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// [T3.1.6] Same placeholder-config precedent as dlq.service.test.ts's own
// UNUSED_ACCUMULATOR_CONFIG (see that file for the full rationale,
// including why `dbPoolMax` must be set explicitly — leaving it unset
// makes createDbClient() read `process.env.DB_POOL_MAX`, unset here, and
// NestFactory's default `abortOnError: true` turns that into a hard
// `process.abort()` instead of a catchable rejection): AppModule.forRoot()
// now always provisions a real Postgres DbClient + BatchAccumulator, even
// here where the test overrides `eventSink` and never queries either.
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

describe('EventsConsumer — malformed jobs route to the DLQ (real BullMQ, testcontainers Redis)', () => {
  let redis: RedisContainerHandle;

  beforeAll(async () => {
    redis = await startRedisContainer();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('routes a job failing eventJobSchema validation to EVENTS_DLQ_QUEUE, completes the original job after exactly one attempt, never calls the sink, and never logs the raw payload', async () => {
    const handle = vi.fn(async (_event: CaptureEvent): Promise<void> => {
      void _event;
    });
    const sink: EventSink = { handle };

    const errorSpy = vi.fn();
    const logger: EventsConsumerLogger = { error: errorSpy };

    const queue = new Queue(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    const dlqQueue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    let app: INestApplicationContext | undefined;
    try {
      app = await NestFactory.createApplicationContext(
        AppModule.forRoot({ redisUrl: redis.url, eventSink: sink, logger, ...UNUSED_ACCUMULATOR_CONFIG }),
      );

      // Not a CaptureEvent at all — `eventJobSchema` (`.strict()`) rejects
      // it outright. `marker` carries a value that would be trivially
      // greppable in captured log output if it ever escaped there.
      const secretMarker = `do-not-leak-me-${newId()}`;
      const malformedPayload = { nonsense: true, marker: secretMarker };

      const job = await queue.add('capture', malformedPayload);

      await vi.waitFor(
        async () => {
          expect(await job.getState()).toBe('completed');
        },
        { timeout: 30_000, interval: 100 },
      );

      // "no retries": the job settled after its FIRST attempt, never a
      // second one — attemptsMade is BullMQ's own count of how many times
      // this job was actually handed to a processor.
      const completedJob = await queue.getJob(job.id ?? '');
      expect(completedJob?.attemptsMade).toBe(1);

      expect(handle).not.toHaveBeenCalled();

      // No consumer is attached to EVENTS_DLQ_QUEUE (this task reserves
      // routing INTO it, not draining it — T3.1.5's job later), so the
      // job this test is looking for is still sitting in 'waiting'.
      const dlqJobs = await dlqQueue.getJobs(['waiting']);
      expect(dlqJobs).toHaveLength(1);
      const dlqJob = dlqJobs[0]!;
      expect(dlqJob.data.reason).toBe('schema-validation-failed');
      expect(dlqJob.data.rawPayload).toEqual(malformedPayload);
      expect(dlqJob.data.originalJobId).toBe(job.id);
      expect(Array.isArray(dlqJob.data.issues)).toBe(true);
      expect(dlqJob.data.issues.length).toBeGreaterThan(0);

      // The security assertion: nothing captured by the injected logger
      // ever contains a string that came from the raw payload.
      for (const call of errorSpy.mock.calls) {
        const serializedCall = JSON.stringify(call);
        expect(serializedCall).not.toContain(secretMarker);
        expect(serializedCall).not.toContain('nonsense');
      }
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await dlqQueue.obliterate({ force: true });
      await dlqQueue.close();
      await app?.close();
    }
  });
});
