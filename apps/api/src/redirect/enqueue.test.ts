import { newId } from '@posta/core';
import { startRedisContainer, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { Registry, register } from 'prom-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_JOB_NAME,
  createEnqueueCapture,
  createEnqueueDroppedCounter,
  createEventsQueue,
  ENQUEUE_DROPPED_COUNTER_NAME,
  EVENTS_QUEUE_NAME,
  type EnqueueQueue,
} from './enqueue';

// T2.4.2 [INV-1] — the producer half of S2.4: enqueueCapture() must
// never let a stalled queue turn into an unbounded promise pile-up. Two
// layers, deliberately tested differently (see this file's own
// comments at each describe block for why):
//   1. createEnqueueCapture's cap/drop/decrement logic, against a STUB
//      queue whose add() is fully controlled by this file. A real
//      BullMQ queue.add() cannot be made to "never settle" on demand —
//      the exact scenario the brief's own verify command requires — so
//      a stub is the more honest test here, not a shortcut.
//   2. createEventsQueue + createEnqueueCapture wired together against
//      a REAL testcontainers Redis, proving the actual production
//      wiring (queue name, job name, job-retention options, and the
//      dedicated-connection choice documented in enqueue.ts's header)
//      really deposits a real job with the right shape — something no
//      amount of stub-based testing can prove on its own.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CAPTURE_EVENT: CaptureEvent = {
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
};

/** Reads a Counter's current registered value off a dedicated Registry —
 * mirrors middleware.test.ts's identical helper (T2.1.5): these tests
 * assert the real value prom-client recorded, not merely that `.inc()`
 * was called on a spy. */
async function getCounterValue(registry: Registry, name: string): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((entry) => entry.name === name);
  return metric?.values[0]?.value ?? 0;
}

