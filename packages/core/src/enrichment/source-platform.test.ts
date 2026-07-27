import { describe, expect, it } from 'vitest';
import { resolveSourcePlatform } from './source-platform';

// T3.2.3 (E3, S3.2) — resolveSourcePlatform() names which known platform a
// captured hit's signals point to: referer host is checked FIRST (the
// stronger signal — survives UA spoofing, works in any browser, not just
// embedded webviews), falling back to T3.2.2's in-app UA markers, then
// 'directo'. This is a descriptive fact (invariant 4), never a bot/human
// verdict — there is no isBot field anywhere near this function and there
// never should be.

// Realistic in-app UAs (embedded substrings, not the bare marker alone),
// matching is-in-app.test.ts's own fixtures so the two suites stay
// consistent about what a "real" marker UA looks like.
const INSTAGRAM_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.114 (iPhone14,3; iOS 17_4; en_US; en-US; scale=3.00; 1284x2778; 498540814)';
const FBAN_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.42.109;FBBV/558450123;FBDV/iPhone14,3;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/en_US]';
const FBAV_IN_APP_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.42.109;]';
const TIKTOK_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_36.5.4 TikTok 36.5.4 rv:365405 (iPhone; iOS 17.4; en_US)';
const BYTEDANCE_WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36 BytedanceWebview/d8a21c6';
const LINE_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/13.20.0';
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

interface RefererCase {
  readonly name: string;
  readonly referer: string;
  readonly expected: string;
}

// Verify-mandated cases (l.instagram.com, t.co, twitter.com,
// lm.facebook.com) plus WhatsApp's two realistic referer signals and
// TikTok's own domain, all as full Referer-header-shaped URLs.
const refererCases: readonly RefererCase[] = [
  { name: "Instagram's l.instagram.com link-shim host", referer: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com', expected: 'instagram' },
  { name: "Twitter/X's t.co shortener host", referer: 'https://t.co/aBcDeFgHiJ', expected: 'x' },
  { name: 'the legacy twitter.com host', referer: 'https://twitter.com/somehandle/status/123', expected: 'x' },
  { name: "Facebook's lm.facebook.com link-shim host", referer: 'https://lm.facebook.com/l.php?u=https%3A%2F%2Fexample.com', expected: 'facebook' },
  { name: 'the WhatsApp Web host', referer: 'https://web.whatsapp.com/', expected: 'whatsapp' },
  {
    name: "Android Custom Tabs' EXTRA_REFERRER convention (android-app://com.whatsapp) for WhatsApp",
    referer: 'android-app://com.whatsapp',
    expected: 'whatsapp',
  },
  { name: "TikTok's own domain", referer: 'https://www.tiktok.com/@someone/video/123', expected: 'tiktok' },
];

describe('resolveSourcePlatform — referer host is checked first (T3.2.3)', () => {
  it.each(refererCases)('resolves $name to $expected', ({ referer, expected }) => {
    expect(resolveSourcePlatform(referer, null)).toBe(expected);
  });

  it('prefers a matching referer host over a conflicting UA marker, because referer is the stronger signal', () => {
    expect(resolveSourcePlatform('https://l.instagram.com/', TIKTOK_IN_APP_UA)).toBe('instagram');
  });
});

describe('resolveSourcePlatform — falls back to UA markers when referer is absent or unrecognized (T3.2.3)', () => {
  it('resolves a null referer with the Instagram in-app UA to instagram', () => {
    expect(resolveSourcePlatform(null, INSTAGRAM_IN_APP_UA)).toBe('instagram');
  });

  it('resolves a null referer with the FBAN in-app UA to facebook', () => {
    expect(resolveSourcePlatform(null, FBAN_IN_APP_UA)).toBe('facebook');
  });

  it('resolves a null referer with the FBAV in-app UA to facebook', () => {
    expect(resolveSourcePlatform(null, FBAV_IN_APP_UA)).toBe('facebook');
  });

  it('resolves a null referer with the TikTok in-app UA to tiktok', () => {
    expect(resolveSourcePlatform(null, TIKTOK_IN_APP_UA)).toBe('tiktok');
  });

  it('falls back to the UA marker when the referer host is unrecognized', () => {
    expect(resolveSourcePlatform('https://news.example.com/article', INSTAGRAM_IN_APP_UA)).toBe('instagram');
  });
});

describe("resolveSourcePlatform — falls back to 'directo' (T3.2.3)", () => {
  it('returns directo for a null referer and a null UA', () => {
    expect(resolveSourcePlatform(null, null)).toBe('directo');
  });

  it('returns directo for an unrecognized referer host paired with a plain desktop UA', () => {
    expect(resolveSourcePlatform('https://news.example.com/article', DESKTOP_CHROME_UA)).toBe('directo');
  });

  it('returns directo for a BytedanceWebview UA marker — it names some ByteDance-family webview, not specifically TikTok', () => {
    expect(resolveSourcePlatform(null, BYTEDANCE_WEBVIEW_UA)).toBe('directo');
  });

  it('returns directo for a LINE in-app UA marker — LINE has no corresponding member in the return union', () => {
    expect(resolveSourcePlatform(null, LINE_IN_APP_UA)).toBe('directo');
  });

  it('returns directo for an unparseable referer string with no matching UA marker either', () => {
    expect(resolveSourcePlatform('not a url', DESKTOP_CHROME_UA)).toBe('directo');
  });

  it('returns directo for an empty-string referer and a null UA', () => {
    expect(resolveSourcePlatform('', null)).toBe('directo');
  });
});

describe('resolveSourcePlatform — never returns a verdict (invariant 4)', () => {
  it('always returns a plain string, never an object with an isBot/verdict-shaped field', () => {
    expect(typeof resolveSourcePlatform(null, INSTAGRAM_IN_APP_UA)).toBe('string');
    expect(typeof resolveSourcePlatform('https://l.instagram.com/', null)).toBe('string');
    expect(typeof resolveSourcePlatform(null, null)).toBe('string');
  });

  it('only ever returns one of the six known platform values', () => {
    const knownValues = new Set(['instagram', 'whatsapp', 'tiktok', 'facebook', 'x', 'directo']);
    expect(knownValues.has(resolveSourcePlatform(null, null))).toBe(true);
    expect(knownValues.has(resolveSourcePlatform('https://t.co/x', null))).toBe(true);
    expect(knownValues.has(resolveSourcePlatform(null, FBAN_IN_APP_UA))).toBe(true);
  });
});
