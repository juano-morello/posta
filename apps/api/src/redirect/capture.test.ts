import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readSignals, type CaptureRequest, type HeaderSignals } from './capture';

// T2.3.2 — readSignals(req) reads the 16 spec §5.1 header-derived
// signals by explicit name, NEVER by spreading or iterating req.headers.
// That is invariant 6's enforcement at the read boundary: a spread would
// silently drag `cookie`, `x-forwarded-for` and `cf-connecting-ip` into
// the payload the first time the return type widens. Every test below
// that plants an unrelated header (cookie, x-forwarded-for,
// cf-connecting-ip, an arbitrary future header) and then asserts the
// FULL key set or the FULL serialised payload is the regression guard
// for that property — a test that only checked "the four prefetch tells
// are present" would pass even if readSignals also leaked a cookie
// alongside them, which is exactly the gap `toEqual` against a complete
// object (rather than `toMatchObject`) closes.

const HOST = 'juano.example.test';

/** The 16 §5.1 header-derived signal keys, sorted — reused everywhere
 * this file needs to assert readSignals returns EXACTLY this key set
 * and nothing more. */
const EXPECTED_SIGNAL_KEYS = [
  'accept',
  'accept_language',
  'http_method',
  'purpose',
  'referer',
  'sec_ch_ua',
  'sec_ch_ua_mobile',
  'sec_ch_ua_platform',
  'sec_fetch_dest',
  'sec_fetch_mode',
  'sec_fetch_site',
  'sec_fetch_user',
  'sec_purpose',
  'user_agent',
  'x_moz',
  'x_purpose',
].sort();

/** Every signal explicitly null — the baseline every "only X is set"
 * test below overrides via spread, so a missing key in a test's
 * expectation is a copy-paste bug this catches, not a silent gap. */
const ALL_NULL_SIGNALS: HeaderSignals = {
  http_method: null,
  user_agent: null,
  referer: null,
  accept: null,
  accept_language: null,
  sec_fetch_site: null,
  sec_fetch_mode: null,
  sec_fetch_dest: null,
  sec_fetch_user: null,
  sec_purpose: null,
  sec_ch_ua: null,
  sec_ch_ua_mobile: null,
  sec_ch_ua_platform: null,
  purpose: null,
  x_purpose: null,
  x_moz: null,
};

describe('readSignals — the S2.3 mandatory cases', () => {
  it('a request carrying only Host yields every signal null', () => {
    const req: CaptureRequest = { headers: { host: HOST } };

    expect(readSignals(req)).toEqual(ALL_NULL_SIGNALS);
  });

  it('a HEAD request with x-moz/purpose/sec-purpose yields EXACTLY those four set — everything else null', () => {
    const req: CaptureRequest = {
      method: 'HEAD',
      headers: {
        host: HOST,
        'x-moz': 'prefetch',
        purpose: 'prefetch',
        'sec-purpose': 'prefetch',
      },
    };

    // toEqual against a COMPLETE object (not toMatchObject on the four)
    // is what proves "exactly those four" rather than merely "those four
    // among possibly others".
    expect(readSignals(req)).toEqual({
      ...ALL_NULL_SIGNALS,
      http_method: 'HEAD',
      x_moz: 'prefetch',
      purpose: 'prefetch',
      sec_purpose: 'prefetch',
    });
  });

  it('a request carrying a Cookie header yields a payload with no cookie value anywhere', () => {
    const req: CaptureRequest = {
      method: 'GET',
      headers: { host: HOST, cookie: 'session=TOP_SECRET_SESSION_TOKEN; other=x' },
    };

    const signals = readSignals(req);

    // Serialised, not just key names: a cookie smuggled into some OTHER
    // field's value (not just a literal `cookie` key) must be caught too.
    expect(JSON.stringify(signals)).not.toContain('TOP_SECRET_SESSION_TOKEN');
    expect(Object.keys(signals)).not.toContain('cookie');
  });
});

