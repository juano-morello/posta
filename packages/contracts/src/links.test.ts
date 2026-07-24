import { describe, expect, it } from 'vitest';
import { createLinkSchema, updateLinkSchema } from './links';

// T1.1.11 [security] — the schema boundary S1.1's acceptance criterion
// refers to: destination must be an absolute http(s) URL, everything
// else rejected BEFORE it ever reaches the database (T1.1.5's CHECK
// constraint is defense in depth behind this, not the primary gate).

describe('createLinkSchema.destination (T1.1.11) [security]', () => {
  it.each([
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    ['//evil.com', false],
    ['/relative', false],
    ['ftp://x', false],
    ['https://x.com/a?b=c#d', true],
  ] as const)('destination=%s -> accepted=%s', (destination, expectedAccept) => {
    const result = createLinkSchema.safeParse({ slug: 'promo', destination });
    expect(result.success).toBe(expectedAccept);
  });

  it('accepts a bare http:// URL, not only https://', () => {
    const result = createLinkSchema.safeParse({ slug: 'promo', destination: 'http://x.com' });
    expect(result.success).toBe(true);
  });

  it('[security] rejects a destination over the 2048-char length bound', () => {
    const hugeDestination = `https://x.com/${'a'.repeat(2048)}`;
    const result = createLinkSchema.safeParse({ slug: 'promo', destination: hugeDestination });
    expect(result.success).toBe(false);
  });
});

describe('createLinkSchema.slug', () => {
  it.each([
    ['my-promo-123', true],
    ['a', true], // single char, minimum length
    ['a'.repeat(64), true], // exactly at the max
    ['a'.repeat(65), false], // one over the max
    ['', false], // below the minimum
    ['Promo', false], // uppercase rejected
    ['my_promo', false], // underscore rejected — must match S5.3 exactly
    ['-promo', false], // leading hyphen rejected
    ['promo-', false], // trailing hyphen rejected
    ['pro mo', false], // whitespace rejected
  ] as const)('slug=%j -> accepted=%s', (slug, expectedAccept) => {
    const result = createLinkSchema.safeParse({ slug, destination: 'https://x.com' });
    expect(result.success).toBe(expectedAccept);
  });
});

describe('createLinkSchema.title', () => {
  it('is optional', () => {
    const result = createLinkSchema.safeParse({ slug: 'promo', destination: 'https://x.com' });
    expect(result.success).toBe(true);
  });

  it('accepts a string title', () => {
    const result = createLinkSchema.safeParse({
      slug: 'promo',
      destination: 'https://x.com',
      title: 'My Promo',
    });
    expect(result.success).toBe(true);
  });

  it('[security] rejects a title over the 200-char length bound', () => {
    const result = createLinkSchema.safeParse({
      slug: 'promo',
      destination: 'https://x.com',
      title: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });
});

describe('updateLinkSchema', () => {
  it('makes every field optional (a partial update)', () => {
    expect(updateLinkSchema.safeParse({}).success).toBe(true);
    expect(updateLinkSchema.safeParse({ title: 'Renamed' }).success).toBe(true);
  });

  it('still rejects an invalid destination when one is provided', () => {
    const result = updateLinkSchema.safeParse({ destination: 'javascript:alert(1)' });
    expect(result.success).toBe(false);
  });
});
