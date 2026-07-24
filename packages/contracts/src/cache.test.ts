import { describe, expect, it } from 'vitest';
import { CachedLinkSchema, parseCachedLink } from './cache';

// T2.2.1 [security] — S2.2's cache boundary. A Redis value is untrusted
// input the moment anything else can write to that instance, and an
// unparsed `destination` read straight off the cache and handed to
// `res.redirect()` is an open redirect with a TTL. These tests assert
// both halves of that boundary: CachedLinkSchema (structural validation)
// and parseCachedLink (the "never throws on untrusted input" wrapper
// every cache read in T2.2.3 will call).

const wellFormedPayload = {
  link_id: '01HXYZ0000000000000000001',
  tenant_id: '01HXYZ0000000000000000002',
  destination: 'https://x.com/promo',
};

describe('CachedLinkSchema', () => {
  it('round-trips a well-formed payload', () => {
    const result = CachedLinkSchema.safeParse(wellFormedPayload);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(wellFormedPayload);
  });

  it('rejects a payload missing destination', () => {
    const withoutDestination = { link_id: wellFormedPayload.link_id, tenant_id: wellFormedPayload.tenant_id };
    const result = CachedLinkSchema.safeParse(withoutDestination);
    expect(result.success).toBe(false);
  });

  it('rejects a payload missing link_id', () => {
    const withoutLinkId = { tenant_id: wellFormedPayload.tenant_id, destination: wellFormedPayload.destination };
    const result = CachedLinkSchema.safeParse(withoutLinkId);
    expect(result.success).toBe(false);
  });

  it('rejects a payload missing tenant_id', () => {
    const withoutTenantId = { link_id: wellFormedPayload.link_id, destination: wellFormedPayload.destination };
    const result = CachedLinkSchema.safeParse(withoutTenantId);
    expect(result.success).toBe(false);
  });

  it('[security] rejects an unexpected extra key (.strict())', () => {
    const result = CachedLinkSchema.safeParse({ ...wellFormedPayload, extra: 'unexpected' });
    expect(result.success).toBe(false);
  });

  // [security] the open-redirect boundary: every non-http(s) destination
  // shape T1.1.11 already rejects at write time must also be rejected
  // here, at read time — reusing the exact same zDestination object
  // (see links.ts) is what makes that true by construction rather than
  // by two schemas happening to agree today.
  describe('destination (open-redirect boundary)', () => {
    it.each([
      ['javascript:alert(1)', false],
      ['data:text/html,x', false],
      ['//evil.com', false],
      ['/relative', false],
      ['file:///etc/passwd', false],
      ['https://x.com/promo', true],
      ['http://x.com/promo', true],
    ] as const)('destination=%s -> accepted=%s', (destination, expectedAccept) => {
      const result = CachedLinkSchema.safeParse({ ...wellFormedPayload, destination });
      expect(result.success).toBe(expectedAccept);
    });

    it('[security] rejects a destination over the 2048-char length bound', () => {
      const hugeDestination = `https://x.com/${'a'.repeat(2048)}`;
      const result = CachedLinkSchema.safeParse({ ...wellFormedPayload, destination: hugeDestination });
      expect(result.success).toBe(false);
    });
  });
});

describe('parseCachedLink', () => {
  it('round-trips a well-formed JSON payload', () => {
    const raw = JSON.stringify(wellFormedPayload);
    expect(parseCachedLink(raw)).toEqual(wellFormedPayload);
  });

  it('returns null for a payload missing destination, without throwing', () => {
    const withoutDestination = { link_id: wellFormedPayload.link_id, tenant_id: wellFormedPayload.tenant_id };
    const raw = JSON.stringify(withoutDestination);
    expect(() => parseCachedLink(raw)).not.toThrow();
    expect(parseCachedLink(raw)).toBeNull();
  });

  it('[security] returns null for a javascript: destination, without throwing', () => {
    const raw = JSON.stringify({ ...wellFormedPayload, destination: 'javascript:alert(1)' });
    expect(() => parseCachedLink(raw)).not.toThrow();
    expect(parseCachedLink(raw)).toBeNull();
  });

  it('returns null for non-JSON input, without throwing', () => {
    expect(() => parseCachedLink('not json {{{')).not.toThrow();
    expect(parseCachedLink('not json {{{')).toBeNull();
  });

  it('returns null for null input (a Redis GET miss), without throwing', () => {
    expect(() => parseCachedLink(null)).not.toThrow();
    expect(parseCachedLink(null)).toBeNull();
  });

  it('[security] returns null for an unexpected extra key, without throwing', () => {
    const raw = JSON.stringify({ ...wellFormedPayload, extra: 'unexpected' });
    expect(() => parseCachedLink(raw)).not.toThrow();
    expect(parseCachedLink(raw)).toBeNull();
  });

  it('returns null for valid JSON that is not an object (e.g. a bare string)', () => {
    const raw = JSON.stringify('just a string');
    expect(() => parseCachedLink(raw)).not.toThrow();
    expect(parseCachedLink(raw)).toBeNull();
  });
});
