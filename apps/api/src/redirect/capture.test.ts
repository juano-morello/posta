import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CaptureEventSchema } from '@posta/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildCapturePayload,
  computeVisitorHash,
  readClientIp,
  readSignals,
  type CapturePayloadInput,
  type CaptureRequest,
  type ClientIp,
  type HeaderSignals,
} from './capture';

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

// T2.3.7 [INV-6][security] — the client IP is read once, feeds exactly two
// derivations (a geoip lookup, owned by T2.3.5; the salted hash below), and
// is dropped. `readClientIp` returns a BRANDED `ClientIp`, never a plain
// `string`, and `buildCapturePayload` accepts only the values already
// derived FROM an ip, never an ip itself. The describe blocks below prove
// both halves: the hash's own behavior, and — the hard part — that
// `buildCapturePayload`'s signature structurally has no slot a `ClientIp`
// fits, not merely a convention asking callers not to pass one.

const DISTINCTIVE_IP = '203.0.113.77';

describe('readClientIp — CF-Connecting-IP first, else the leftmost X-Forwarded-For entry', () => {
  it('prefers CF-Connecting-IP over X-Forwarded-For when both are present', () => {
    const headers = {
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.5, 10.0.0.1',
    };

    expect(readClientIp(headers)).toBe('203.0.113.10');
  });

  it('falls back to the LEFTMOST X-Forwarded-For entry — not the last, not a join — when CF-Connecting-IP is absent', () => {
    const headers = { 'x-forwarded-for': '198.51.100.5, 10.0.0.1, 10.0.0.2' };

    expect(readClientIp(headers)).toBe('198.51.100.5');
  });

  it('falls back to X-Forwarded-For when CF-Connecting-IP is present but empty — present-but-empty cannot identify a visitor', () => {
    const headers = { 'cf-connecting-ip': '', 'x-forwarded-for': '198.51.100.5' };

    expect(readClientIp(headers)).toBe('198.51.100.5');
  });

  it('returns null when neither header is present', () => {
    expect(readClientIp({})).toBeNull();
  });

  it('returns null rather than an empty string when X-Forwarded-For is present but blank', () => {
    expect(readClientIp({ 'x-forwarded-for': '   ' })).toBeNull();
  });

  // [fix round 1, task review] The whitespace-only case above cannot tell
  // "leftmost is blank -> null" apart from "skip blank entries and use the
  // next one": both implementations return null for '   ', since there is
  // nothing to skip TO. A blank LEADING entry with a real IP after it is
  // the only case that discriminates: this implementation returns null
  // (leftmost really does mean leftmost); a skip-blanks implementation
  // would return '10.0.0.1'. See this file's proof below.
  it('returns null — not the next entry — when the LEFTMOST X-Forwarded-For entry is blank but a later one is a real IP', () => {
    expect(readClientIp({ 'x-forwarded-for': ', 10.0.0.1' })).toBeNull();
  });
});

describe('computeVisitorHash — the S2.3 mandatory cases', () => {
  const ip = readClientIp({ 'cf-connecting-ip': DISTINCTIVE_IP }) as ClientIp;

  it('is 32 lowercase hex characters', () => {
    const hash = computeVisitorHash(ip, 'UA/1.0', 'salt-a');

    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for the same ip + user_agent + salt', () => {
    const first = computeVisitorHash(ip, 'UA/1.0', 'salt-a');
    const second = computeVisitorHash(ip, 'UA/1.0', 'salt-a');

    expect(first).toBe(second);
  });

  it('changes when the user agent changes, salt and ip held fixed', () => {
    const withUaOne = computeVisitorHash(ip, 'UA/1.0', 'salt-a');
    const withUaTwo = computeVisitorHash(ip, 'UA/2.0', 'salt-a');

    expect(withUaOne).not.toBe(withUaTwo);
  });

  it('changes when the salt changes, ip and user agent held fixed', () => {
    const withSaltOne = computeVisitorHash(ip, 'UA/1.0', 'salt-a');
    const withSaltTwo = computeVisitorHash(ip, 'UA/1.0', 'salt-b');

    expect(withSaltOne).not.toBe(withSaltTwo);
  });

  it('changes for two different IPs sharing one user agent — required so "únicos hoy" can distinguish them', () => {
    const ipA = readClientIp({ 'cf-connecting-ip': '203.0.113.1' }) as ClientIp;
    const ipB = readClientIp({ 'cf-connecting-ip': '203.0.113.2' }) as ClientIp;

    const forIpA = computeVisitorHash(ipA, 'UA/1.0', 'salt-a');
    const forIpB = computeVisitorHash(ipB, 'UA/1.0', 'salt-a');

    expect(forIpA).not.toBe(forIpB);
  });
});

