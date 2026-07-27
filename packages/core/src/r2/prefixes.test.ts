import { describe, expect, it } from 'vitest';
import { newId } from '../ulid';
import { eventBatchKey, eventPrefixes } from './keys';

// T3.6.1 (E3, S3.6) [INV-7] — eventPrefixes() is the exact inverse of
// eventBatchKey() (T3.4.3): where that function turns ONE instant into
// ONE `dt=.../hour=.../<batchId>.ndjson` key, this one turns a [from, to]
// range into the SET of `dt=.../hour=.../` partition prefixes a replay
// tool must LIST/GET to rebuild Postgres from the R2 log for that window.
//
// The range operates at UTC CALENDAR-DAY granularity, not raw instant/hour
// intersection — see keys.ts's own header comment on eventPrefixes for the
// full reasoning. The short version, which every test below exercises:
// `from`/`to` are truncated to the UTC day they fall on, and EVERY hour of
// EVERY day from dayOf(from) through dayOf(to) inclusive is emitted, even
// hours outside the literal [from, to] instant range. This makes the
// function over-inclusive at its boundaries, never under-inclusive — a
// missed hour is data loss on replay, a few extra covered hours are an
// idempotent no-op (invariant 8).

const HOURS_PER_DAY = 24;

describe('eventPrefixes (T3.6.1)', () => {
  it('yields exactly 24 prefixes, one per hour, for a single UTC calendar day', () => {
    const prefixes = eventPrefixes('2026-07-21T00:00:00.000Z', '2026-07-21T23:59:59.999Z');

    expect(prefixes).toHaveLength(HOURS_PER_DAY);
    expect(new Set(prefixes).size).toBe(HOURS_PER_DAY);
    expect(prefixes[0]).toBe('events/dt=2026-07-21/hour=00/');
    expect(prefixes[prefixes.length - 1]).toBe('events/dt=2026-07-21/hour=23/');
    expect(prefixes.every((prefix) => prefix.startsWith('events/dt=2026-07-21/hour='))).toBe(true);
  });

  it('yields exactly 72 prefixes (3 days x 24 hours) for a 3-day range', () => {
    const prefixes = eventPrefixes('2026-07-21T00:00:00.000Z', '2026-07-23T23:59:59.999Z');

    expect(prefixes).toHaveLength(3 * HOURS_PER_DAY);
    expect(new Set(prefixes).size).toBe(3 * HOURS_PER_DAY);

    for (const day of ['2026-07-21', '2026-07-22', '2026-07-23']) {
      const dayPrefixes = prefixes.filter((prefix) => prefix.startsWith(`events/dt=${day}/hour=`));
      expect(dayPrefixes).toHaveLength(HOURS_PER_DAY);
    }
  });

  it('from === to (the same non-hour-aligned instant) yields 24, not 0 or 1', () => {
    // This is the key edge case: 05:45:00Z is nowhere near an hour
    // boundary, and `from` and `to` are the literal same value — a naive
    // "intersect each hour bucket against [from, to]" implementation would
    // yield exactly 1 (only the 05:00 bucket contains this instant), and a
    // naive "empty range when from === to" implementation would yield 0.
    // Day-granularity yields the full day, 24, regardless of the
    // time-of-day either endpoint happens to land on.
    const sameInstant = '2026-07-21T05:45:00.000Z';

    const prefixes = eventPrefixes(sameInstant, sameInstant);

    expect(prefixes).toHaveLength(HOURS_PER_DAY);
    expect(prefixes).toEqual(
      Array.from({ length: HOURS_PER_DAY }, (_, hour) => `events/dt=2026-07-21/hour=${String(hour).padStart(2, '0')}/`)
    );
  });

  it('a range crossing a UTC day boundary emits BOTH full days, not just the ~1 hour actually spanned', () => {
    // from is 30 minutes before midnight on the 21st, to is 15 minutes
    // after midnight on the 22nd — literally ~45 minutes of wall-clock
    // range, touching only 2 hour buckets (23 on the 21st, 00 on the
    // 22nd). Day-granularity still emits all 48 hours of both days.
    const prefixes = eventPrefixes('2026-07-21T23:30:00.000Z', '2026-07-22T00:15:00.000Z');

    expect(prefixes).toHaveLength(2 * HOURS_PER_DAY);
    expect(prefixes.filter((prefix) => prefix.startsWith('events/dt=2026-07-21/hour='))).toHaveLength(HOURS_PER_DAY);
    expect(prefixes.filter((prefix) => prefix.startsWith('events/dt=2026-07-22/hour='))).toHaveLength(HOURS_PER_DAY);
  });

  it('rolls over month and year boundaries correctly (2025-12-31 -> 2026-01-01)', () => {
    const prefixes = eventPrefixes('2025-12-31T00:00:00.000Z', '2026-01-01T23:59:59.999Z');

    expect(prefixes).toHaveLength(2 * HOURS_PER_DAY);
    expect(prefixes.filter((prefix) => prefix.startsWith('events/dt=2025-12-31/hour='))).toHaveLength(HOURS_PER_DAY);
    expect(prefixes.filter((prefix) => prefix.startsWith('events/dt=2026-01-01/hour='))).toHaveLength(HOURS_PER_DAY);
  });

  it('same-day range does not throw even when from\'s time-of-day is later than to\'s (day comparison, not instant comparison)', () => {
    // Both instants fall on 2026-07-21; the fact that 23:00 is later in
    // the day than 05:00 is irrelevant to a function whose output
    // granularity is the whole day — the result is identical either way.
    const prefixes = eventPrefixes('2026-07-21T23:00:00.000Z', '2026-07-21T05:00:00.000Z');

    expect(prefixes).toHaveLength(HOURS_PER_DAY);
    expect(prefixes.every((prefix) => prefix.startsWith('events/dt=2026-07-21/hour='))).toBe(true);
  });

  it('every emitted prefix is a genuine string-prefix of a real eventBatchKey key for a sample instant inside the range', () => {
    const from = '2026-07-21T00:00:00.000Z';
    const to = '2026-07-23T23:59:59.999Z';
    const prefixes = eventPrefixes(from, to);

    const sampleInstants = [
      '2026-07-21T00:00:00.000Z',
      '2026-07-21T14:22:00.000Z',
      '2026-07-22T09:05:00.000Z',
      '2026-07-23T23:59:59.999Z',
      '2026-07-21T02:30:00-03:00', // -03:00 offset -> a different UTC hour, exercising the same UTC-conversion path eventBatchKey itself protects
    ];

    for (const instant of sampleInstants) {
      const key = eventBatchKey(newId(), instant);
      const matchesSomePrefix = prefixes.some((prefix) => key.startsWith(prefix));

      expect(matchesSomePrefix).toBe(true);
    }
  });

  describe('purity', () => {
    it('produces the same result across repeated calls with the same inputs', () => {
      const first = eventPrefixes('2026-07-21T00:00:00.000Z', '2026-07-22T00:00:00.000Z');
      const second = eventPrefixes('2026-07-21T00:00:00.000Z', '2026-07-22T00:00:00.000Z');

      expect(first).toEqual(second);
    });
  });

  describe('invalid input', () => {
    it('throws for an unparseable "from"', () => {
      expect(() => eventPrefixes('not-a-timestamp', '2026-07-21T00:00:00.000Z')).toThrow();
    });

    it('throws for an unparseable "to"', () => {
      expect(() => eventPrefixes('2026-07-21T00:00:00.000Z', 'not-a-timestamp')).toThrow();
    });

    it('throws for an empty-string "from"', () => {
      expect(() => eventPrefixes('', '2026-07-21T00:00:00.000Z')).toThrow();
    });

    it('throws for an empty-string "to"', () => {
      expect(() => eventPrefixes('2026-07-21T00:00:00.000Z', '')).toThrow();
    });

    it('throws when "from" falls on a UTC calendar day after "to"', () => {
      expect(() => eventPrefixes('2026-07-22T00:00:00.000Z', '2026-07-21T23:59:59.999Z')).toThrow();
    });
  });

  describe('MAX_RANGE_DAYS ceiling — protects against unbounded allocation', () => {
    // [review round 1, silent-failure-hunter finding] an unbounded range
    // (e.g. an operator typo swapping the century) would otherwise
    // allocate tens of millions of prefix strings and hang with no
    // diagnosable error. 3,660 is MAX_RANGE_DAYS's own value in keys.ts
    // (10 UTC calendar years, accounting for leap days) — hardcoded here
    // rather than imported, matching this codebase's own convention for
    // boundary constants (see apps/worker/src/env.test.ts's own literal
    // "500" for EVENT_BATCH_SIZE's upper bound).
    const MAX_RANGE_DAYS = 3660;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const FROM = '2016-07-21T00:00:00.000Z';

    function toDate(daysAfterFrom: number): string {
      return new Date(new Date(FROM).getTime() + daysAfterFrom * ONE_DAY_MS).toISOString();
    }

    it('does not throw at exactly the MAX_RANGE_DAYS boundary', () => {
      const to = toDate(MAX_RANGE_DAYS - 1);

      const prefixes = eventPrefixes(FROM, to);

      expect(prefixes).toHaveLength(MAX_RANGE_DAYS * HOURS_PER_DAY);
    });

    it('throws just one day past the MAX_RANGE_DAYS boundary', () => {
      const to = toDate(MAX_RANGE_DAYS);

      expect(() => eventPrefixes(FROM, to)).toThrow(/exceeds the 3660-day maximum/);
    });

    it('throws for a pathologically wide range (wrong-century operator typo) with a diagnosable message, rather than allocating tens of millions of prefixes', () => {
      expect(() => eventPrefixes('0001-01-01T00:00:00.000Z', '9999-12-31T00:00:00.000Z')).toThrow(
        /exceeds the 3660-day maximum/
      );
    });
  });
});
