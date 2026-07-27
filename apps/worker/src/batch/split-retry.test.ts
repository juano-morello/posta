import { newId } from '@posta/core';
import { SLUG_MAX_LENGTH, type CaptureEvent } from '@posta/contracts';
import { describe, expect, it } from 'vitest';
import type { FlushBatch } from './flush';
import {
  retryWithSplit,
  type Sleep,
  type SplitRetryLogger,
  type SplitRetryOptions,
  type SplitRetryResult,
} from './split-retry';

// T3.3.3 [E3, S3.3] — retryWithSplit's own suite.
//
// TEST LEVEL — a plain injected FlushBatch double, NOT a testcontainer:
// the plan's verify wording ("plants one event with an oversized slug...
// against a batch of 100") reads like it wants a genuine Postgres
// rejection, so this was checked directly against the schema before
// choosing a double. `events.slug` (packages/core/migrations/sql/
// 001_events.sql) is a plain `text NOT NULL` with NO length constraint —
// no CHECK, no varchar(n), and no index that includes `slug` alone
// (packages/core/migrations/sql/002_events_indexes.sql only indexes
// (tenant_id, link_id, occurred_at) and (tenant_id, occurred_at)) — and
// Postgres `text` is always TOASTable up to ~1 GB, so there is no
// practical string length that fails a real INSERT on this column short
// of an enormous, slow-to-generate payload. CaptureEventSchema's own
// `slug` field (packages/contracts/src/capture.ts) is `z.string().min(1)`
// with no `.max()` either. A "real DB rejection" test would therefore
// have to manufacture an unrelated failure (a different column, a
// distinct constraint) and call it "an oversized slug", which is worse
// than being honest about the double. This file instead follows
// split-retry.ts's OWN documented design contract — "GENERIC OVER
// flushBatch, NOT COUPLED TO POSTGRES... any rejection at all is treated
// as 'this sub-batch did not commit'" — and plants a synthetic
// oversized-slug event (length > @posta/contracts' own SLUG_MAX_LENGTH,
// the app's real definition of "too long") that a fake `flushBatch`
// rejects, exactly mirroring the "does this sub-batch contain a slug
// past the length the app allows" check a real INSERT constraint would
// perform if one existed. flush.test.ts already proves the SQL side
// (idempotent multi-row INSERT) against a real testcontainer; this file
// proves the retry/split ALGORITHM, which is deliberately decoupled from
// what specifically makes a sub-batch fail.

const OVERSIZED_SLUG = 'x'.repeat(SLUG_MAX_LENGTH + 1);

function buildCaptureEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: newId(),
    link_id: newId(),
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

function buildBatch(size: number, poisonIndex: number | null): CaptureEvent[] {
  return Array.from({ length: size }, (_, index) =>
    buildCaptureEvent(index === poisonIndex ? { slug: OVERSIZED_SLUG } : {}),
  );
}

/** Instant, no-real-wait `sleep` double — the same "narrow, replaceable
 * seam" split-retry.ts's own header describes. Records every `ms`
 * argument it was called with, in call order, so the backoff SEQUENCE
 * can be asserted directly without a test ever waiting on a real clock. */
function createRecordingSleep(): { sleep: Sleep; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

function createRecordingLogger(): SplitRetryLogger & { calls: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const calls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    calls,
    error(message, meta) {
      calls.push(meta !== undefined ? { message, meta } : { message });
    },
  };
}

/**
 * A fake `flushBatch` that mimics a real Postgres multi-row INSERT: it
 * "commits" (records) every event in the sub-batch it receives ONLY when
 * NONE of them fail `isPoison`, and otherwise rejects the WHOLE sub-batch
 * — exactly the all-or-nothing behavior a single multi-row `INSERT
 * ... VALUES (...), (...), ...` has in real Postgres (split-retry.ts's
 * own header names this explicitly as the reason binary search, not
 * per-row inspection, is the right recovery shape). Also tracks: total
 * call count (the "round trips" T3.3.3's verify asks about) and peak
 * concurrent in-flight calls (proves the two halves of a split are
 * awaited sequentially, never raced via `Promise.all`).
 */
