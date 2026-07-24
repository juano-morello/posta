import { describe, expect, it } from 'vitest';
import { isUlid, newId } from './ulid';

// T1.1.3 — newId() is the ONE place a Posta id is generated. IDs are
// created in application code and stored as `text`, never a database
// default (see CLAUDE.md) — so the same id is available before the
// insert, and can be logged/queued/retried before the row exists.

describe('newId (T1.1.3)', () => {
  it('returns a 26-char Crockford ULID', () => {
    const id = newId();

    expect(id).toHaveLength(26);
    // Crockford base32: 0-9, A-Z minus the visually-ambiguous I L O U.
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('two ids generated in sequence sort lexicographically by creation order', () => {
    const first = newId();
    const second = newId();

    expect(first < second).toBe(true);
  });

  it('stays monotonic even across many ids generated within the same millisecond', () => {
    const ids = Array.from({ length: 100 }, () => newId());
    const lexicographicallySorted = [...ids].sort();

    expect(ids).toEqual(lexicographicallySorted);
  });
});

describe('isUlid (T1.1.3)', () => {
  it('accepts a real generated id', () => {
    expect(isUlid(newId())).toBe(true);
  });

  it('rejects a UUID', () => {
    expect(isUlid('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('rejects a string one char short of a valid ULID', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false); // 25 chars
  });

  it('rejects the empty string', () => {
    expect(isUlid('')).toBe(false);
  });
});