describe('readSignals — IP headers never appear anywhere in the payload', () => {
  // This is the specific regression T2.3.2's brief calls out: the
  // failure a future `{ ...req.headers }` would cause. A distinctive,
  // grep-able IP octet string makes it unambiguous WHAT would have
  // leaked if this test ever went red.
  const DISTINCTIVE_IP = '203.0.113.77';

  it('an X-Forwarded-For header leaves no trace, serialised', () => {
    const req: CaptureRequest = {
      method: 'GET',
      headers: { host: HOST, 'x-forwarded-for': DISTINCTIVE_IP },
    };

    const signals = readSignals(req);

    expect(JSON.stringify(signals)).not.toContain(DISTINCTIVE_IP);
    expect(Object.keys(signals).sort()).toEqual(EXPECTED_SIGNAL_KEYS);
  });

  it('a CF-Connecting-IP header leaves no trace, serialised', () => {
    const req: CaptureRequest = {
      method: 'GET',
      headers: { host: HOST, 'cf-connecting-ip': DISTINCTIVE_IP },
    };

    const signals = readSignals(req);

    expect(JSON.stringify(signals)).not.toContain(DISTINCTIVE_IP);
    expect(Object.keys(signals).sort()).toEqual(EXPECTED_SIGNAL_KEYS);
  });

  it('never leaks an unlisted header — the guard a future `...req.headers` spread would trip', () => {
    const req: CaptureRequest = {
      method: 'GET',
      headers: {
        host: HOST,
        cookie: 'session=abc',
        'x-forwarded-for': DISTINCTIVE_IP,
        'cf-connecting-ip': DISTINCTIVE_IP,
        'x-some-header-nobody-named-here-yet': 'surprise',
      },
    };

    const signals = readSignals(req);

    expect(Object.keys(signals).sort()).toEqual(EXPECTED_SIGNAL_KEYS);
  });
});

describe('readSignals — absence, empty values, and repeated headers', () => {
  it('an empty-string header value is preserved as "" (present-but-empty is not absent)', () => {
    // The header was actually sent — that is different evidence from
    // never sending it — so it must NOT collapse into the same `null`
    // an absent header produces. CaptureEventSchema's zNullableSignal
    // (z.string().nullable(), no .min(1)) accepts '' for exactly this
    // reason.
    const req: CaptureRequest = { method: 'GET', headers: { host: HOST, accept: '' } };

    expect(readSignals(req).accept).toBe('');
  });

  it('takes the first value when a header arrives as an array, rather than joining or throwing', () => {
    // TypeScript's IncomingHttpHeaders allows string[] for any header
    // not on Node's short explicit list (via its index signature) — in
    // real traffic these specific headers are never legitimately sent
    // twice, but the code must still make a deliberate choice rather
    // than crash. The FIRST value is kept, mirroring the behavior Node
    // itself uses for the handful of headers it deduplicates outright,
    // and specifically to avoid a comma-join silently turning two
    // CONFLICTING values into a string that means neither original one.
    const req: CaptureRequest = {
      method: 'GET',
      headers: { host: HOST, 'sec-purpose': ['prefetch', 'anonymous-client-ip'] },
    };

    expect(readSignals(req).sec_purpose).toBe('prefetch');
  });

  it('an empty array-valued header falls back to null rather than throwing', () => {
    const req: CaptureRequest = { method: 'GET', headers: { host: HOST, 'sec-purpose': [] } };

    expect(readSignals(req).sec_purpose).toBeNull();
  });
});

describe('readSignals — header-name case (real Node normalization, not a mock)', () => {
  // A hardcoded lowercase key in a literal test object (headers: {
  // 'user-agent': ... }) would prove nothing about case-insensitivity —
  // of course reading headers['user-agent'] returns headers['user-agent'].
  // The genuine claim is that Node's OWN http parser lowercases every
  // incoming header name before this code ever runs, so readSignals
  // never needs to re-fold case itself. Proving that needs a REAL
  // request through Node's real parser, not a hand-built object —
  // mirrors middleware.test.ts's own http.request-based approach one
  // directory up.
  it('reads headers sent in mixed case, because Node normalizes incoming header names to lowercase', async () => {
    let captured: HeaderSignals | undefined;
    const server = http.createServer((req, res) => {
      captured = readSignals(req);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/',
            headers: { 'User-Agent': 'Mixed-Case-UA/1.0', 'X-Moz': 'prefetch' },
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        );
        request.on('error', reject);
        request.end();
      });
    } finally {
      server.close();
    }

    expect(captured?.user_agent).toBe('Mixed-Case-UA/1.0');
    expect(captured?.x_moz).toBe('prefetch');
  });
});