function createFakeFlushBatch(
  isPoison: (event: CaptureEvent) => boolean,
  options: { readonly callDelayMs?: number } = {},
): {
  readonly flushBatch: FlushBatch;
  readonly committed: Set<string>;
  callCount(): number;
  maxConcurrent(): number;
} {
  const committed = new Set<string>();
  let calls = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const callDelayMs = options.callDelayMs ?? 0;

  const flushBatch: FlushBatch = async (events) => {
    calls += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      if (callDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, callDelayMs));
      }
      if (events.some(isPoison)) {
        throw new Error('simulated Postgres rejection: value too long for column "slug"');
      }
      for (const event of events) committed.add(event.event_id);
    } finally {
      inFlight -= 1;
    }
  };

  return {
    flushBatch,
    committed,
    callCount: () => calls,
    maxConcurrent: () => peakInFlight,
  };
}

const FAST_OPTIONS = (overrides: Partial<SplitRetryOptions> = {}): SplitRetryOptions => {
  const { sleep } = createRecordingSleep();
  return { maxAttemptsPerBatch: 3, initialDelayMs: 10, sleep, ...overrides };
};

describe('retryWithSplit — option validation', () => {
  const noopFlush: FlushBatch = async () => undefined;

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a non-positive-integer maxAttemptsPerBatch: %j',
    async (maxAttemptsPerBatch) => {
      await expect(
        retryWithSplit([buildCaptureEvent()], noopFlush, FAST_OPTIONS({ maxAttemptsPerBatch })),
      ).rejects.toThrow(/maxAttemptsPerBatch/);
    },
  );

  it.each([-1, 1.5, Number.NaN])(
    'rejects a non-non-negative-integer initialDelayMs: %j',
    async (initialDelayMs) => {
      await expect(
        retryWithSplit([buildCaptureEvent()], noopFlush, FAST_OPTIONS({ initialDelayMs })),
      ).rejects.toThrow(/initialDelayMs/);
    },
  );
});

describe('retryWithSplit — empty batch', () => {
  it('is a no-op: flushBatch is never called, both result arrays are empty', async () => {
    const { flushBatch, callCount } = createFakeFlushBatch(() => false);

    const result = await retryWithSplit([], flushBatch, FAST_OPTIONS());

    expect(result).toEqual<SplitRetryResult>({ committedEvents: [], poisonEvents: [] });
    expect(callCount()).toBe(0);
  });
});

describe('retryWithSplit — fully healthy batch', () => {
  it('commits every event with a single flushBatch call and no poison', async () => {
    const events = buildBatch(10, null);
    const { flushBatch, callCount } = createFakeFlushBatch(() => false);

    const result = await retryWithSplit(events, flushBatch, FAST_OPTIONS());

    expect(callCount()).toBe(1);
    expect(result.poisonEvents).toEqual([]);
    expect(result.committedEvents.map((e) => e.event_id).sort()).toEqual(
      events.map((e) => e.event_id).sort(),
    );
  });
});

describe('retryWithSplit — a lone poison event (batch of one) is isolated without splitting', () => {
  it('retries maxAttemptsPerBatch times, then declares the single event poison', async () => {
    const poisonEvent = buildCaptureEvent({ slug: OVERSIZED_SLUG });
    const { flushBatch, callCount } = createFakeFlushBatch((e) => e.slug === OVERSIZED_SLUG);

    const result = await retryWithSplit([poisonEvent], flushBatch, FAST_OPTIONS({ maxAttemptsPerBatch: 4 }));

    expect(callCount()).toBe(4);
    expect(result.committedEvents).toEqual([]);
    expect(result.poisonEvents).toHaveLength(1);
    expect(result.poisonEvents[0]?.event.event_id).toBe(poisonEvent.event_id);
    // [T3.3.4] the underlying Error is carried through, not reduced to a
    // string — a real Postgres error's own `.code` (the SQLSTATE) rides
    // along on this same object, which is what lets a caller route it to
    // the DLQ without this file ever inspecting it itself.
    expect(result.poisonEvents[0]?.error).toBeInstanceOf(Error);
    expect(result.poisonEvents[0]?.error.message).toMatch(/simulated Postgres rejection/);
  });
});

