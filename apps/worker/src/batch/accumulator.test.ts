import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchAccumulator, type BatchAccumulatorLogger } from './accumulator';

// T3.3.1 [E3, S3.3] — see accumulator.ts's own header for the full design
// rationale (generic-over-T, the flush callback signature, and the
// swap-before-invoke safety property this file's "in-flight flush"
// scenario exercises directly). Every test here uses vitest's fake
// timers throughout (`vi.useFakeTimers()` in beforeEach), the same
// requirement the task's own verify command names: the count/interval
// race has to be provably correct without any test actually waiting on a
// real clock.
//
// T is `string` in every test below — a plain, structurally trivial
// fixture is enough, since BatchAccumulator itself never inspects an
// item's shape (that's the whole point of it being generic).

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BatchAccumulator — count trigger (T3.3.1 verify: 100th event)', () => {
  it('flushes at the 100th event immediately, with zero timer elapsed', () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
    });

    for (let index = 0; index < 100; index += 1) {
      accumulator.add(`event-${index}`);
    }

    // No vi.advanceTimersByTime call anywhere above — this proves the
    // count trigger fires synchronously within add(), not on a timer.
    expect(flush).toHaveBeenCalledTimes(1);
    const [events, batchId] = flush.mock.calls[0]!;
    expect(events).toHaveLength(100);
    expect(events[0]).toBe('event-0');
    expect(events[99]).toBe('event-99');
    expect(typeof batchId).toBe('string');
    expect(accumulator.size()).toBe(0);
  });

  it('a count-triggered flush cancels its own interval timer — a later batch is not flushed early by the stale timer', async () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 2,
      batchIntervalMs: 2000,
      flush,
    });

    accumulator.add('a');
    accumulator.add('b'); // t=0: count trigger -> flush #1 (batch A); A's own timer was due at t=2000

    await vi.advanceTimersByTimeAsync(1500); // t=1500
    accumulator.add('c'); // opens batch B; B's own timer is due at t=1500+2000=3500

    await vi.advanceTimersByTimeAsync(500); // t=2000 — A's stale timer, if not cancelled, fires now
    expect(flush).toHaveBeenCalledTimes(1); // still just batch A

    await vi.advanceTimersByTimeAsync(1500); // t=3500 — B's own genuine timer fires now
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1]![0]).toEqual(['c']);
  });
});

describe('BatchAccumulator — interval trigger (T3.3.1 verify: 99 events at exactly 2000ms)', () => {
  it('flushes 99 events at exactly 2000ms when the count threshold (100) is never reached', async () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
    });

    for (let index = 0; index < 99; index += 1) {
      accumulator.add(`event-${index}`);
    }
    expect(flush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(flush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    const [events] = flush.mock.calls[0]!;
    expect(events).toHaveLength(99);
  });
});

describe('BatchAccumulator — in-flight flush safety (T3.3.1 verify)', () => {
  it('routes events added during an in-flight flush into the NEXT batch, none lost or duplicated', async () => {
    let resolveFirstFlush: (() => void) | undefined;
    const flush = vi.fn((_events: readonly string[], _batchId: string): Promise<void> => {
      void _events;
      void _batchId;
      if (flush.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstFlush = resolve;
        });
      }
      return Promise.resolve();
    });

    const accumulator = new BatchAccumulator<string>({
      batchSize: 2,
      batchIntervalMs: 2000,
      flush,
    });

    accumulator.add('a');
    accumulator.add('b'); // hits batchSize=2 -> triggers flush #1, left PENDING on purpose

    expect(flush).toHaveBeenCalledTimes(1);
    expect(resolveFirstFlush).toBeDefined();
    const [firstEvents, firstBatchId] = flush.mock.calls[0]!;
    expect(firstEvents).toEqual(['a', 'b']);

    // While flush #1 is still in flight, new events arrive.
    accumulator.add('c');
    expect(accumulator.size()).toBe(1); // 'c' landed in a brand new batch
    expect(flush).toHaveBeenCalledTimes(1); // still just the one call
    expect(flush.mock.calls[0]![0]).toEqual(['a', 'b']); // batch #1's array untouched by 'c'

    accumulator.add('d'); // hits batchSize=2 again -> triggers flush #2 for ['c', 'd']

    expect(flush).toHaveBeenCalledTimes(2);
    const [secondEvents, secondBatchId] = flush.mock.calls[1]!;
    expect(secondEvents).toEqual(['c', 'd']);
    expect(secondBatchId).not.toBe(firstBatchId);
    expect(accumulator.size()).toBe(0);

    // Let flush #1 finally settle — proves it never blocked on, and was
    // never mutated by, the events that arrived after it was triggered.
    resolveFirstFlush?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstEvents).toEqual(['a', 'b']);
    expect(flush).toHaveBeenCalledTimes(2); // resolving #1 doesn't trigger a 3rd call
  });
});