/** Calls `fn`, expects it to throw, and returns the thrown Error's own
 * `message` — never the whole error object — so tests below can assert
 * on the message's CONTENT (which field it names, which values it must
 * NOT contain) without repeating a try/catch in every case. Throws
 * itself (failing the test loudly) if `fn` does not throw. */
function messageFrom(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the function under test to throw, but it did not');
}

describe('computeVisitorHash — rejects a delimiter byte in any input [security review, fix round 1]', () => {
  // computeVisitorHash's own collision-avoidance delimiter (see capture.ts)
  // is a NUL byte. This file cannot import the private constant directly,
  // so String.fromCharCode(0) constructs the identical character locally —
  // deliberately NOT a '\u0000' string literal in this file's own source,
  // which risks being written as a raw control byte rather than the
  // 6-character escape sequence by some editing paths.
  const NUL = String.fromCharCode(0);
  const ip = readClientIp({ 'cf-connecting-ip': DISTINCTIVE_IP }) as ClientIp;

  it('throws when ip contains the delimiter; the message names the field, not the ip value or the delimiter itself', () => {
    const poisonedIp = (DISTINCTIVE_IP + NUL + '10.0.0.1') as ClientIp;

    const message = messageFrom(() => computeVisitorHash(poisonedIp, 'UA/1.0', 'salt-a'));

    expect(message).toContain('ip');
    expect(message).not.toContain(DISTINCTIVE_IP);
    expect(message).not.toContain('10.0.0.1');
    expect(message).not.toContain(NUL);
  });

  it("throws when userAgent contains the delimiter; the message names the field, not the user agent's value", () => {
    const poisonedUa = `evil${NUL}ua`;

    const message = messageFrom(() => computeVisitorHash(ip, poisonedUa, 'salt-a'));

    expect(message).toContain('userAgent');
    expect(message).not.toContain(poisonedUa);
    expect(message).not.toContain('evilua');
    expect(message).not.toContain(NUL);
  });

  it('throws when salt contains the delimiter; the message names the field, never the salt value or anything salt-shaped', () => {
    const poisonedSalt = `deadbeefcafebabe${NUL}0011223344556677`;

    const message = messageFrom(() => computeVisitorHash(ip, 'UA/1.0', poisonedSalt));

    expect(message).toContain('salt');
    expect(message).not.toContain(poisonedSalt);
    expect(message).not.toContain('deadbeefcafebabe');
    expect(message).not.toContain('0011223344556677');
    expect(message).not.toContain(NUL);
  });

  it('does NOT throw for ordinary, delimiter-free inputs — the check is specific to the delimiter, not a general failure', () => {
    expect(() => computeVisitorHash(ip, 'UA/1.0', 'salt-a')).not.toThrow();
  });
});

describe('buildCapturePayload — assembly, INV-8 identity assignment, and no residual IP', () => {
  const baseInput: CapturePayloadInput = {
    tenantId: 'tenant-1',
    linkId: 'link-1',
    slug: 'promo',
    signals: ALL_NULL_SIGNALS,
    visitorHash: computeVisitorHash(
      readClientIp({ 'cf-connecting-ip': DISTINCTIVE_IP }) as ClientIp,
      null,
      'salt-a',
    ),
    asn: 15169,
    country: 'AR',
  };

  it('assigns a fresh ULID event_id and an ISO occurred_at on every call [INV-8]', () => {
    const first = buildCapturePayload(baseInput);
    const second = buildCapturePayload(baseInput);

    expect(first.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.event_id).not.toBe(second.event_id);
    expect(new Date(first.occurred_at).toISOString()).toBe(first.occurred_at);
  });

  it("round-trips cleanly through the real CaptureEventSchema — not a hand-built shape assumed to match it", () => {
    const payload = buildCapturePayload(baseInput);

    expect(() => CaptureEventSchema.parse(payload)).not.toThrow();
  });

  it('contains no key matching /ip|addr|forwarded|cookie/i, derived from the payload\'s OWN runtime keys', () => {
    const payload = buildCapturePayload(baseInput);
    const suspiciousKeys = Object.keys(payload).filter((key) => /ip|addr|forwarded|cookie/i.test(key));

    expect(suspiciousKeys).toEqual([]);
  });

  it('never contains the distinctive client IP anywhere in its serialized form, driven through the happy path', () => {
    const ip = readClientIp({ 'cf-connecting-ip': DISTINCTIVE_IP }) as ClientIp;
    const hash = computeVisitorHash(ip, 'Mozilla/5.0 (test)', 'daily-salt-value');

    const payload = buildCapturePayload({
      tenantId: 'tenant-1',
      linkId: 'link-1',
      slug: 'promo',
      signals: { ...ALL_NULL_SIGNALS, user_agent: 'Mozilla/5.0 (test)' },
      visitorHash: hash,
      asn: 15169,
      country: 'AR',
    });

    expect(JSON.stringify(payload)).not.toContain(DISTINCTIVE_IP);
  });

  it('accepts visitorHash: null — no IP was found at all is a real, expected state, not an edge case to special-case away — and still round-trips through CaptureEventSchema', () => {
    const payload = buildCapturePayload({ ...baseInput, visitorHash: null });

    expect(payload.visitor_hash).toBeNull();
    expect(() => CaptureEventSchema.parse(payload)).not.toThrow();
  });
});