describe('retryWithSplit — the plan\'s literal verify: 100-event batch, one oversized slug', () => {
  it('commits 99 rows and returns the poisoned event_id, with no event lost or duplicated', async () => {
    const events = buildBatch(100, 0);
    const poisonEventId = events[0]!.event_id;
    const { flushBatch, committed } = createFakeFlushBatch((e) => e.slug === OVERSIZED_SLUG);

    const result = await retryWithSplit(events, flushBatch, FAST_OPTIONS());

    expect(result.committedEvents).toHaveLength(99);
    expect(result.poisonEvents).toHaveLength(1);
    expect(result.poisonEvents[0]?.event.event_id).toBe(poisonEventId);
    expect(result.poisonEvents[0]?.error).toBeInstanceOf(Error);

    // Every committed event actually reached the fake table.
    expect(committed.size).toBe(99);
    for (const event of result.committedEvents) {
      expect(committed.has(event.event_id)).toBe(true);
    }

    // committedEvents ⊎ poisonEvents accounts for every original event
    // exactly once — nothing lost, nothing duplicated across the split.
    const resultIds = [
      ...result.committedEvents.map((e) => e.event_id),
      ...result.poisonEvents.map((p) => p.event.event_id),
    ].sort();
    expect(resultIds).toEqual(events.map((e) => e.event_id).sort());
  });

  it('logs the isolation of the poison event, naming its event_id', async () => {
    const events = buildBatch(100, 0);
    const poisonEventId = events[0]!.event_id;
    const { flushBatch } = createFakeFlushBatch((e) => e.slug === OVERSIZED_SLUG);
    const logger = createRecordingLogger();

    await retryWithSplit(events, flushBatch, FAST_OPTIONS({ logger }));

    const isolationCall = logger.calls.find((call) => call.meta?.eventId === poisonEventId);
    expect(isolationCall).toBeDefined();
    expect(isolationCall?.message).toMatch(/poison/i);
  });
});

describe('retryWithSplit — O(log n) round trips, not O(n)', () => {
  it('the number of flushBatch calls grows far slower than the batch size across a 16x size increase', async () => {
    const smallEvents = buildBatch(50, 0);
    const largeEvents = buildBatch(800, 0);

    const small = createFakeFlushBatch((e) => e.slug === OVERSIZED_SLUG);
    const large = createFakeFlushBatch((e) => e.slug === OVERSIZED_SLUG);

    await retryWithSplit(smallEvents, small.flushBatch, FAST_OPTIONS());
    await retryWithSplit(largeEvents, large.flushBatch, FAST_OPTIONS());

    const smallCalls = small.callCount();
    const largeCalls = large.callCount();

    // Proves real retry/split work happened (rules out a trivial
    // single-shot implementation like the stub this test was first
    // written against, which calls flushBatch exactly once no matter the
    // batch size).
    expect(smallCalls).toBeGreaterThan(3); // > maxAttemptsPerBatch alone
    expect(largeCalls).toBeGreaterThan(smallCalls);

    // Proves it is NOT O(n): batch size grew 16x (50 -> 800) but the
    // round-trip count must stay a small fraction of 800 — an O(n)
    // (or worse) strategy would need on the order of hundreds of calls.
    expect(largeCalls).toBeLessThan(800 / 4);

    // Proves the growth itself is sub-linear (logarithmic), not merely
    // "smaller than n": a 16x growth in batch size may only roughly
    // double the recursion depth (log2(800)/log2(50) ≈ 1.7), so the call
    // count growing by anywhere near 16x would itself be a red flag.
    expect(largeCalls / smallCalls).toBeLessThan(4);
  });
});

describe('retryWithSplit — exponential backoff sequence', () => {
  it('waits initialDelayMs * 2**(attempt-1) between successive attempts at the SAME sub-batch', async () => {
    const poisonEvent = buildCaptureEvent({ slug: OVERSIZED_SLUG });
    const { flushBatch } = createFakeFlushBatch((e) => e.slug === OVERSIZED_SLUG);
    const { sleep, delays } = createRecordingSleep();

    await retryWithSplit([poisonEvent], flushBatch, {
      maxAttemptsPerBatch: 4,
      initialDelayMs: 100,
      sleep,
    });

    // 4 attempts on a single-event (unsplittable) sub-batch -> 3 waits
    // BETWEEN attempts, doubling from the base each time.
    expect(delays).toEqual([100, 200, 400]);
  });
});

describe('retryWithSplit — split halves are processed sequentially, never concurrently', () => {
  it('never has more than one flushBatch call in flight at once', async () => {
    const events = buildBatch(8, 0);
    const { flushBatch, maxConcurrent } = createFakeFlushBatch((e) => e.slug === OVERSIZED_SLUG, {
      callDelayMs: 15,
    });
    const { sleep } = createRecordingSleep();

    const result = await retryWithSplit(events, flushBatch, {
      maxAttemptsPerBatch: 2,
      initialDelayMs: 0,
      sleep,
    });

    expect(maxConcurrent()).toBe(1);
    expect(result.committedEvents).toHaveLength(7);
    expect(result.poisonEvents).toHaveLength(1);
  }, 10_000);
});
