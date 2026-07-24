import { describe, expect, it } from 'vitest';
import { makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import { makeRequestTargetParser, type RequestTarget } from './host';

// T2.1.2 — parseRequestTarget is the first thing the redirect hot path
// runs, and it is deliberately PURE: no request object, no I/O, no env
// read of its own. That is what makes it cheap to table-test like this,
// and it is why the domain config arrives through a factory (the same
// curried shape makeUrlBuilders itself uses) rather than being read from
// process.env inside the function.
//
// POSTA_LINK_DOMAIN is set to a non-production value here on purpose:
// tests/conventions/no-literal-domain.test.ts (T0.3.9) scans apps/ and
// packages/ for the real domain, so a test that hardcoded it would fail
// that guard rather than this one.
const DOMAIN = 'example.test';

const urls = makeUrlBuilders({
  domain: DOMAIN,
  protocol: 'http',
  appSubdomain: 'app',
  apiSubdomain: 'api',
});

const parseRequestTarget = makeRequestTargetParser({
  urls,
  reservedHandles: resolveReservedHandles(),
});

describe('parseRequestTarget — link hosts', () => {
  const cases: ReadonlyArray<readonly [string, string, RequestTarget]> = [
    ['juano.example.test', '/promo', { kind: 'link', handle: 'juano', slug: 'promo' }],
    // Host is case-insensitive per RFC 7230; the slug is NOT lowercased,
    // because a path is case-sensitive and slugs are stored lowercase —
    // see the invalid-path block below for what /PROMO does instead.
    ['JUANO.EXAMPLE.TEST', '/promo', { kind: 'link', handle: 'juano', slug: 'promo' }],
    // Local dev serves every host off one port, so the Host header
    // carries `:3000` and must still resolve to the same handle.
    ['juano.example.test:8080', '/promo', { kind: 'link', handle: 'juano', slug: 'promo' }],
    // A single trailing dot is the DNS root label — the same host.
    ['juano.example.test.', '/promo', { kind: 'link', handle: 'juano', slug: 'promo' }],
    ['a.example.test', '/x', { kind: 'link', handle: 'a', slug: 'x' }],
    ['my-handle.example.test', '/my-slug', { kind: 'link', handle: 'my-handle', slug: 'my-slug' }],
    [
      'juano.example.test',
      `/${'s'.repeat(64)}`,
      { kind: 'link', handle: 'juano', slug: 's'.repeat(64) },
    ],
  ];

  it.each(cases)('%s%s', (host, path, expected) => {
    expect(parseRequestTarget(host, path)).toEqual(expected);
  });
});

describe('parseRequestTarget — hosts that are not a tenant link host', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    // app. and api. are hosts THIS codebase constructs; they fall through
    // to Nest, which owns the dashboard API and /v1/*. They are reserved
    // handles too, but they must never be short-circuited to a 404 here
    // or api.<domain>/v1/* would stop working.
    ['app.example.test', '/dashboard'],
    ['api.example.test', '/v1/ping'],
    // Multi-level subdomain: a handle is a single DNS label.
    ['deep.sub.example.test', '/promo'],
    // The apex is not a handle host.
    ['example.test', '/promo'],
    // A domain that is not ours at all.
    ['evil.com', '/promo'],
    ['juano.evil.com', '/promo'],
    // A host that merely ends in our domain as a substring, not as a
    // label boundary — notexample.test is a different domain entirely.
    ['juano.notexample.test', '/promo'],
    // Missing or empty Host.
    ['', '/promo'],
    ['   ', '/promo'],
  ];

  it.each(cases)('%s%s → not-ours', (host, path) => {
    expect(parseRequestTarget(host, path)).toEqual({ kind: 'not-ours' });
  });
});

describe('parseRequestTarget — handle root', () => {
  // `/` on a handle host is the bio page, which Cloudflare's Origin Rule
  // routes to Next. The API receiving it means that rule is misconfigured
  // — T2.1.5 turns this branch into an alarm, which is why it is its own
  // kind rather than being folded into reserved-path (`/` IS in
  // RESERVED_PATHS, so root must be checked first).
  it.each(['/', ''])('%s → handle-root', (path) => {
    expect(parseRequestTarget('juano.example.test', path)).toEqual({
      kind: 'handle-root',
      handle: 'juano',
    });
  });

  it('treats a bio link carrying tracking params as the root, not a slug', () => {
    // CLAUDE.md's routing note: `/?utm=x` still has path `/`. Express
    // gives req.path without the query string, so this is really an
    // assertion that nothing here re-attaches it.
    expect(parseRequestTarget('juano.example.test', '/')).toEqual({
      kind: 'handle-root',
      handle: 'juano',
    });
  });
});

