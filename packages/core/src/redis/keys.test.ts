import { describe, expect, it } from 'vitest';
import { formatUtcDate, handleKey, linkKey, saltKey } from './keys';
import { withPinnedTz } from './test-support';

// T2.1.3 — keys.ts is the ONE place every Redis key string in Posta's
// keyspace (spec §9) gets built. These tests assert the exact formats
// binding this task: `link:{tenant}:{slug}`, `handle:{handle}`,
// `salt:YYYY-MM-DD` — never the SQL injection-style checks used against
// untrusted input, since these builders are deliberately not the
// validation layer (see keys.ts's own header comment).
//
// withPinnedTz moved out to ./test-support.ts (T2.3.6): salt.test.ts needs
// the SAME positive-offset TZ pin this file's own two "diverges from local
// time" tests use below, for the identical reason (see that file's own doc
// comment). It was previously a local, unexported function here; importing
// it from a sibling *.test.ts file would re-execute this file's own
// describe/it blocks a second time inside salt.test.ts's module graph
// (each Vitest test file gets its own isolated module registry, so a
// static import of another test file re-runs its top-level code, including
// every describe() call in it) — so the shared helper lives in a plain,
// non-test-suffixed module instead, the same way
// apps/api/src/redirect/resolve-test-support.ts holds shared fixtures for
// that folder's test files without being a test file itself.

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

  it('uses the UTC date, not local time, when the local calendar day would differ', () => {
    // Pinned to Europe/Berlin (see withPinnedTz's own comment for why a
    // positive offset is required) — 23:30 UTC on Jan 5 is already Jan 6
    // there. A regression back to getFullYear()/getMonth()/getDate()
    // would return '2026-01-06' under this pin; this is the exact bug the
    // brief warns about: a local-time slip would rotate the salt at the
    // wrong instant and split one UTC day's visitor hashes across two
    // salts.
    withPinnedTz('Europe/Berlin', () => {
      expect(formatUtcDate(new Date('2026-01-05T23:30:00.000Z'))).toBe('2026-01-05');
    });
  });
});

describe('saltKey (T2.1.3)', () => {
  it('builds "salt:YYYY-MM-DD" from a Date, on the UTC calendar day', () => {
    expect(saltKey(new Date('2026-07-24T12:00:00.000Z'))).toBe('salt:2026-07-24');
  });

  it('uses the UTC date even under a local timezone where the calendar day would differ', () => {
    // Same Europe/Berlin pin as formatUtcDate's analogous test above —
    // see withPinnedTz's comment for why a positive offset is required.
    withPinnedTz('Europe/Berlin', () => {
      expect(saltKey(new Date('2026-01-05T23:30:00.000Z'))).toBe('salt:2026-01-05');
    });
  });

  it('matches formatUtcDate exactly, so the two never drift apart', () => {
    const date = new Date('2026-03-15T08:00:00.000Z');
    expect(saltKey(date)).toBe(`salt:${formatUtcDate(date)}`);
  });
});