describe('buildCapturePayload — the type does not admit an IP [INV-6], not merely a convention', () => {
  it('rejects a ClientIp passed as visitorHash at COMPILE TIME; bypassing that override (as this test deliberately does, to be honest about the boundary) still leaks the raw value at RUNTIME', () => {
    const ip = readClientIp({ 'cf-connecting-ip': DISTINCTIVE_IP }) as ClientIp;

    const input: CapturePayloadInput = {
      tenantId: 'tenant-1',
      linkId: 'link-1',
      slug: 'promo',
      signals: ALL_NULL_SIGNALS,
      // @ts-expect-error — visitorHash must be a VisitorHash minted by
      // computeVisitorHash(); ClientIp is a DIFFERENTLY-branded string
      // type and is not structurally assignable here. This is invariant
      // 6's structural guard: buildCapturePayload's own signature has no
      // slot a ClientIp fits without an override exactly like this one.
      // Checked by `pnpm typecheck:tests` (tsconfig.test.json), which
      // includes this file — NOT by `vitest run`, which transpiles test
      // files with esbuild and never type-checks them. Verified by hand
      // (T2.3.7's own report) that this line genuinely depends on a
      // brand rather than passing vacuously: widening ONLY VisitorHash to
      // plain `string` in capture.ts makes `pnpm typecheck:tests` fail
      // here with "Unused '@ts-expect-error' directive" — a plain string
      // then satisfies `VisitorHash | null` with no error left to
      // suppress. Widening only ClientIp does NOT — VisitorHash's own
      // brand alone is what rejects an unbranded value here, which is why
      // the sibling test below pins ClientIp's brand at ITS actual
      // enforcement point (computeVisitorHash's `ip` parameter) instead.
      visitorHash: ip,
      asn: null,
      country: null,
    };

    // The type system stops a well-behaved caller; nothing stops an
    // explicit cast like the one above, and once bypassed the raw IP
    // flows straight into the payload. The brand raises the cost of a
    // leak and makes the intent to smuggle an IP through visible in a
    // diff — it is not a runtime capability boundary. See this file's
    // header and capture.ts's own header comment.
    expect(buildCapturePayload(input).visitor_hash).toBe(ip);
  });

  it("rejects a plain (unbranded) string passed as computeVisitorHash's ip parameter at COMPILE TIME — ClientIp's own brand pinned at its actual enforcement point", () => {
    const rawHeaderValue: string = DISTINCTIVE_IP; // NOT run through readClientIp

    // @ts-expect-error — computeVisitorHash's `ip` parameter is typed
    // `ClientIp`, not `string`; a plain string (e.g. a header value read
    // some other way, bypassing readClientIp) is not assignable without
    // an explicit cast. This is the enforcement point ClientIp's own
    // brand actually protects — see the sibling test above, which found
    // that VisitorHash's brand alone (not ClientIp's) guards
    // buildCapturePayload's visitorHash slot. Verified by hand: widening
    // ONLY ClientIp to plain `string` in capture.ts makes
    // `pnpm typecheck:tests` fail here with "Unused '@ts-expect-error'
    // directive".
    computeVisitorHash(rawHeaderValue, 'UA/1.0', 'salt-a');
  });
});
