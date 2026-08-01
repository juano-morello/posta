import { describe, expect, it, vi } from 'vitest';
import { newId } from '../ulid';
import { eventBatchKey } from './keys';

// T3.4.3 (E3, S3.4) [INV-7] — eventBatchKey() is the partitioned R2 key
// scheme for the NDJSON writer (T3.4.2's serializeBatch() output) that a
// later task PUTs under this key. Every assertion here protects the ONE
// property that actually matters for invariant 7 (R2 as the rebuildable
// source of truth): the partition a São Paulo (or any -HH:MM) timestamp
// lands in must be its UTC instant, never a naive slice of the input
// string's own hour/date digits — see this file's own "crossing midnight"
// describe block below for the test that would fail first if someone
// "simplified" the implementation into a string slice.

describe('eventBatchKey (T3.4.3)', () => {
  it('produces the exact verify-example key: 2026-07-21T02:30:00-03:00 (São Paulo) → dt=2026-07-21/hour=05', () => {
    const batchId = newId();

    const key = eventBatchKey(batchId, '2026-07-21T02:30:00-03:00');

    expect(key).toBe(`events/dt=2026-07-21/hour=05/${batchId}.ndjson`);
  });

  describe('zero-padding', () => {
    it('zero-pads a single-digit UTC month, day, and hour (2026-01-05T03:07:00Z → dt=2026-01-05/hour=03)', () => {
      const batchId = newId();

      const key = eventBatchKey(batchId, '2026-01-05T03:07:00Z');

      expect(key).toBe(`events/dt=2026-01-05/hour=03/${batchId}.ndjson`);
    });

    it('zero-pads a single-digit UTC hour even when month/day are already two digits (2026-11-09T09:15:00Z → dt=2026-11-09/hour=09)', () => {
      const batchId = newId();

      const key = eventBatchKey(batchId, '2026-11-09T09:15:00Z');

      expect(key).toBe(`events/dt=2026-11-09/hour=09/${batchId}.ndjson`);
    });

    it('never zero-pads a two-digit hour (2026-07-21T23:00:00Z → hour=23, not hour=023)', () => {
      const batchId = newId();

      const key = eventBatchKey(batchId, '2026-07-21T23:00:00Z');

      expect(key).toBe(`events/dt=2026-07-21/hour=23/${batchId}.ndjson`);
    });
  });

  describe('UTC conversion, not a string slice of the input', () => {
    it('a -03:00 timestamp just before local midnight partitions into the NEXT UTC day and an early UTC hour (2026-07-20T23:45:00-03:00 → dt=2026-07-21/hour=02, never dt=2026-07-20/hour=23)', () => {
      const batchId = newId();

      const key = eventBatchKey(batchId, '2026-07-20T23:45:00-03:00');

      // Local (São Paulo) reading of this timestamp is 2026-07-20 23:45 —
      // a naive slice of the input string's own YYYY-MM-DD/HH digits would
      // produce dt=2026-07-20/hour=23. The genuine UTC instant is
      // 2026-07-21T02:45:00Z, one calendar day and a different hour later.
      expect(key).toBe(`events/dt=2026-07-21/hour=02/${batchId}.ndjson`);
      expect(key).not.toContain('dt=2026-07-20');
      expect(key).not.toContain('hour=23');
    });

    it('a +09:00 timestamp just after local midnight partitions into the PREVIOUS UTC day (2026-03-01T00:30:00+09:00 → dt=2026-02-28/hour=15)', () => {
      const batchId = newId();

      const key = eventBatchKey(batchId, '2026-03-01T00:30:00+09:00');

      // Local (Tokyo) reading is already March 1st; the UTC instant
      // (2026-02-28T15:30:00Z) is still the last hour of February 28th —
      // the opposite-direction crossing from the São Paulo case above.
      expect(key).toBe(`events/dt=2026-02-28/hour=15/${batchId}.ndjson`);
    });

    it('a plain Z (UTC) timestamp needs no conversion and matches its own digits', () => {
      const batchId = newId();

      const key = eventBatchKey(batchId, '2026-07-21T05:30:00.000Z');

      expect(key).toBe(`events/dt=2026-07-21/hour=05/${batchId}.ndjson`);
    });
  });

  describe('idempotency and purity — same inputs, same key, every time', () => {
    it('the same batchId and occurredAt produce a byte-identical key across repeated calls (a batch retry must overwrite, never duplicate)', () => {
      const batchId = newId();
      const occurredAt = '2026-07-21T02:30:00-03:00';

      const first = eventBatchKey(batchId, occurredAt);
      const second = eventBatchKey(batchId, occurredAt);
      const third = eventBatchKey(batchId, occurredAt);

      expect(first).toBe(second);
      expect(second).toBe(third);
    });

    it('does not depend on the current wall-clock time (a retry hours later still produces the same key)', () => {
      const batchId = newId();
      const occurredAt = '2026-07-21T02:30:00-03:00';

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
      const keyAtOneFakeNow = eventBatchKey(batchId, occurredAt);

      vi.setSystemTime(new Date('2030-06-15T12:00:00Z'));
      const keyAtAnotherFakeNow = eventBatchKey(batchId, occurredAt);
      vi.useRealTimers();

      expect(keyAtOneFakeNow).toBe(keyAtAnotherFakeNow);
      expect(keyAtOneFakeNow).toBe(`events/dt=2026-07-21/hour=05/${batchId}.ndjson`);
    });

    it('different batchIds for the same occurredAt produce different keys (no collision across concurrent batches in the same hour)', () => {
      const occurredAt = '2026-07-21T02:30:00-03:00';
      const firstBatchId = newId();
      const secondBatchId = newId();

      const firstKey = eventBatchKey(firstBatchId, occurredAt);
      const secondKey = eventBatchKey(secondBatchId, occurredAt);

      expect(firstKey).not.toBe(secondKey);
      expect(firstKey).toContain(firstBatchId);
      expect(secondKey).toContain(secondBatchId);
    });
  });

  describe('invalid input', () => {
    it('throws a diagnosable error for an occurredAt that is not a parseable timestamp, rather than emitting a key with literal "NaN" segments', () => {
      const batchId = newId();

      expect(() => eventBatchKey(batchId, 'not-a-timestamp')).toThrow();
    });

    it('throws for an empty-string occurredAt', () => {
      const batchId = newId();

      expect(() => eventBatchKey(batchId, '')).toThrow();
    });
  });
});
