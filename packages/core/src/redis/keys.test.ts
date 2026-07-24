import { describe, expect, it } from 'vitest';
import { formatUtcDate, handleKey, linkKey, saltKey } from './keys';

// T2.1.3 — keys.ts is the ONE place every Redis key string in Posta's
// keyspace (spec §9) gets built. These tests assert the exact formats
// binding this task: `link:{tenant}:{slug}`, `handle:{handle}`,
// `salt:YYYY-MM-DD` — never the SQL injection-style checks used against
// untrusted input, since these builders are deliberately not the
// validation layer (see keys.ts's own header comment).

/**
 * Runs `fn` with `process.env.TZ` pinned to `tz`, restoring the original
 * value (or its absence) afterward — same set-then-restore-in-`finally`
 * shape as this file's sibling `client.test.ts` uses for env vars.
 *
 * Used only by the two "diverges from local time" tests below, and
 * specifically with a POSITIVE UTC offset (`Europe/Berlin`): 23:30 UTC on
 * Jan 5 only rolls over to the NEXT local calendar day (Jan 6) in a
 * timezone ahead of UTC. This repo's CI runs on `ubuntu-latest` with no
 * `TZ` override (defaults to UTC) and this repo's own dev sandbox runs
 * `America/Buenos_Aires` (UTC-3) — in BOTH of those, that same instant is
 * still "Jan 5" whether read via `getUTC*()` or the local
 * `getFullYear()`/`getMonth()`/`getDate()` equivalents, so an assertion
 * that only relies on the environment's ambient timezone would pass
 * identically under a regressed local-getter implementation. Pinning a
 * positive offset is what forces the two to actually disagree.
 */
function withPinnedTz<T>(tz: string, fn: () => T): T {
  const originalTz = process.env.TZ;
  process.env.TZ = tz;

  try {
    return fn();
  } finally {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  }
}

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