describe('parseRequestTarget — reserved paths', () => {
  it.each([
    '/favicon.ico',
    '/FAVICON.ICO',
    '/robots.txt',
    '/.well-known/acme-challenge/abc',
    '/.well-known/security.txt',
    '/.well-known',
  ])('%s → reserved-path', (path) => {
    expect(parseRequestTarget('juano.example.test', path)).toEqual({ kind: 'reserved-path' });
  });

  it('does not treat a lookalike of the well-known prefix as reserved', () => {
    // Not reserved-path — which is the claim under test. It lands on
    // invalid-path rather than link only because a leading dot is outside
    // the slug charset, so no such link could exist to redirect to; what
    // matters here is that the prefix matcher did not claim it.
    const target = parseRequestTarget('juano.example.test', '/.well-knownx');

    expect(target.kind).not.toBe('reserved-path');
    expect(target).toEqual({ kind: 'invalid-path' });
  });
});

describe('parseRequestTarget — reserved handles', () => {
  // The nine reserved handles that are NOT app/api. Those two resolve to
  // not-ours above, because parseHandleFromHost refuses them as handles —
  // they are this deployment's own dashboard and API hosts, and Nest
  // serves them. The rest can never be claimed by a tenant, so they can
  // never resolve to a link: short-circuiting them here is what keeps
  // T2.6.5's "zero link lookups for a reserved handle" true.
  it.each(['www', 'admin', 'static', 'assets', 'cdn', 'mail', 'blog', 'docs', 'status'])(
    '%s.example.test → reserved-handle',
    (handle) => {
      expect(parseRequestTarget(`${handle}.example.test`, '/promo')).toEqual({
        kind: 'reserved-handle',
        handle,
      });
    },
  );

  it('honours an operator override from POSTA_RESERVED_HANDLES', () => {
    const withOverride = makeRequestTargetParser({
      urls,
      reservedHandles: resolveReservedHandles(['sponsor']),
    });

    expect(withOverride('sponsor.example.test', '/promo')).toEqual({
      kind: 'reserved-handle',
      handle: 'sponsor',
    });
    // ...and the default parser, built without the override, still treats
    // it as an ordinary tenant handle.
    expect(parseRequestTarget('sponsor.example.test', '/promo')).toEqual({
      kind: 'link',
      handle: 'sponsor',
      slug: 'promo',
    });
  });

  it('reports the root of a reserved handle as reserved, not as an alarm', () => {
    // www.<domain>/ is not evidence of a broken Origin Rule — there is no
    // bio page for a handle nobody can own — so it must not fire
    // T2.1.5's handle-root counter.
    expect(parseRequestTarget('www.example.test', '/')).toEqual({
      kind: 'reserved-handle',
      handle: 'www',
    });
  });
});

describe('parseRequestTarget — paths that cannot be a slug', () => {
  // Structurally impossible slugs are refused here rather than looked up
  // and missed: a 4 KB path or an encoded traversal must cost zero Redis
  // and zero Postgres work (T2.6.8). The slug shape comes from the SAME
  // exported validator E5 creates links with, so the two can never drift
  // into "creatable but unreachable".
  it.each([
    ['/promo/extra', 'a second path segment'],
    ['/../../etc/passwd', 'traversal'],
    ['/%2e%2e%2f', 'encoded traversal'],
    ['//', 'only slashes'],
    ['///', 'only slashes'],
    [`/${'s'.repeat(65)}`, 'over the 64-char slug ceiling'],
    ['/PROMO', 'uppercase — slugs are stored lowercase, so this can never exist'],
    ['/pro mo', 'a space'],
    ['/promo!', 'punctuation outside the slug charset'],
    ['/-promo', 'a leading hyphen'],
    ['/promo-', 'a trailing hyphen'],
    ['/%00', 'a null byte'],
    ['/promo%00', 'an embedded null byte'],
    ['/%', 'a malformed percent-encoding'],
    ['/%zz', 'a malformed percent-encoding'],
  ])('%s (%s) → invalid-path', (path) => {
    expect(parseRequestTarget('juano.example.test', path)).toEqual({ kind: 'invalid-path' });
  });

  it('decodes a percent-encoded slug that is still valid', () => {
    // %70 is 'p'. Decoding happens before validation so an encoded form
    // of a legitimate slug resolves to the same link.
    expect(parseRequestTarget('juano.example.test', '/%70romo')).toEqual({
      kind: 'link',
      handle: 'juano',
      slug: 'promo',
    });
  });

  it('never throws, whatever the input', () => {
    const hostile = ['/%E0%A4%A', '/ ', '/😀', '/'.repeat(500), `/${'%41'.repeat(3000)}`];

    for (const path of hostile) {
      expect(() => parseRequestTarget('juano.example.test', path)).not.toThrow();
    }
  });
});
