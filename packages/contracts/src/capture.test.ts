import { describe, expect, it } from 'vitest';
import { CaptureEventSchema } from './capture';

// T2.3.1 [INV-6][INV-8] — CaptureEventSchema is the BullMQ queue payload
// AND the worker's write shape into `events` (minus the worker's own
// enrichment columns). These tests protect the two structural properties
// that make it trustworthy rather than merely typed:
//
//   - invariant 6: an `ip` field (or `x-forwarded-for`, a cookie, ...)
//     cannot be added without a test failing here.
//   - invariant 8: `event_id` is validated as a genuine 26-char Crockford
//     ULID, not an arbitrary string.
//
// A third property, not tied to a numbered invariant but load-bearing for
// E4's classification view: every signal is `string | null`, NEVER
// optional. An absent header is itself evidence, so it must serialise as
// an explicit `null` — an omitted key would be indistinguishable from one
// lost in transit.

// A real ULID (26 chars, Crockford base32 — generated via the `ulid`
// package, the same one packages/core/src/ulid.ts wraps).
const VALID_ULID = '01KYBF7J2PXZX1ZSEN1BHMSTXX';

// Spec §5.1, verbatim by group — this is the "explicit expected list" the
// key-set test below asserts against. Order mirrors the doc; the identity
// fields (event_id/occurred_at/tenant_id/link_id/slug) are not part of
// §5.1 itself but are the queue payload's required context fields per
// T2.3.1's brief.
const EXPECTED_KEYS = [
  // Identity/context (5)
  'event_id',
  'occurred_at',
  'tenant_id',
  'link_id',
  'slug',
  // Request (5)
  'http_method',
  'user_agent',
  'referer',
  'accept',
  'accept_language',
  // Fetch metadata (5)
  'sec_fetch_site',
  'sec_fetch_mode',
  'sec_fetch_dest',
  'sec_fetch_user',
  'sec_purpose',
  // Client hints (3)
  'sec_ch_ua',
  'sec_ch_ua_mobile',
  'sec_ch_ua_platform',
  // Prefetch tells (3)
  'purpose',
  'x_purpose',
  'x_moz',
  // Network (2)
  'country',
  'asn',
  // Identity (1)
  'visitor_hash',
].sort();

/** Every field present, every §5.1 signal explicitly `null`. */
const allNullPayload = {
  event_id: VALID_ULID,
  occurred_at: '2026-07-24T12:00:00.000Z',
  tenant_id: '01HXYZ00000000000000000TT',
  link_id: '01HXYZ00000000000000000LL',
  slug: 'promo',
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
  country: null,
  asn: null,
  visitor_hash: null,
};

describe('CaptureEventSchema (T2.3.1)', () => {
  it('key set matches spec §5.1 exactly (fails on a missing OR an added key)', () => {
    const actualKeys = Object.keys(CaptureEventSchema.shape).sort();
    expect(actualKeys).toEqual(EXPECTED_KEYS);
  });

  it('[INV-6] no key matches /ip|addr|forwarded|cookie/i, derived from the schema at runtime', () => {
    const actualKeys = Object.keys(CaptureEventSchema.shape);
    const suspectKeys = actualKeys.filter((key) => /ip|addr|forwarded|cookie/i.test(key));
    expect(suspectKeys).toEqual([]);
  });

  it('[INV-6] rejects an unexpected extra key (.strict())', () => {
    const result = CaptureEventSchema.safeParse({ ...allNullPayload, ip: '203.0.113.77' });
    expect(result.success).toBe(false);
  });

  it('parses a payload where every §5.1 signal is explicitly null', () => {
    const result = CaptureEventSchema.safeParse(allNullPayload);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(allNullPayload);
  });

  it('rejects a payload that OMITS a signal key (nullable, not optional)', () => {
    const { user_agent, ...withoutUserAgent } = allNullPayload;
    void user_agent;
    const result = CaptureEventSchema.safeParse(withoutUserAgent);
    expect(result.success).toBe(false);
  });

  describe('event_id (ULID validation, INV-8)', () => {
    it('accepts a valid 26-char Crockford ULID', () => {
      const result = CaptureEventSchema.safeParse({ ...allNullPayload, event_id: VALID_ULID });
      expect(result.success).toBe(true);
    });

    it('rejects a string one char short of 26', () => {
      const result = CaptureEventSchema.safeParse({
        ...allNullPayload,
        event_id: VALID_ULID.slice(0, 25),
      });
      expect(result.success).toBe(false);
    });

    it('rejects a lowercase ULID', () => {
      const result = CaptureEventSchema.safeParse({
        ...allNullPayload,
        event_id: VALID_ULID.toLowerCase(),
      });
      expect(result.success).toBe(false);
    });

    it('rejects a ULID-shaped string containing I, L, O and U (excluded from Crockford base32)', () => {
      const result = CaptureEventSchema.safeParse({
        ...allNullPayload,
        event_id: 'ILOU'.repeat(6) + '12', // 26 chars, all illegal Crockford letters
      });
      expect(result.success).toBe(false);
    });

    it('rejects a UUID', () => {
      const result = CaptureEventSchema.safeParse({
        ...allNullPayload,
        event_id: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(false);
    });
  });

  it('occurred_at rejects a non-ISO-8601 string', () => {
    const result = CaptureEventSchema.safeParse({ ...allNullPayload, occurred_at: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('asn accepts a number and rejects a numeric string', () => {
    expect(CaptureEventSchema.safeParse({ ...allNullPayload, asn: 16509 }).success).toBe(true);
    expect(CaptureEventSchema.safeParse({ ...allNullPayload, asn: '16509' }).success).toBe(false);
  });
});
