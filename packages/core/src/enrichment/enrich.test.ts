import { describe, expect, it } from 'vitest';
import { enrich } from './enrich';

// T3.2.5 (E3, S3.2) — enrich() is the one place T3.2.1-T3.2.4's four
// FACT-producing functions (parseUserAgent, isInApp, resolveSourcePlatform,
// destHost) get composed together for a real event. Both the worker's live
// flush path (T3.3.2, later) and replay (T3.6.3, much later) call this same
// function so the two paths enrich identically — see enrich.ts's own header
// for why its input is EnrichmentInput, not CaptureEvent verbatim.
//
// Structural test #1 below (`the seven column names, exactly`) is the
// mechanical proof the brief asks for: sorted Object.keys() equality against
// the sorted seven-name array, so an accidental eighth field or a dropped
// field both fail loudly.

const SEVEN_COLUMN_NAMES = [
  'browser',
  'browser_version',
  'device_type',
  'dest_host',
  'is_in_app',
  'os',
  'source_platform',
].sort();

const INSTAGRAM_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.114 (iPhone14,3; iOS 17_4; en_US; en-US; scale=3.00; 1284x2778; 498540814)';

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

describe('enrich (T3.2.5) — return shape', () => {
  it('returns exactly the seven enrichment column names, no more and no fewer', () => {
    const result = enrich({ user_agent: null, referer: null, destination: null });

    expect(Object.keys(result).sort()).toEqual(SEVEN_COLUMN_NAMES);
  });
});

describe('enrich (T3.2.5) — all-null/all-missing input', () => {
  it('never throws on an all-null input', () => {
    expect(() => enrich({ user_agent: null, referer: null, destination: null })).not.toThrow();
  });

  it('returns null for every nullable string field and false for is_in_app', () => {
    const result = enrich({ user_agent: null, referer: null, destination: null });

    expect(result).toEqual({
      browser: null,
      browser_version: null,
      os: null,
      device_type: null,
      source_platform: 'directo',
      is_in_app: false,
      dest_host: null,
    });
  });

  it('treats an empty-string destination the same as a null one (dest_host stays null)', () => {
    const result = enrich({ user_agent: null, referer: null, destination: '' });

    expect(result.dest_host).toBeNull();
  });
});

describe('enrich (T3.2.5) — a realistic, fully-populated hit', () => {
  it('populates all seven fields from a desktop Chrome UA, an Instagram referer, and a real destination', () => {
    const result = enrich({
      user_agent: DESKTOP_CHROME_UA,
      referer: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com',
      destination: 'https://Shop.Example.com:443/promo?utm_source=ig',
    });

    expect(result).toEqual({
      browser: 'Chrome',
      browser_version: '125.0.0.0',
      os: 'Windows',
      device_type: 'desktop',
      source_platform: 'instagram',
      is_in_app: false,
      dest_host: 'shop.example.com',
    });
  });

  it('flags is_in_app true and resolves source_platform from the UA marker when there is no referer', () => {
    const result = enrich({
      user_agent: INSTAGRAM_IN_APP_UA,
      referer: null,
      destination: 'https://example.com/a',
    });

    expect(result.is_in_app).toBe(true);
    expect(result.source_platform).toBe('instagram');
    expect(result.device_type).toBe('mobile');
  });

  it('resolves dest_host to null for a garbage destination without throwing', () => {
    const result = enrich({
      user_agent: DESKTOP_CHROME_UA,
      referer: null,
      destination: 'not a url',
    });

    expect(result.dest_host).toBeNull();
  });
});
