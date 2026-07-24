import { describe, expect, it } from 'vitest';
import { formatUtcDate, handleKey, linkKey, saltKey } from './keys';

// T2.1.3 — keys.ts is the ONE place every Redis key string in Posta's
// keyspace (spec §9) gets built. These tests assert the exact formats
// binding this task: `link:{tenant}:{slug}`, `handle:{handle}`,
// `salt:YYYY-MM-DD` — never the SQL injection-style checks used against
// untrusted input, since these builders are deliberately not the
// validation layer (see keys.ts's own header comment).

describe('linkKey (T2.1.3)', () => {
  it('builds "link:{tenant}:{slug}"', () => {
    expect(linkKey('01JABCDEF0123456789ABCDEF', 'promo')).toBe(
      'link:01JABCDEF0123456789ABCDEF:promo',
    );
  });

  it('keeps tenant and slug as distinct segments, not concatenated', () => {
    // Two different (tenant, slug) pairs that would collide if the
    // separator were dropped must still produce different keys.
    expect(linkKey('ab', 'cd')).not.toBe(linkKey('a', 'bcd'));
  });
});

describe('handleKey (T2.1.3)', () => {
  it('builds "handle:{handle}"', () => {
    expect(handleKey('juano')).toBe('handle:juano');
  });
});

describe('formatUtcDate (T2.1.3)', () => {
  it('formats a Date as YYYY-MM-DD on the UTC calendar day', () => {
    expect(formatUtcDate(new Date('2026-07-24T12:00:00.000Z'))).toBe('2026-07-24');
  });

  it('pads single-digit months and days with a leading zero', () => {
    expect(formatUtcDate(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-05');
  });

  it('uses the UTC date, not local time, when they fall on different days', () => {
    // 23:30 UTC on Jan 5 is already Jan 6 in timezones ahead of UTC (e.g.
    // UTC+1) and still Jan 5 in timezones behind UTC (e.g. UTC-5) — the
    // formatted string must be the SAME regardless of the machine's local
    // timezone, because it is read via getUTC* accessors, never
    // getFullYear()/getMonth()/getDate(). This is the exact bug the brief
    // warns about: a local-time slip would rotate the salt at the wrong
    // instant and split one UTC day's visitor hashes across two salts.
    expect(formatUtcDate(new Date('2026-01-05T23:30:00.000Z'))).toBe('2026-01-05');
  });
});

describe('saltKey (T2.1.3)', () => {
  it('builds "salt:YYYY-MM-DD" from a Date, on the UTC calendar day', () => {
    expect(saltKey(new Date('2026-07-24T12:00:00.000Z'))).toBe('salt:2026-07-24');
  });

  it('uses the UTC date even when local time would fall on a different day', () => {
    expect(saltKey(new Date('2026-01-05T23:30:00.000Z'))).toBe('salt:2026-01-05');
  });

  it('matches formatUtcDate exactly, so the two never drift apart', () => {
    const date = new Date('2026-03-15T08:00:00.000Z');
    expect(saltKey(date)).toBe(`salt:${formatUtcDate(date)}`);
  });
});
