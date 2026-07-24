import { describe, expect, it } from 'vitest';
import { isValidSlug } from './links';
import {
  RESERVED_HANDLES,
  RESERVED_PATHS,
  RESERVED_PATH_PREFIXES,
  isReservedHandle,
  isReservedPath,
  resolveReservedHandles,
} from './reserved';

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
  it('reserves the root path and the two well-known static files', () => {
    // "/" is the bio page's own route (the Cloudflare Origin Rule sends
    // path === "/" to web) — a slug can never be assigned an empty path,
    // or it would shadow the bio page. /favicon.ico and /robots.txt are
    // added by T2.1.1: browsers and crawlers request them unprompted on
    // every handle host, and each one would otherwise cost a Redis GET
    // plus a Postgres query to discover it is not a slug.
    expect(RESERVED_PATHS).toEqual(['/', '/favicon.ico', '/robots.txt']);
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

describe('RESERVED_PATH_PREFIXES', () => {
  it('reserves the RFC 8615 well-known base path as a prefix', () => {
    // A flat array of exact paths cannot express "/.well-known/*" — ACME
    // challenge paths carry an unpredictable token as their last segment
    // — so the prefix list exists alongside RESERVED_PATHS rather than
    // inside it.
    expect(RESERVED_PATH_PREFIXES).toEqual(['/.well-known/']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(RESERVED_PATH_PREFIXES)).toBe(true);
  });
});

describe('isReservedHandle', () => {
  it.each(EXPECTED_DEFAULTS)('matches the reserved handle %s', (handle) => {
    expect(isReservedHandle(handle)).toBe(true);
  });

  it('does not match an ordinary tenant handle', () => {
    expect(isReservedHandle('juano')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isReservedHandle('APP')).toBe(true);
    expect(isReservedHandle('Admin')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isReservedHandle('  api  ')).toBe(true);
  });

  it('does not match the empty string', () => {
    expect(isReservedHandle('')).toBe(false);
  });

  it('does not match a handle that merely contains a reserved word', () => {
    expect(isReservedHandle('apps')).toBe(false);
    expect(isReservedHandle('myapp')).toBe(false);
  });

  it('accepts a resolved override list, so POSTA_RESERVED_HANDLES is honoured', () => {
    // The hot path passes resolveReservedHandles(env.POSTA_RESERVED_HANDLES)
    // rather than the frozen default, so an operator's extra reserved
    // words are enforced by the same function, not a second copy.
    const resolved = resolveReservedHandles(['sponsor']);

    expect(isReservedHandle('sponsor', resolved)).toBe(true);
    expect(isReservedHandle('sponsor')).toBe(false); // default list is unchanged
    expect(isReservedHandle('app', resolved)).toBe(true); // defaults still enforced
  });
});

describe('isReservedPath', () => {
  it.each(['/', '/favicon.ico', '/robots.txt'])('matches the reserved path %s', (path) => {
    expect(isReservedPath(path)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isReservedPath('/FAVICON.ICO')).toBe(true);
    expect(isReservedPath('/Robots.TXT')).toBe(true);
  });

  it('ignores a single trailing slash', () => {
    expect(isReservedPath('/favicon.ico/')).toBe(true);
    expect(isReservedPath('/robots.txt/')).toBe(true);
  });

  it('treats the empty path as the root path', () => {
    // Express gives "" for a request to "http://host" with no path at
    // all; that is the bio-page root, not a slug lookup.
    expect(isReservedPath('')).toBe(true);
  });

  it('matches any path under the /.well-known/ prefix', () => {
    expect(isReservedPath('/.well-known/acme-challenge/abc')).toBe(true);
    expect(isReservedPath('/.well-known/security.txt')).toBe(true);
  });

  it('matches the /.well-known base path itself, with or without a trailing slash', () => {
    expect(isReservedPath('/.well-known')).toBe(true);
    expect(isReservedPath('/.well-known/')).toBe(true);
  });

  it('does not match a path that only shares the well-known prefix as a substring', () => {
    // The single most likely bug in a prefix matcher: startsWith on
    // "/.well-known" (no trailing slash) would wrongly claim this one,
    // handing an attacker a way to make an arbitrary slug unreachable.
    expect(isReservedPath('/.well-knownx')).toBe(false);
    expect(isReservedPath('/.well-known-not-really')).toBe(false);
  });

  it('does not match an ordinary slug path', () => {
    expect(isReservedPath('/promo')).toBe(false);
    expect(isReservedPath('/favicon')).toBe(false);
    expect(isReservedPath('/robots')).toBe(false);
  });

  it('does not match a nested path that merely ends in a reserved file name', () => {
    expect(isReservedPath('/promo/favicon.ico')).toBe(false);
  });
});

describe('RESERVED_PATHS / RESERVED_PATH_PREFIXES — pre-decode matching stays safe [security, S2.1 story-review batch]', () => {
  // apps/api/src/redirect/host.ts calls isReservedPath(path) BEFORE any
  // percent-decoding — decoding happens later, inside extractSlug, only
  // on the way to a slug lookup. That ordering is safe TODAY only
  // because every entry below contains at least one character
  // isValidSlug/SLUG_PATTERN rejects (a '.', currently): an attacker
  // percent-encoding one character to slip the RAW string past
  // isReservedPath (e.g. '/%66avicon.ico' for '/favicon.ico') still
  // produces a DECODED result isValidSlug rejects for the same reason,
  // landing on the same invalid-path 404 either way.
  //
  // A future reserved path that is a bare word — no punctuation, e.g.
  // '/admin' — would NOT have this property: the raw '/%61dmin' fails
  // isReservedPath, decodes to 'admin', and 'admin' passes isValidSlug
  // (nothing else stops it looking like an ordinary slug) — so the
  // request would fall through to a real link lookup instead of the
  // intended 404, a genuine bypass. This test turns that regression into
  // a failing assertion at PR time rather than a silent bypass
  // discovered once 'link' starts doing real I/O (S2.2+). Deliberately
  // does NOT restructure host.ts's decode ordering itself — pinning the
  // invariant here is the cheaper, more durable guard.
  const SLUG_CHARSET_ONLY = /^[a-z0-9-]*$/;

  /** The word a reserved entry becomes once its leading slash (and, for
   * a prefix, its trailing slash) is stripped — i.e. what extractSlug
   * would hand isValidSlug if the whole reserved word were used as a
   * slug. */
  function wordFor(entry: string): string {
    const withoutLeadingSlash = entry.startsWith('/') ? entry.slice(1) : entry;
    return withoutLeadingSlash.endsWith('/')
      ? withoutLeadingSlash.slice(0, -1)
      : withoutLeadingSlash;
  }

  it.each(RESERVED_PATHS.filter((entry) => entry !== '/'))(
    '%s contains a character outside the slug charset',
    (entry) => {
      const word = wordFor(entry);
      // Matching the WHOLE word against [a-z0-9-]* means every character
      // in it is one a slug is allowed to contain — i.e. NO offending
      // character. The assertion is that this is false.
      expect(SLUG_CHARSET_ONLY.test(word)).toBe(false);
      // Belt-and-suspenders: the decoded word must also fail the REAL
      // validator, not just this test's own regex restatement of it.
      expect(isValidSlug(word)).toBe(false);
    },
  );

  it.each(RESERVED_PATH_PREFIXES)(
    '%s contains a character outside the slug charset',
    (entry) => {
      const word = wordFor(entry);
      expect(SLUG_CHARSET_ONLY.test(word)).toBe(false);
      expect(isValidSlug(word)).toBe(false);
    },
  );

  it("'/' is exempt from this invariant: host.ts's handle-root branch matches it BEFORE isReservedPath ever runs, and an empty/root path has no decode-bypass vector — percent-decoding a non-empty encoded segment can never produce an empty string", () => {
    expect(RESERVED_PATHS).toContain('/');
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
