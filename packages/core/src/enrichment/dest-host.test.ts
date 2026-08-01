import { describe, expect, it } from 'vitest';
import { destHost } from './dest-host';

// T3.2.4 (E3, S3.2) — destHost() derives a queryable `dest_host` fact from a
// stored redirect destination at enrichment time. It never mutates or
// discards the original destination string (that stays recoverable from R2
// verbatim per invariant 7) — this only ever produces a lowercased hostname
// for the classification/analytics side, with query string, fragment, port,
// and userinfo (username:password@) all stripped. Same null-safe,
// never-throw discipline as T3.2.1's parseUserAgent (./ua.ts): garbage in,
// `null` out, never an exception on the redirect hot path.

describe('destHost (T3.2.4)', () => {
  it('lowercases the host and strips port, path, query string, and fragment', () => {
    expect(destHost('https://Shop.Example.com:443/a?utm_source=ig#x')).toBe('shop.example.com');
  });

  it('returns null for the empty string', () => {
    expect(destHost('')).toBeNull();
  });

  it.each([
    ['plain garbage text', 'not a url'],
    ['a scheme with no authority at all', 'https://'],
    ['whitespace only', '   '],
    ['garbage containing unicode/emoji', 'not 🚀 a url'],
    ['a space inside the host', 'http://exam ple.com/'],
  ])('returns null for an unparseable value: %s (%j)', (_label, input) => {
    expect(destHost(input)).toBeNull();
  });

  it('returns null for a protocol-relative URL (no base to resolve it against)', () => {
    expect(destHost('//example.com')).toBeNull();
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['mailto:', 'mailto:test@example.com'],
  ])(
    'normalizes a %s URL that parses but has no host to null, not empty string',
    (_label, input) => {
      expect(destHost(input)).toBeNull();
    },
  );

  it('preserves the brackets on an IPv6 host', () => {
    expect(destHost('http://[::1]/')).toBe('[::1]');
  });

  it('returns the punycode-encoded form of an internationalized domain', () => {
    expect(destHost('http://münchen.de/')).toBe('xn--mnchen-3ya.de');
  });

  it('never leaks embedded userinfo (username:password@) into the returned host', () => {
    const result = destHost('https://user:secretpass@evil.example.com/path');

    expect(result).toBe('evil.example.com');
    expect(result).not.toContain('secretpass');
    expect(result).not.toContain('user');
  });
});