describe('BatchAccumulator — batch_id stability (T3.3.1 verify)', () => {
  it('mints one batch_id per batch, shared by every event in that batch, and a new id for the next batch', () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 3,
      batchIntervalMs: 2000,
      flush,
    });

    accumulator.add('a');
    accumulator.add('b');
    accumulator.add('c'); // count trigger -> flush #1, one batch_id for all of a/b/c

    accumulator.add('d');
    accumulator.add('e');
    accumulator.add('f'); // count trigger -> flush #2, a DIFFERENT batch_id for all of d/e/f

    expect(flush).toHaveBeenCalledTimes(2);
    const [firstEvents, firstBatchId] = flush.mock.calls[0]!;
    const [secondEvents, secondBatchId] = flush.mock.calls[1]!;
    expect(firstEvents).toEqual(['a', 'b', 'c']);
    expect(secondEvents).toEqual(['d', 'e', 'f']);
    expect(typeof firstBatchId).toBe('string');
    expect(typeof secondBatchId).toBe('string');
    expect(firstBatchId).not.toBe(secondBatchId);
  });
});

describe('BatchAccumulator — flushNow()', () => {
  it('manually flushes the current batch, awaiting the callback before resolving', async () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
    });

    accumulator.add('a');
    accumulator.add('b');
    expect(accumulator.size()).toBe(2);

    await accumulator.flushNow();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]![0]).toEqual(['a', 'b']);
    expect(accumulator.size()).toBe(0);
  });

  it('is a no-op that resolves immediately when the batch is empty', async () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
    });

    await expect(accumulator.flushNow()).resolves.toBeUndefined();
    expect(flush).not.toHaveBeenCalled();
  });

  it('cancels the pending interval timer, so it never fires again for an already-flushed batch', async () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
    });

    accumulator.add('a');
    await accumulator.flushNow();

    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(1); // not called again
  });

  it('propagates a flush failure to its own caller, in addition to logging it', async () => {
    const flushError = new Error('r2 unavailable');
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
      throw flushError;
    });
    const errorSpy = vi.fn();
    const logger: BatchAccumulatorLogger = { error: errorSpy };
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
      logger,
    });

    accumulator.add('a');

    await expect(accumulator.flushNow()).rejects.toBe(flushError);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('BatchAccumulator — size()', () => {
  it('reflects only the current open batch: 0 before any add, growing with each add, reset after a flush', () => {
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
    });
    const accumulator = new BatchAccumulator<string>({
      batchSize: 3,
      batchIntervalMs: 2000,
      flush,
    });

    expect(accumulator.size()).toBe(0);
    accumulator.add('a');
    expect(accumulator.size()).toBe(1);
    accumulator.add('b');
    expect(accumulator.size()).toBe(2);
    accumulator.add('c'); // count trigger
    expect(accumulator.size()).toBe(0);
  });
});

