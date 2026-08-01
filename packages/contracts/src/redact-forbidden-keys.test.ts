import { describe, expect, it } from 'vitest';
import { CaptureEventSchema, type CaptureEvent } from './capture';
import { SECRET_REDACTION_PLACEHOLDER } from './env';
import {
  CIRCULAR_REFERENCE_PLACEHOLDER,
  FORBIDDEN_PAYLOAD_KEYS,
  MAX_DEPTH_EXCEEDED_PLACEHOLDER,
  redactForbiddenKeys,
} from './redact';

// T3.7.8 [INV-6][security] — the DLQ (T3.7.9, next in this chain) is both
// "stored" and "queued" in Redis, so a malformed capture payload sitting
// there with a raw IP or a raw cookie violates invariant 6 today. This
// suite proves the standalone redactor closes that gap: it does not wire
// into the DLQ (that is T3.7.9's job), it only proves the function is
// correct in isolation.

// A literal copy of T2.3.8's already-enforced regex
// (apps/api/src/redirect/capture-privacy.test.ts, referenced at
// 02-redirect-hot-path.md:168) — NOT an import, since packages/contracts
// must never depend on apps/api.
//
// [security fix round 1, post-commit review 75e5f2e] This regex matches
// by SUBSTRING over free text, so it also flags ordinary English words
// ("zip", "cookiecutter", ...) that have nothing to do with invariant 6
// — its match set is effectively infinite, and FORBIDDEN_PAYLOAD_KEYS
// (an exact-match Set) can never be a literal mathematical superset of
// it. The tests below assert the honest, narrower claim redact.ts's own
// module comment now makes: every alternation branch has a representative
// key (below), every entry here also matches the regex (below), and a
// representative sample of the CONCRETE header aliases the regex was
// written to catch is covered (in the redactForbiddenKeys describe block's
// vocabulary-gap regression test) — not an exhaustive proof, which is not
// achievable against a substring-matching regex.
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

  it('[security] every alternation branch of T2.3.8\'s regex (ip, addr, forwarded, cookie) has at least one representative key', () => {
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

  // [security fix round 1, post-commit review 75e5f2e] The original round
  // shipped only `ip`, `client_ip`, `remote_addr`, `x-forwarded-for`/
  // `x_forwarded_for`, `cf-connecting-ip`, `true-client-ip`, `cookie`,
  // `set-cookie` — missing `x-real-ip` and the RFC 7239 `forwarded`
  // header entirely, plus common CDN client-IP header aliases
  // (`x-client-ip`, `fastly-client-ip`), all of which T2.3.8's own regex
  // WOULD flag as suspicious. This is the regression test for that gap:
  // a curated, representative (not exhaustive — see this file's header
  // comment on why exhaustive is not achievable) sample of real-world
  // header aliases the regex was written to catch, each checked against
  // BOTH the regex (sanity: these really are what T2.3.8 flags) and the
  // vocabulary (the actual fix).
  it('[security] covers a representative sample of real-world IP/cookie header aliases that T2.3.8\'s regex flags, in both "-" and "_" spelling', () => {
    const representativeHeaderAliases = [
      'ip',
      'client_ip',
      'client-ip',
      'remote_addr',
      'remote-addr',
      'x-forwarded-for',
      'x_forwarded_for',
      'forwarded',
      'x-real-ip',
      'x_real_ip',
      'x-client-ip',
      'x_client_ip',
      'cf-connecting-ip',
      'cf_connecting_ip',
      'true-client-ip',
      'true_client_ip',
      'fastly-client-ip',
      'fastly_client_ip',
      'cookie',
      'set-cookie',
      'set_cookie',
    ];

    for (const header of representativeHeaderAliases) {
      expect(T238_REGEX.test(header)).toBe(true);
      expect(FORBIDDEN_PAYLOAD_KEYS.has(header.toLowerCase())).toBe(true);
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

  // [security fix round 1, post-commit review 75e5f2e] `JSON.parse`
  // creates a literal `__proto__` key as an ordinary own data property
  // (spec-guaranteed), so a malformed DLQ payload can legitimately carry
  // one. The original implementation built `result` as a plain `{}`
  // object literal: assigning `result['__proto__'] = ...` on that shape
  // does not create an own property at all — it invokes Object.prototype's
  // accessor instead, silently reassigning `result`'s prototype and
  // dropping the whole subtree from `Object.keys`/`JSON.stringify` while
  // `redactedKeys` still claimed it survived. This proves the fix
  // (building `result` via `Object.create(null)`): the key round-trips as
  // an ordinary property, its nested forbidden value is genuinely
  // redacted, and `redactedKeys` names a path that is actually present in
  // the output.
  it('[security] a literal "__proto__" key with a forbidden nested value round-trips as an ordinary key rather than vanishing via the prototype chain', () => {
    const input = JSON.parse('{"__proto__":{"cookie":"top-secret-cookie"},"safe":1}') as Record<
      string,
      unknown
    >;

    const { value, redactedKeys } = redactForbiddenKeys(input);

    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
    expect(Object.keys(value)).toEqual(expect.arrayContaining(['__proto__', 'safe']));
    expect((value as Record<string, unknown>).safe).toBe(1);
    expect(redactedKeys).toEqual(['__proto__.cookie']);

    const serialized = JSON.stringify(value);
    expect(serialized).toContain('__proto__');
    expect(serialized).toContain('safe');
    expect(serialized).not.toContain('top-secret-cookie');
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

  // [security fix round 1, post-commit review 75e5f2e] The original
  // version of this test only asserted `not.toThrow()`, which passes for
  // virtually any return value — including a hypothetical regression that
  // broke redaction specifically in the presence of a cycle (the cycle
  // check on `self` and the forbidden-key check on the sibling `cookie`
  // key are independent code paths; a bug in the former should not be
  // able to hide behind a passing "didn't throw" assertion for the
  // latter). Now also asserts the sibling `cookie` key was genuinely
  // redacted AND that the cyclic `self` edge was replaced with the actual
  // exported sentinel rather than left dangling or thrown away silently.
  it('[security] returns rather than throwing or hanging for a self-referencing (circular) object, and still redacts a sibling forbidden key while marking the cycle', () => {
    type SelfRef = { name: string; cookie: string; self?: SelfRef };
    const circular: SelfRef = { name: 'root', cookie: 'a=b' };
    circular.self = circular;

    let result: { value: SelfRef; redactedKeys: readonly string[] } | undefined;
    expect(() => {
      result = redactForbiddenKeys(circular);
    }).not.toThrow();

    const { value, redactedKeys } = result!;
    expect(redactedKeys).toContain('cookie');
    expect(value.cookie).toBe(SECRET_REDACTION_PLACEHOLDER);
    expect(value.name).toBe('root');
    expect(value.self as unknown).toBe(CIRCULAR_REFERENCE_PLACEHOLDER);
  }, 2000);

  // [security fix round 1, post-commit review 75e5f2e] The original
  // version of this test only asserted `not.toThrow()` then
  // `toBeDefined()` — vacuous, because 200 levels of plain object nesting
  // does not risk a real V8 stack overflow on its own (the recursion
  // limit V8 hits is in the low thousands), so this assertion would pass
  // whether or not MAX_REDACTION_DEPTH's truncation actually ran. The
  // leaf below is deliberately a NON-forbidden key (`note`, not `cookie`)
  // so its value can ONLY be excluded from the output by depth
  // truncation, never by ordinary key-based redaction — proving the depth
  // bound itself, not just that recursion completed. Manually verified
  // (per this story's dispatch brief) that raising MAX_REDACTION_DEPTH
  // past 200 makes this test fail with the leaf secret present in the
  // serialized output, confirming the assertion is not vacuous.
  it('[security] truncates rather than recursing past MAX_REDACTION_DEPTH for 200+ levels of nesting, so a non-forbidden leaf that deep does not survive in the output', () => {
    type Deep = { child?: Deep; note?: string };
    let deep: Deep = { note: 'leaf-secret-at-depth-200' };
    for (let i = 0; i < 200; i++) {
      deep = { child: deep };
    }

    const run = (): unknown => redactForbiddenKeys(deep);

    expect(run).not.toThrow();
    const result = run();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('leaf-secret-at-depth-200');
    expect(serialized).toContain(MAX_DEPTH_EXCEEDED_PLACEHOLDER);
  }, 2000);
});
