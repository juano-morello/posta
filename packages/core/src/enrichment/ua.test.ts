import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseUserAgent } from './ua';

// T3.2.1 (E3, S3.2) — parseUserAgent() is the null-safe ua-parser-js wrapper
// the worker's enrichment step (a later E3 task) will call with the raw
// User-Agent header off every captured event. This suite's own job is
// narrow: prove the function NEVER throws — not on a real browser UA, not
// on a bot UA, not on null/empty/pathological garbage — and that it never
// invents a fact it can't back up (invariant 4: browser/os/device_type are
// FACTS ua-parser-js actually reported, never a computed bot/human verdict).

const ALL_NULL = { browser: null, browser_version: null, os: null, device_type: null } as const;

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
// Real-world Instagram in-app browser UA: an iPhone/Safari-shaped string
// with "Instagram" embedded as a substring, plus the app's own version tag.
const INSTAGRAM_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.114 (iPhone14,3; iOS 17_4; en_US; en-US; scale=3.00; 1284x2778; 498540814)';
// Facebook's link-unfurling bot: a short, non-browser-shaped UA.
const FACEBOOK_EXTERNAL_HIT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
// 4 KB of raw random bytes decoded as latin1 (one byte -> one UTF-16 code
// unit, so every value 0x00-0xFF round-trips to a valid, if garbage, JS
// string) — proves no crash and no ReDoS-style hang on pathological input.
const GARBAGE_UA = randomBytes(4096).toString('latin1');

interface UaTestCase {
  readonly name: string;
  readonly ua: string | null;
  readonly expectAllNull?: boolean;
}

const cases: readonly UaTestCase[] = [
  { name: 'a real desktop Chrome UA', ua: DESKTOP_CHROME_UA },
  { name: 'a real iOS Safari UA', ua: IOS_SAFARI_UA },
  { name: 'the Instagram in-app browser UA', ua: INSTAGRAM_IN_APP_UA },
  { name: "Facebook's link-unfurling bot UA (facebookexternalhit)", ua: FACEBOOK_EXTERNAL_HIT_UA },
  { name: 'null', ua: null, expectAllNull: true },
  { name: 'the empty string', ua: '', expectAllNull: true },
  { name: 'a 4 KB block of binary garbage', ua: GARBAGE_UA, expectAllNull: true },
];

describe('parseUserAgent (T3.2.1)', () => {
  it.each(cases)('never throws for $name', ({ ua }) => {
    expect(() => parseUserAgent(ua)).not.toThrow();
  });

  it.each(cases.filter((testCase) => testCase.expectAllNull))(
    'returns an all-null result for $name',
    ({ ua }) => {
      expect(parseUserAgent(ua)).toEqual(ALL_NULL);
    },
  );

  // "Never throws + all-null on garbage" alone wouldn't catch a regression
  // that zeroed out every field unconditionally — these pin the positive
  // path: real UAs must still yield real facts.
  it('extracts browser/os facts and device_type "desktop" for a real desktop Chrome UA', () => {
    expect(parseUserAgent(DESKTOP_CHROME_UA)).toEqual({
      browser: 'Chrome',
      browser_version: '125.0.0.0',
      os: 'Windows',
      device_type: 'desktop',
    });
  });

  it('extracts browser/os facts and device_type "mobile" for a real iOS Safari UA', () => {
    expect(parseUserAgent(IOS_SAFARI_UA)).toEqual({
      browser: 'Mobile Safari',
      browser_version: '17.4',
      os: 'iOS',
      device_type: 'mobile',
    });
  });

  it('normalises device_type to "mobile" for the Instagram in-app browser UA', () => {
    // ua-parser-js identifies the underlying device (an iPhone) regardless
    // of the in-app browser layered on top, so this stays 'mobile' rather
    // than falling back to null or some 'inapp'-flavored fourth bucket.
    const result = parseUserAgent(INSTAGRAM_IN_APP_UA);

    expect(result.device_type).toBe('mobile');
    expect(result.os).toBe('iOS');
  });

  it('is pure: the same input yields the same output on repeated calls', () => {
    expect(parseUserAgent(DESKTOP_CHROME_UA)).toEqual(parseUserAgent(DESKTOP_CHROME_UA));
    expect(parseUserAgent(GARBAGE_UA)).toEqual(parseUserAgent(GARBAGE_UA));
  });

  it('never returns an is_bot or similar verdict field (invariant 4)', () => {
    const result = parseUserAgent(FACEBOOK_EXTERNAL_HIT_UA);

    expect(Object.keys(result).sort()).toEqual(['browser', 'browser_version', 'device_type', 'os']);
  });
});
