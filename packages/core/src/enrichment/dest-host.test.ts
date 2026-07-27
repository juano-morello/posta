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

  it('returns null for an unparseable value', () => {
    expect(destHost('not a url')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(destHost('')).toBeNull();
  });

  it('never leaks embedded userinfo (username:password@) into the returned host', () => {
    const result = destHost('https://user:secretpass@evil.example.com/path');

    expect(result).toBe('evil.example.com');
    expect(result).not.toContain('secretpass');
    expect(result).not.toContain('user');
  });
});
