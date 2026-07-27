import { describe, expect, it } from 'vitest';
import { IN_APP_MARKERS, isInApp } from './source-platform';

// T3.2.2 (E3, S3.2) — isInApp() flags a User-Agent as coming from an
// in-app (embedded webview) browser rather than a full standalone browser.
// It reports a FACT — "one of the known marker substrings was present in
// this UA string" — never a bot/human verdict (invariant 4): there is no
// isBot field here, and there never should be.
//
// IN_APP_MARKERS is exported (not inlined into isInApp) because T3.2.3
// (source_platform resolver, a later task living in this SAME file) reads
// the identical list to decide source_platform from referer-then-UA. A
// second, separately maintained copy of these six strings would risk
// drifting from this one — the plan calls out exactly that failure mode:
// an event that is is_in_app: true with source_platform: 'directo'.

// Realistic embedded-substring UAs, not the bare marker alone — proves
// substring matching, not exact-equality.
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

interface InAppTestCase {
  readonly name: string;
  readonly ua: string;
}

const inAppCases: readonly InAppTestCase[] = [
  { name: 'the Instagram in-app browser UA (Instagram marker)', ua: INSTAGRAM_IN_APP_UA },
  { name: "Facebook's iOS in-app browser UA (FBAN marker)", ua: FBAN_IN_APP_UA },
  { name: "Facebook's Android in-app browser UA (FBAV marker)", ua: FBAV_IN_APP_UA },
  { name: 'the TikTok in-app browser UA (TikTok marker)', ua: TIKTOK_IN_APP_UA },
  { name: 'a ByteDance webview UA (BytedanceWebview marker)', ua: BYTEDANCE_WEBVIEW_UA },
  { name: 'the LINE in-app browser UA (Line marker)', ua: LINE_IN_APP_UA },
];

describe('IN_APP_MARKERS (T3.2.2)', () => {
  it('has exactly 6 entries', () => {
    expect(IN_APP_MARKERS.length).toBe(6);
  });

  it('is exactly the six known in-app markers, so a future accidental addition or removal is caught', () => {
    expect([...IN_APP_MARKERS].sort()).toEqual(
      ['BytedanceWebview', 'FBAN', 'FBAV', 'Instagram', 'Line', 'TikTok'].sort(),
    );
  });
});

describe('isInApp (T3.2.2)', () => {
  it.each(inAppCases)('returns true for $name', ({ ua }) => {
    expect(isInApp(ua)).toBe(true);
  });

  it('returns false for a plain desktop Chrome UA with no markers', () => {
    expect(isInApp(DESKTOP_CHROME_UA)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isInApp(null)).toBe(false);
  });

  it('never returns an isBot or similar verdict field (invariant 4): the function itself only returns a boolean fact', () => {
    expect(typeof isInApp(INSTAGRAM_IN_APP_UA)).toBe('boolean');
  });
});