describe('BatchAccumulator — flush failure logging on the two automatic triggers', () => {
  it('logs a count-triggered flush failure without throwing out of add()', async () => {
    const flushError = new Error('write failed');
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
      throw flushError;
    });
    const errorSpy = vi.fn();
    const logger: BatchAccumulatorLogger = { error: errorSpy };
    const accumulator = new BatchAccumulator<string>({
      batchSize: 1,
      batchIntervalMs: 2000,
      flush,
      logger,
    });

    expect(() => accumulator.add('a')).not.toThrow();

    await vi.advanceTimersByTimeAsync(0);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0]!;
    expect(message).toContain(flushError.message);
    expect(meta).toMatchObject({ eventCount: 1 });
  });

  it('logs an interval-triggered flush failure without an unhandled rejection', async () => {
    const flushError = new Error('r2 timeout');
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
      throw flushError;
    });
    const errorSpy = vi.fn();
    const logger: BatchAccumulatorLogger = { error: errorSpy };
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
      logger,
    });

    accumulator.add('a');
    await vi.advanceTimersByTimeAsync(2000);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = errorSpy.mock.calls[0]!;
    expect(message).toContain(flushError.message);
    expect(meta).toMatchObject({ eventCount: 1 });
  });

  it('defaults to consoleErrorLogger (writes to console.error) when no logger is injected', async () => {
    const flushError = new Error('boom');
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
      throw flushError;
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const accumulator = new BatchAccumulator<string>({
        batchSize: 1,
        batchIntervalMs: 2000,
        flush,
      });

      accumulator.add('a');
      await vi.advanceTimersByTimeAsync(0);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('BatchAccumulator — a throwing logger never masks the original flush error (fix-forward, silent-failure review)', () => {
  it('flushNow() propagates the ORIGINAL flush error, not the logger\'s, when the logger itself throws', async () => {
    const flushError = new Error('r2 unavailable');
    const loggerError = new Error('logger transport down');
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
      throw flushError;
    });
    const logger: BatchAccumulatorLogger = {
      error: () => {
        throw loggerError;
      },
    };
    const accumulator = new BatchAccumulator<string>({
      batchSize: 100,
      batchIntervalMs: 2000,
      flush,
      logger,
    });

    accumulator.add('a');

    // The caller must see flushError (the real cause), never loggerError
    // (a side effect of trying to report it).
    await expect(accumulator.flushNow()).rejects.toBe(flushError);
  });

  it('the count-trigger fire-and-forget path survives a throwing logger with no unhandled rejection, and accepts a new batch afterward', async () => {
    const flushError = new Error('write failed');
    const loggerError = new Error('logger transport down');
    const flush = vi.fn(async (_events: readonly string[], _batchId: string) => {
      void _events;
      void _batchId;
      throw flushError;
    });
    const logger: BatchAccumulatorLogger = {
      error: () => {
        throw loggerError;
      },
    };
    const accumulator = new BatchAccumulator<string>({
      batchSize: 1,
      batchIntervalMs: 2000,
      flush,
      logger,
    });

    // add() itself must not throw — even though BOTH the flush callback
    // AND the logger it reports through reject/throw.
    expect(() => accumulator.add('a')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    // The accumulator must still be usable: a fresh batch opens and
    // flushes normally afterward, proving the compounding failure above
    // left no internal state corrupted.
    accumulator.add('b');
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1]![0]).toEqual(['b']);
  });
});

describe('BatchAccumulator — constructor validation', () => {
  const noopFlush = async (_events: readonly string[], _batchId: string): Promise<void> => {
    void _events;
    void _batchId;
  };

  it.each([0, -1, 1.5, Number.NaN])(
    'throws on a non-positive-integer batchSize: %j',
    (batchSize) => {
      expect(
        () => new BatchAccumulator<string>({ batchSize, batchIntervalMs: 2000, flush: noopFlush }),
      ).toThrow();
    },
  );

  it.each([0, -1, 1.5, Number.NaN])(
    'throws on a non-positive-integer batchIntervalMs: %j',
    (batchIntervalMs) => {
      expect(
        () => new BatchAccumulator<string>({ batchSize: 100, batchIntervalMs, flush: noopFlush }),
      ).toThrow();
    },
  );
});