/** A promise plus its own resolve/reject, so a test can control exactly
 * when a stubbed add() call settles — the mechanism the "in-flight
 * returns to zero" cases below need, and something a real BullMQ queue
 * cannot be made to do on demand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createEnqueueDroppedCounter — both registry paths', () => {
  it('registers on the given registry when one is provided', () => {
    const registry = new Registry();

    const counter = createEnqueueDroppedCounter(registry);

    expect(registry.getSingleMetric(ENQUEUE_DROPPED_COUNTER_NAME)).toBe(counter);
  });

  it("falls back to prom-client's shared default registry when none is provided", () => {
    try {
      const counter = createEnqueueDroppedCounter();

      expect(register.getSingleMetric(ENQUEUE_DROPPED_COUNTER_NAME)).toBe(counter);
    } finally {
      register.removeSingleMetric(ENQUEUE_DROPPED_COUNTER_NAME);
    }
  });
});

describe('createEnqueueCapture — the in-flight cap (stub queue)', () => {
  it('the 1001st call is dropped, returns synchronously, increments the counter once, and in-flight never exceeds 1000', async () => {
    const add = vi.fn(() => new Promise<never>(() => {})); // never settles
    const registry = new Registry();
    const droppedCounter = createEnqueueDroppedCounter(registry);
    const queue: EnqueueQueue = { add };
    const enqueueCapture = createEnqueueCapture({ queue, droppedCounter });

    for (let i = 0; i < 1000; i += 1) {
      void enqueueCapture(CAPTURE_EVENT);
    }
    expect(add).toHaveBeenCalledTimes(1000);

    let settled = false;
    const result = enqueueCapture(CAPTURE_EVENT);
    void result.then(() => {
      settled = true;
    });

    // The 1001st call must resolve WITHOUT waiting on anything — flush
    // one microtask turn and it must already be settled, unlike the
    // 1000 calls above whose add() promise never settles at all.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);

    // in-flight never exceeded 1000: queue.add() was never called an
    // 1001st time.
    expect(add).toHaveBeenCalledTimes(1000);
    expect(await getCounterValue(registry, ENQUEUE_DROPPED_COUNTER_NAME)).toBe(1);
  });

  it('drops every call past the cap and counts each one', async () => {
    const add = vi.fn(() => new Promise<never>(() => {}));
    const registry = new Registry();
    const droppedCounter = createEnqueueDroppedCounter(registry);
    const enqueueCapture = createEnqueueCapture({
      queue: { add },
      droppedCounter,
      maxInflight: 2,
    });

    void enqueueCapture(CAPTURE_EVENT);
    void enqueueCapture(CAPTURE_EVENT);
    await enqueueCapture(CAPTURE_EVENT);
    await enqueueCapture(CAPTURE_EVENT);
    await enqueueCapture(CAPTURE_EVENT);

    expect(add).toHaveBeenCalledTimes(2);
    expect(await getCounterValue(registry, ENQUEUE_DROPPED_COUNTER_NAME)).toBe(3);
  });

  it('the in-flight count returns to zero after pending adds RESOLVE, freeing the cap back up', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const add = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementation(() => Promise.resolve('ok'));
    const registry = new Registry();
    const droppedCounter = createEnqueueDroppedCounter(registry);
    const enqueueCapture = createEnqueueCapture({
      queue: { add },
      droppedCounter,
      maxInflight: 2,
    });

    const p1 = enqueueCapture(CAPTURE_EVENT);
    const p2 = enqueueCapture(CAPTURE_EVENT);
    // Cap is full (2 in flight) — this call must be dropped.
    await enqueueCapture(CAPTURE_EVENT);
    expect(add).toHaveBeenCalledTimes(2);
    expect(await getCounterValue(registry, ENQUEUE_DROPPED_COUNTER_NAME)).toBe(1);

    first.resolve('done');
    second.resolve('done');
    await Promise.all([p1, p2]);

    // Both pending adds settled and decremented — the cap must be free
    // again, so this next call reaches queue.add() instead of being
    // dropped.
    await enqueueCapture(CAPTURE_EVENT);
    expect(add).toHaveBeenCalledTimes(3);
    expect(await getCounterValue(registry, ENQUEUE_DROPPED_COUNTER_NAME)).toBe(1);
  });

  it('the in-flight count returns to zero after pending adds REJECT, freeing the cap back up', async () => {
    const first = deferred<unknown>();
    const add = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => Promise.resolve('ok'));
    const registry = new Registry();
    const droppedCounter = createEnqueueDroppedCounter(registry);
    const enqueueCapture = createEnqueueCapture({
      queue: { add },
      droppedCounter,
      maxInflight: 1,
    });

    const p1 = enqueueCapture(CAPTURE_EVENT);
    // Cap is full (1 in flight) — this call must be dropped.
    await enqueueCapture(CAPTURE_EVENT);
    expect(add).toHaveBeenCalledTimes(1);
    expect(await getCounterValue(registry, ENQUEUE_DROPPED_COUNTER_NAME)).toBe(1);

    first.reject(new Error('redis down'));
    await expect(p1).rejects.toThrow('redis down');

    // The rejected add() still decremented in-flight — the cap is free
    // again.
    await enqueueCapture(CAPTURE_EVENT);
    expect(add).toHaveBeenCalledTimes(2);
    expect(await getCounterValue(registry, ENQUEUE_DROPPED_COUNTER_NAME)).toBe(1);
  });

  it('a rejecting add does not throw out of enqueueCapture and produces no unhandled rejection', async () => {
    const add = vi.fn(() => Promise.reject(new Error('redis down')));
    const registry = new Registry();
    const droppedCounter = createEnqueueDroppedCounter(registry);
    const enqueueCapture = createEnqueueCapture({ queue: { add }, droppedCounter });

    let thrown: unknown;
    let result: Promise<void> | undefined;
    try {
      result = enqueueCapture(CAPTURE_EVENT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeUndefined();
    // Attaching the assertion here, in the same synchronous block the
    // promise was created in, is what keeps this from ever registering
    // as an unhandled rejection — Node only reports one if a promise
    // reaches the end of the microtask queue with no handler attached.
    await expect(result).rejects.toThrow('redis down');
  });

  it('a resolving add resolves enqueueCapture with no drop', async () => {
    const add = vi.fn(() => Promise.resolve({ id: 'job-1' }));
    const registry = new Registry();
    const droppedCounter = createEnqueueDroppedCounter(registry);
    const enqueueCapture = createEnqueueCapture({ queue: { add }, droppedCounter });

    await expect(enqueueCapture(CAPTURE_EVENT)).resolves.toBeUndefined();
    expect(await getCounterValue(registry, ENQUEUE_DROPPED_COUNTER_NAME)).toBe(0);
  });
});

describe('createEventsQueue + createEnqueueCapture — real BullMQ (testcontainers Redis)', () => {
  let redis: RedisContainerHandle;

  beforeAll(async () => {
    redis = await startRedisContainer();
  });

  afterAll(async () => {
    await redis.stop();
  });

  it('builds a queue named "events" with the bounded job-retention policy applied to every added job', async () => {
    const queue = createEventsQueue(redis.url);
    try {
      expect(queue.name).toBe(EVENTS_QUEUE_NAME);

      const job = await queue.add(CAPTURE_JOB_NAME, CAPTURE_EVENT);

      expect(job.name).toBe(CAPTURE_JOB_NAME);
      expect(job.data).toEqual(CAPTURE_EVENT);
      expect(job.opts.removeOnComplete).toBe(1000);
      expect(job.opts.removeOnFail).toBe(500);
    } finally {
      // Both real-Redis tests in this block share ONE Redis container
      // and therefore one 'events' keyspace — obliterate before closing
      // so this test's job never leaks into the next one's assertions.
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('createEnqueueCapture wired to a real queue actually deposits a real job', async () => {
    const queue = createEventsQueue(redis.url);
    try {
      const droppedCounter = createEnqueueDroppedCounter(new Registry());
      const enqueueCapture = createEnqueueCapture({ queue, droppedCounter });

      await enqueueCapture(CAPTURE_EVENT);

      const waitingJobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(waitingJobs).toHaveLength(1);
      expect(waitingJobs[0]?.name).toBe(CAPTURE_JOB_NAME);
      expect(waitingJobs[0]?.data).toEqual(CAPTURE_EVENT);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
