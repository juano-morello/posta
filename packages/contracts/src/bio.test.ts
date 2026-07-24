import { describe, expect, it } from 'vitest';
import { RESERVED_HANDLES } from './reserved';
import {
  createBioLinkSchema,
  createBioPageSchema,
  updateBioLinkSchema,
  updateBioPageSchema,
} from './bio';

// T1.1.12 [security] — `handle` rejects the reserved list from spec §3.1:
// a claimable `api` handle would shadow the API host. Sourced from
// RESERVED_HANDLES (T0.3.4), never a second inlined copy.

describe('createBioPageSchema.handle (T1.1.12) [security]', () => {
  it.each(RESERVED_HANDLES)('rejects the reserved handle "%s"', (reservedHandle) => {
    const result = createBioPageSchema.safeParse({ handle: reservedHandle });
    expect(result.success).toBe(false);
  });

  it('rejects "ju" (below the 3-char minimum)', () => {
    expect(createBioPageSchema.safeParse({ handle: 'ju' }).success).toBe(false);
  });

  it('rejects "-juano" (leading hyphen)', () => {
    expect(createBioPageSchema.safeParse({ handle: '-juano' }).success).toBe(false);
  });

  it('accepts "juano-dev"', () => {
    expect(createBioPageSchema.safeParse({ handle: 'juano-dev' }).success).toBe(true);
  });

  it.each([
    ['jua', true], // exactly 3 chars, the minimum
    ['a'.repeat(30), true], // exactly 30 chars, the maximum
    ['a'.repeat(31), false], // one over the maximum
    ['juano-', false], // trailing hyphen rejected
    ['Juano', false], // uppercase rejected
    ['juano_dev', false], // underscore rejected
    ['juano dev', false], // whitespace rejected
  ] as const)('handle=%j -> accepted=%s', (handle, expectedAccept) => {
    const result = createBioPageSchema.safeParse({ handle });
    expect(result.success).toBe(expectedAccept);
  });
});

describe('createBioPageSchema optional fields', () => {
  it('accepts displayName, bio, avatarUrl, and themeId', () => {
    const result = createBioPageSchema.safeParse({
      handle: 'juano-dev',
      displayName: 'Juano',
      bio: 'Building Posta in public.',
      avatarUrl: 'https://example.com/avatar.png',
      themeId: 'default',
    });
    expect(result.success).toBe(true);
  });

  it('does not require displayName, bio, avatarUrl, or themeId', () => {
    expect(createBioPageSchema.safeParse({ handle: 'juano-dev' }).success).toBe(true);
  });

  it.each([
    ['displayName', 'a'.repeat(101)],
    ['bio', 'a'.repeat(501)],
    ['themeId', 'a'.repeat(51)],
  ] as const)('[security] rejects %s over its length bound', (field, value) => {
    const result = createBioPageSchema.safeParse({ handle: 'juano-dev', [field]: value });
    expect(result.success).toBe(false);
  });

  it('[security] rejects avatarUrl over the 2048-char length bound', () => {
    const hugeAvatarUrl = `https://example.com/${'a'.repeat(2048)}.png`;
    const result = createBioPageSchema.safeParse({ handle: 'juano-dev', avatarUrl: hugeAvatarUrl });
    expect(result.success).toBe(false);
  });
});

describe('createBioPageSchema.avatarUrl (PR #3 review) [security]', () => {
  // Bio pages are public, CDN-served pages (invariant 11) — avatarUrl is
  // rendered on a page anyone can load, not just stored internally.
  // Same protocol allowlist as createLinkSchema.destination (T1.1.11),
  // and the same table-driven shape as that file's own test.
  it.each([
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    ['//evil.com/avatar.png', false],
    ['/relative-avatar.png', false],
    ['ftp://x/avatar.png', false],
    ['https://example.com/avatar.png', true],
  ] as const)('avatarUrl=%s -> accepted=%s', (avatarUrl, expectedAccept) => {
    const result = createBioPageSchema.safeParse({ handle: 'juano-dev', avatarUrl });
    expect(result.success).toBe(expectedAccept);
  });

  it('accepts a bare http:// avatarUrl, not only https://', () => {
    const result = createBioPageSchema.safeParse({ handle: 'juano-dev', avatarUrl: 'http://example.com/a.png' });
    expect(result.success).toBe(true);
  });
});

describe('updateBioPageSchema', () => {
  it('makes every field optional (a partial update)', () => {
    expect(updateBioPageSchema.safeParse({}).success).toBe(true);
    expect(updateBioPageSchema.safeParse({ displayName: 'New name' }).success).toBe(true);
  });

  it('still rejects a reserved handle when one is provided', () => {
    expect(updateBioPageSchema.safeParse({ handle: 'admin' }).success).toBe(false);
  });
});

describe('createBioLinkSchema (T1.1.12)', () => {
  it('has no url/destination/href field — carries link_id, never a URL, mirroring T1.1.7', () => {
    const keys = Object.keys(createBioLinkSchema.shape);
    const forbidden = keys.filter((key) => /url|destination|href/i.test(key));
    expect(forbidden).toEqual([]);
  });

  it('carries linkId and position', () => {
    const result = createBioLinkSchema.safeParse({
      linkId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      position: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing linkId', () => {
    expect(createBioLinkSchema.safeParse({ position: 0 }).success).toBe(false);
  });

  it('[security] rejects a linkId that is not a valid ULID shape', () => {
    const result = createBioLinkSchema.safeParse({ linkId: 'not-a-ulid', position: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative position', () => {
    const result = createBioLinkSchema.safeParse({
      linkId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      position: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateBioLinkSchema', () => {
  it('makes every field optional', () => {
    expect(updateBioLinkSchema.safeParse({}).success).toBe(true);
    expect(updateBioLinkSchema.safeParse({ position: 3 }).success).toBe(true);
  });
});
