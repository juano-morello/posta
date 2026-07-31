import { describe, expect, it } from 'vitest';
import { CaptureEventSchema, type CaptureEvent } from './capture';
import { SECRET_REDACTION_PLACEHOLDER } from './env';
import { FORBIDDEN_PAYLOAD_KEYS, redactForbiddenKeys } from './redact';

// T3.7.8 [INV-6][security] — the DLQ (T3.7.9, next in this chain) is both
// "stored" and "queued" in Redis, so a malformed capture payload sitting
// there with a raw IP or a raw cookie violates invariant 6 today. This
// suite proves the standalone redactor closes that gap: it does not wire
// into the DLQ (that is T3.7.9's job), it only proves the function is
// correct in isolation.

// A literal copy of T2.3.8's already-enforced regex
// (apps/api/src/redirect/capture-privacy.test.ts, referenced at
// 02-redirect-hot-path.md:168) — NOT an import, since packages/contracts
// must never depend on apps/api. FORBIDDEN_PAYLOAD_KEYS is defined to be a
// superset of what this regex flags; the tests below assert that
// relationship directly rather than assuming it.
const T238_REGEX = /ip|addr|forwarded|cookie/i;

const VALID_CAPTURE_EVENT: CaptureEvent = {
  event_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  occurred_at: '2026-07-26T12:00:00.000Z',
  tenant_id: 'tenant_1',
  link_id: 'link_1',
  slug: 'promo',
  http_method: 'GET',
  user_agent: 'Mozilla/5.0',
  referer: null,
  accept: 'text/html',
  accept_language: 'es-AR',
  sec_fetch_site: 'none',
  sec_fetch_mode: 'navigate',
  sec_fetch_dest: 'document',
  sec_fetch_user: '?1',
  sec_purpose: null,
  sec_ch_ua: null,
  sec_ch_ua_mobile: null,
  sec_ch_ua_platform: null,
  purpose: null,
  x_purpose: null,
  x_moz: null,
  country: 'AR',
  asn: 12345,
  visitor_hash: 'abcd1234abcd1234abcd1234abcd1234',
};

describe('FORBIDDEN_PAYLOAD_KEYS', () => {
  it('includes the full minimum vocabulary named in the T3.7.8 brief', () => {
    const required = [
      'ip',
      'client_ip',
      'remote_addr',
      'x-forwarded-for',
      'x_forwarded_for',
      'cf-connecting-ip',
      'true-client-ip',
      'cookie',
      'set-cookie',
    ];

    for (const key of required) {
      expect(FORBIDDEN_PAYLOAD_KEYS.has(key)).toBe(true);
    }
  });

  it('[security] is a superset of T2.3.8\'s regex: every alternation branch (ip, addr, forwarded, cookie) has at least one representative key', () => {
    const branches = T238_REGEX.source.split('|');
    expect(branches).toEqual(['ip', 'addr', 'forwarded', 'cookie']);

    for (const branch of branches) {
      const branchPattern = new RegExp(branch, 'i');
      const covered = [...FORBIDDEN_PAYLOAD_KEYS].some((key) => branchPattern.test(key));
      expect(covered).toBe(true);
    }
  });

  it('[security] every entry also matches T2.3.8\'s own regex, so nothing this vocabulary flags is a NEW category the regex would have missed', () => {
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      expect(T238_REGEX.test(key)).toBe(true);
    }
  });
});

describe('redactForbiddenKeys', () => {
  it('[security] redacts a top-level ip key, a nested headers[\'x-forwarded-for\'], and a nested headers.cookie, naming all three paths', () => {
    const input = {
      ip: '203.0.113.77',
      headers: {
        'x-forwarded-for': '203.0.113.77, 10.0.0.1',
        cookie: 'session=abc123',
        accept: 'text/html',
      },
    };

    const { value, redactedKeys } = redactForbiddenKeys(input);

    expect(value).toEqual({
      ip: SECRET_REDACTION_PLACEHOLDER,
      headers: {
        'x-forwarded-for': SECRET_REDACTION_PLACEHOLDER,
        cookie: SECRET_REDACTION_PLACEHOLDER,
        accept: 'text/html',
      },
    });
    expect(redactedKeys).toHaveLength(3);
    expect(redactedKeys).toEqual(
      expect.arrayContaining(['ip', "headers['x-forwarded-for']", 'headers.cookie']),
    );
  });

  it('[security] matches forbidden keys case-insensitively while preserving the original key casing in the output', () => {
    const input = { IP: '1.2.3.4', 'X-Forwarded-For': '1.2.3.4', COOKIE: 'a=b', Accept: 'text/html' };

    const { value, redactedKeys } = redactForbiddenKeys(input);

    expect(value).toEqual({
      IP: SECRET_REDACTION_PLACEHOLDER,
      'X-Forwarded-For': SECRET_REDACTION_PLACEHOLDER,
      COOKIE: SECRET_REDACTION_PLACEHOLDER,
      Accept: 'text/html',
    });
    expect(redactedKeys).toHaveLength(3);
  });

  it('[security] redacts a forbidden key nested inside an array of objects, using bracket index notation in the path', () => {
    const input = { items: [{ cookie: 'a' }, { safe: 'b' }] };

    const { value, redactedKeys } = redactForbiddenKeys(input);

    expect(value).toEqual({ items: [{ cookie: SECRET_REDACTION_PLACEHOLDER }, { safe: 'b' }] });
    expect(redactedKeys).toEqual(['items[0].cookie']);
  });

  it('[security, anti-vacuous-pass] returns a valid CaptureEvent deep-equal to the input, with redactedKeys: [] — the redactor must not alter a clean payload', () => {
    const parsed = CaptureEventSchema.parse(VALID_CAPTURE_EVENT);

    const { value, redactedKeys } = redactForbiddenKeys(parsed);

    expect(value).toEqual(parsed);
    expect(redactedKeys).toEqual([]);
  });

  it('[security] does not mutate its input', () => {
    const input = {
      ip: '203.0.113.77',
      nested: { cookie: 'session=abc', safe: 'value' },
      list: [{ cookie: 'x' }, 'plain'],
    };
    const snapshot = structuredClone(input);

    redactForbiddenKeys(input);

    expect(input).toEqual(snapshot);
  });

  it.each([null, undefined, 'just a string', 42, true, [], {}])(
    'leaves a non-forbidden primitive/empty-container value %j unchanged with redactedKeys: []',
    (input) => {
      const { value, redactedKeys } = redactForbiddenKeys(input);

      expect(value).toEqual(input);
      expect(redactedKeys).toEqual([]);
    },
  );

  it('[security] returns rather than throwing or hanging for a self-referencing (circular) object', () => {
    type SelfRef = { name: string; cookie: string; self?: SelfRef };
    const circular: SelfRef = { name: 'root', cookie: 'a=b' };
    circular.self = circular;

    const run = (): unknown => redactForbiddenKeys(circular);

    expect(run).not.toThrow();
  }, 2000);

  it('[security] returns rather than stack-overflowing for 200+ levels of nesting', () => {
    type Deep = { child?: Deep; cookie?: string };
    let deep: Deep = { cookie: 'leaf-secret' };
    for (let i = 0; i < 200; i++) {
      deep = { child: deep };
    }

    const run = (): unknown => redactForbiddenKeys(deep);

    expect(run).not.toThrow();
    const result = run();
    expect(result).toBeDefined();
  }, 2000);
});
