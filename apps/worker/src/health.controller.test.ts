import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { BatchAccumulator } from './batch/accumulator';
import {
  FLUSH_STALE_MULTIPLIER,
  HealthController,
  type HealthDlq,
  type HealthQueue,
  type WorkerHealthStatus,
} from './health.controller';

// T3.1.7 [E3, S3.1] — see health.controller.ts's own header for the full
// design rationale: queue depth alone can look healthy while
// EventsConsumer is wedged, and last_flush_age_ms (BatchAccumulator.
// lastFlushAgeMs(), this task's own addition to accumulator.ts) is the
// signal that actually distinguishes idle-and-fine from stuck.
//
// Every test constructs HealthController directly against a REAL
// BatchAccumulator plus two plain-object doubles (HealthQueue/HealthDlq)
// — no testcontainers Redis, no AppModule.forRoot(), no @nestjs/testing.
// A real accumulator (not a third double) is deliberate: this task's own
// literal verify wording is "asserts... 503 after advancing fake timers
// past the threshold", which only means something if lastFlushAgeMs()'s
// real Date.now()-based math is what is actually under test, not a
// canned return value a double would supply instead. The other test
// files in this epic that DO boot the real AppModule.forRoot() DI graph
// (dlq.service.test.ts, shutdown.test.ts, events.consumer.test.ts,
// malformed-job.test.ts) already prove — every time they run — that the
// real wiring resolves HealthController's own dependencies
// (@InjectQueue(EVENTS_QUEUE), DlqService, BATCH_ACCUMULATOR,
// FLUSH_INTERVAL_MS, all registered in app.module.ts) without a DI error;
// re-proving that here with a second testcontainers boot would be
// redundant, not a gap.
//
// vi.useFakeTimers() in beforeEach, matching accumulator.test.ts's own
// convention — vitest's default toFake list includes 'Date' (verified
// against the installed vitest@4.1.10 source, not assumed:
// FakeTimers.install() is called with `toFake: Object.keys(fakeTimers.
// timers)`, and Date is one of @sinonjs/fake-timers' own core fakeable
// globals), which is what lets `vi.advanceTimersByTimeAsync()` below
// genuinely move `BatchAccumulator.lastFlushAgeMs()`'s own `Date.now() -
// this.lastFlushAt` forward.

const BATCH_INTERVAL_MS = 1000;

function buildQueue(depth: number): HealthQueue {
  return { getJobCountByTypes: vi.fn(async () => depth) };
}

function buildDlq(depth: number): HealthDlq {
  return { depth: vi.fn(async () => depth) };
}

/** A real BatchAccumulator<string> — T is a plain string fixture, matching
 * accumulator.test.ts's own precedent, since neither that class nor this
 * controller ever inspects an item's shape. */
function buildAccumulator(): BatchAccumulator<string> {
  return new BatchAccumulator<string>({
    batchSize: 100,
    batchIntervalMs: BATCH_INTERVAL_MS,
    flush: async () => {
      // Always succeeds instantly — every test below drives staleness
      // purely through elapsed fake-clock time, not through a failing
      // flush (accumulator.test.ts's own suite already covers that
      // failure-logging path in isolation).
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthController — 200 with a fresh flush (T3.1.7 verify)', () => {
  it('returns status "ok" and the full body immediately after a successful flush', async () => {
    const accumulator = buildAccumulator();
    accumulator.add('a');
    await accumulator.flushNow(); // fresh flush at t=0
    accumulator.add('b'); // one item accumulated since, still unflushed

    const controller = new HealthController(
      buildQueue(3),
      buildDlq(0),
      accumulator,
      BATCH_INTERVAL_MS,
    );

    const body = await controller.getHealth();

    expect(body).toEqual<WorkerHealthStatus>({
      status: 'ok',
      queue_depth: 3,
      dlq_depth: 0,
      last_flush_age_ms: 0,
      batch_size: 1,
    });
  });

  it('reads queue_depth from exactly the waiting/active/delayed/paused job types', async () => {
    const accumulator = buildAccumulator();
    const getJobCountByTypes = vi.fn(async () => 0);
    const controller = new HealthController(
      { getJobCountByTypes },
      buildDlq(0),
      accumulator,
      BATCH_INTERVAL_MS,
    );

    await controller.getHealth();

    expect(getJobCountByTypes).toHaveBeenCalledExactlyOnceWith(
      'waiting',
      'active',
      'delayed',
      'paused',
    );
  });
});

describe('HealthController — 503 once last_flush_age_ms exceeds three flush intervals (T3.1.7 verify)', () => {
  it('stays "ok" exactly AT the threshold, and flips to a 503 HttpException the instant it is exceeded', async () => {
    const accumulator = buildAccumulator();
    accumulator.add('a');
    await accumulator.flushNow(); // fresh flush at t=0

    const controller = new HealthController(
      buildQueue(0),
      buildDlq(0),
      accumulator,
      BATCH_INTERVAL_MS,
    );
    const staleThresholdMs = BATCH_INTERVAL_MS * FLUSH_STALE_MULTIPLIER;

    await vi.advanceTimersByTimeAsync(staleThresholdMs);
    const atThreshold = await controller.getHealth();
    expect(atThreshold.status).toBe('ok');
    expect(atThreshold.last_flush_age_ms).toBe(staleThresholdMs);

    await vi.advanceTimersByTimeAsync(1);

    const caught: unknown = await controller.getHealth().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(HttpException);
    const httpException = caught as HttpException;
    expect(httpException.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);

    // The 503's own body carries the SAME full shape a 200 would — an
    // operator/probe reading the response never gets a bare error string
    // (health.controller.ts's own header).
    const body = httpException.getResponse() as WorkerHealthStatus;
    expect(body.status).toBe('unhealthy');
    expect(body.last_flush_age_ms).toBe(staleThresholdMs + 1);
    expect(body.queue_depth).toBe(0);
    expect(body.dlq_depth).toBe(0);
    expect(body.batch_size).toBe(0);
  });
});

describe('HealthController — dlq_depth reflects a planted DLQ entry (T3.1.7 verify)', () => {
  it('carries whatever DlqService.depth() reports straight through into the response body', async () => {
    const accumulator = buildAccumulator();
    accumulator.add('a');
    await accumulator.flushNow(); // fresh flush — status stays "ok" regardless of DLQ depth

    const controller = new HealthController(
      buildQueue(0),
      buildDlq(1), // one planted DLQ entry
      accumulator,
      BATCH_INTERVAL_MS,
    );

    const body = await controller.getHealth();

    expect(body.dlq_depth).toBe(1);
    expect(body.status).toBe('ok'); // a DLQ entry alone never trips the 503 branch
  });

  it('reflects a count of several planted DLQ entries, not just zero-or-one', async () => {
    const accumulator = buildAccumulator();
    accumulator.add('a');
    await accumulator.flushNow();

    const controller = new HealthController(
      buildQueue(0),
      buildDlq(4),
      accumulator,
      BATCH_INTERVAL_MS,
    );

    const body = await controller.getHealth();

    expect(body.dlq_depth).toBe(4);
  });
});
