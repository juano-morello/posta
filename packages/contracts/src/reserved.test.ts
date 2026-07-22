import { describe, expect, it } from 'vitest';
import { RESERVED_HANDLES, RESERVED_PATHS, resolveReservedHandles } from './reserved';

// The eleven handles from CLAUDE.md: "app api www admin static assets cdn
// mail blog docs status". This is the single source of truth shared by
// the redirect hot path (S2.1) and slug/handle validation (S5.3) — a
// drift here lets a user claim a slug that then 404s.
const EXPECTED_DEFAULTS = [
  'app',
  'api',
  'www',
  'admin',
  'static',
  'assets',
  'cdn',
  'mail',
  'blog',
  'docs',
  'status',
];

describe('RESERVED_HANDLES', () => {
  it('contains exactly the eleven fixed handles, in order', () => {
    expect([...RESERVED_HANDLES]).toEqual(EXPECTED_DEFAULTS);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RESERVED_HANDLES)).toBe(true);
  });

  it('cannot be mutated', () => {
    expect(() => {
      (RESERVED_HANDLES as unknown as string[]).push('hacked');
    }).toThrow();
  });
});

describe('RESERVED_PATHS', () => {
  it('reserves the root path', () => {
    // "/" is the bio page's own route (the Cloudflare Origin Rule sends
    // path === "/" to web) — a slug can never be assigned an empty path,
    // or it would shadow the bio page.
    expect(RESERVED_PATHS).toEqual(['/']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RESERVED_PATHS)).toBe(true);
  });

  it('cannot be mutated', () => {
    expect(() => {
      (RESERVED_PATHS as unknown as string[]).push('/extra');
    }).toThrow();
  });
});

describe('resolveReservedHandles', () => {
  it('returns the default list when given no overrides', () => {
    expect([...resolveReservedHandles()]).toEqual(EXPECTED_DEFAULTS);
  });

  it('returns the default list for an explicitly empty overrides array', () => {
    expect([...resolveReservedHandles([])]).toEqual(EXPECTED_DEFAULTS);
  });

  it('extends the default list with additional handles (e.g. from POSTA_RESERVED_HANDLES)', () => {
    const resolved = resolveReservedHandles(['sponsor', 'promo']);

    expect(resolved).toContain('sponsor');
    expect(resolved).toContain('promo');
    expect(resolved).toContain('app'); // defaults still present
  });

  it('dedupes an override that repeats a default handle', () => {
    const resolved = resolveReservedHandles(['app']);

    expect(resolved.filter((handle) => handle === 'app')).toHaveLength(1);
  });

  it('normalizes override casing and whitespace before merging', () => {
    const resolved = resolveReservedHandles([' Sponsor ', 'APP']);

    expect(resolved).toContain('sponsor');
    expect(resolved.filter((handle) => handle === 'app')).toHaveLength(1);
  });

  it('drops empty-string overrides', () => {
    const resolved = resolveReservedHandles(['', '  ']);

    expect([...resolved]).toEqual(EXPECTED_DEFAULTS);
  });

  it('returns a frozen array', () => {
    expect(Object.isFrozen(resolveReservedHandles(['sponsor']))).toBe(true);
  });

  it('does not mutate the shared RESERVED_HANDLES default', () => {
    resolveReservedHandles(['sponsor']);

    expect(RESERVED_HANDLES).not.toContain('sponsor');
    expect([...RESERVED_HANDLES]).toEqual(EXPECTED_DEFAULTS);
  });
});
