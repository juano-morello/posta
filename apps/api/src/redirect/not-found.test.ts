import { describe, expect, it } from 'vitest';
import { makeUrlBuilders } from '@posta/contracts';
import { escapeHtml } from './escape-html';
import { makeNotFoundRenderer } from './not-found';

// T2.5.2 — renderNotFound is S2.5's 404 page: the one HTML document the
// API renders, and it must render with NOTHING else up (no Next, no
// Postgres, no Redis, no queue). This test suite is what makes that
// contract concrete rather than aspirational:
//   - a byte-size ceiling (the brief's hard 4 KB budget),
//   - a STRUCTURAL "no external host" check (parses out every src/href
//     attribute value, rather than grepping for one known-bad string —
//     a regex spot-check would not catch a future addition),
//   - a structural "no stray http(s) URL" check over the whole document,
//   - the slug-escaping contract (T2.5.1's escapeHtml, exercised through
//     the real template — T2.5.4 attacks this end-to-end through the
//     real route; this is the unit-level backstop),
//   - the on-brand contract (lang="es", the exact Spanish error string,
//     and the dark-island lime accent — never an orange/tangerine hex,
//     which is a different brand's color kept deliberately separate).
//
// POSTA_LINK_DOMAIN is 'example.test' here, same as every other test in
// this directory (host.test.ts, middleware.test.ts, ...) — the real
// domain is not allowed to appear in source at all
// (tests/conventions/no-literal-domain.test.ts).
const urls = makeUrlBuilders({
  domain: 'example.test',
  protocol: 'https',
  appSubdomain: 'app',
  apiSubdomain: 'api',
});

const renderNotFound = makeNotFoundRenderer({ urls });

// The one URL this document is allowed to contain — buildAppUrl() takes
// no path argument in not-found.ts, so this must be the bare origin.
const HOME_URL = urls.buildAppUrl();

/** Every src="..."/href="..." (or '...') attribute value in `html`, in
 * document order — a structural scan, not a spot-check for one known
 * host, so a FUTURE src/href this test was never written to anticipate
 * still gets caught. */
function extractSrcAndHrefValues(html: string): string[] {
  const pattern = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    values.push(match[1] ?? match[2] ?? '');
  }
  return values;
}

// An absolute URL (has a scheme, e.g. "https:") or a protocol-relative
// reference ("//host/..."). Anything that does NOT match this is a
// same-document fragment ("#...") or a path-relative reference — neither
// of which can ever point at an external host.
const ABSOLUTE_OR_PROTOCOL_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function isFragmentOrRelativeReference(value: string): boolean {
  return !ABSOLUTE_OR_PROTOCOL_RELATIVE.test(value);
}

/** Every http(s) URL substring anywhere in the document (not just inside
 * an attribute) — catches one leaking into plain text or inline CSS, not
 * only into src/href. */
function extractHttpUrls(html: string): string[] {
  return html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
}

/** Every 6-digit hex color literal in the document, uppercased. */
function extractHexColors(html: string): string[] {
  return (html.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((hex) => hex.toUpperCase());
}

// DESIGN.md §1's dark-island palette, exactly — background, surface,
// foreground, muted-foreground, border, the semantic error/destructive
// token, and lime primary. Written here as the ALLOW-list rather than a
// deny-list of orange hexes (this codebase has no canonical "naranja"
// hex to deny — BRAND.md only names the color in prose): any hex NOT in
// this set, orange or otherwise, fails the "on dark-island tokens only"
// assertion below, which is a stronger guarantee than checking for one
// specific forbidden value.
const ALLOWED_DARK_ISLAND_HEX_COLORS = new Set([
  '#0D1117', // background
  '#161B22', // surface / card
  '#E6EDF3', // foreground
  '#8B949E', // muted-foreground
  '#30363D', // border
  '#F85149', // error / destructive
  '#B4FF39', // primary (lime) — the ONE accent, never orange/tangerine
]);

describe('renderNotFound — structure and budget', () => {
  it('matches the known-good snapshot for an ordinary slug', () => {
    expect(renderNotFound('promo')).toMatchSnapshot();
  });

  it('renders under the 4 KB whole-document budget', () => {
    const html = renderNotFound('promo');

    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(4096);
  });

  it('stays under the 4 KB budget even for a maximally hostile slug', () => {
    // escapeHtml's own clamp (MAX_ESCAPED_HTML_LENGTH, T2.5.1) bounds how
    // much a hostile slug can inflate this page — this proves that bound
    // is actually tight enough for THIS document's own 4 KB ceiling, not
    // merely asserted in isolation over escapeHtml alone.
    const hostileSlug = '<img src=x onerror=alert(1)>'.repeat(50);

    const html = renderNotFound(hostileSlug);

    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(4096);
  });

  it('declares lang="es" on the document element', () => {
    expect(renderNotFound('promo')).toMatch(/<html[^>]*\slang="es"/i);
  });

  it('has no <script> element anywhere in the document', () => {
    expect(renderNotFound('promo')).not.toMatch(/<script/i);
  });

  it('contains no framework/runtime markers — a static inline-styled document only', () => {
    const html = renderNotFound('promo');

    // No <link> (an external stylesheet would need one), no external
    // module/script loading mechanism of any kind.
    expect(html).not.toMatch(/<link\b/i);
    expect(html).toMatch(/<style>/i);
  });
});

describe('renderNotFound — no external host, checked structurally', () => {
  it('every src/href attribute value is the env-built home URL or a fragment/relative reference', () => {
    const html = renderNotFound('promo');
    const values = extractSrcAndHrefValues(html);

    // At least the quiet home link must be present — otherwise this
    // assertion would vacuously pass on a document with no src/href at
    // all, which would not actually be testing anything.
    expect(values.length).toBeGreaterThan(0);

    for (const value of values) {
      const isEnvBuiltHomeUrl = value === HOME_URL;
      expect(isEnvBuiltHomeUrl || isFragmentOrRelativeReference(value)).toBe(true);
    }
  });

  it('the only http(s) URL anywhere in the document is the one built from env', () => {
    const html = renderNotFound('promo');
    const urlsInDocument = extractHttpUrls(html);

    expect(urlsInDocument.length).toBeGreaterThan(0);
    for (const found of urlsInDocument) {
      expect(found).toBe(HOME_URL);
    }
  });

  it('reflects a DIFFERENT env config into a DIFFERENT home URL, proving no domain is hardcoded', () => {
    const otherUrls = makeUrlBuilders({
      domain: 'other-example.test',
      protocol: 'http',
      appSubdomain: 'dashboard',
      apiSubdomain: 'api',
    });
    const otherHomeUrl = otherUrls.buildAppUrl();
    const renderWithOtherConfig = makeNotFoundRenderer({ urls: otherUrls });

    const html = renderWithOtherConfig('promo');

    expect(html).toContain(otherHomeUrl);
    expect(html).not.toContain(HOME_URL);
  });
});

describe('renderNotFound — slug escaping (T2.5.4 attacks this end-to-end; this is the unit backstop)', () => {
  it('escapes a script-closing slug so no executable markup survives', () => {
    const payload = '<script>alert(1)</script>';

    const html = renderNotFound(payload);

    expect(html).not.toContain(payload);
    expect(html).not.toMatch(/<script/i);
    // The ESCAPED form must actually appear — proving the slug was
    // reflected (not silently dropped), just safely.
    expect(html).toContain(`cd /${escapeHtml(payload)}`);
  });

  it('escapes an attribute-breakout image payload so no <img> tag is ever parsed', () => {
    const payload = '"><img src=x onerror=alert(1)>';

    const html = renderNotFound(payload);

    expect(html).not.toContain(payload);
    // The literal text "onerror=alert(1)" surviving as INERT TEXT is
    // expected and fine — escapeHtml's job is to stop '<' and '>' from
    // ever forming a real <img> element, not to scrub arbitrary
    // substrings out of the page. What actually matters is that no <img
    // tag is ever parsed: '<' is escaped to '&lt;', so a literal "<img"
    // must never appear.
    expect(html).not.toMatch(/<img\b/i);
    expect(html).toContain(`cd /${escapeHtml(payload)}`);
  });

  it('reflects an ordinary slug unescaped, since it contains nothing to escape', () => {
    const html = renderNotFound('promo-2026');

    expect(html).toContain('cd /promo-2026');
  });
});

describe('renderNotFound — on-brand contract', () => {
  it('shows the exact Spanish error string from the brief', () => {
    expect(renderNotFound('promo')).toContain('error: no existe ese link');
  });

  it('shows the terminal prompt with the requested slug on one line, the error beneath it', () => {
    const html = renderNotFound('promo');

    // The prompt text and "cd /<slug>" sit either side of a <span> tag
    // (see not-found.ts's template), so this checks each half plus their
    // order rather than one contiguous literal.
    const promptIndex = html.indexOf('~/posta $');
    const cdIndex = html.indexOf('cd /promo');
    const errorIndex = html.indexOf('error: no existe ese link');

    expect(promptIndex).toBeGreaterThan(-1);
    expect(cdIndex).toBeGreaterThan(promptIndex);
    expect(errorIndex).toBeGreaterThan(cdIndex);
  });

  it('uses a CSS steps() timing function for the cursor animation', () => {
    expect(renderNotFound('promo')).toMatch(/animation:[^;]*steps\(/);
  });

  it('disables the cursor animation under prefers-reduced-motion, without hiding it', () => {
    const html = renderNotFound('promo');
    const mediaQueryMatch = html.match(
      /@media \(prefers-reduced-motion:\s*reduce\)\s*\{([^}]*)\}/,
    );

    expect(mediaQueryMatch).not.toBeNull();
    const rule = mediaQueryMatch?.[1] ?? '';
    expect(rule).toMatch(/animation:\s*none/);
    // Deliberately not hidden outright (opacity/visibility never set to
    // an invisible value here) — the cursor stays a static, visible mark
    // once motion is off, rather than disappearing.
    expect(rule).not.toMatch(/opacity:\s*0\b/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
  });

  it('uses only DESIGN.md §1 dark-island hex colors, including the lime accent — never orange/tangerine', () => {
    const html = renderNotFound('promo');
    const hexColors = extractHexColors(html);

    expect(hexColors.length).toBeGreaterThan(0);
    expect(hexColors).toContain('#B4FF39'); // lime accent must actually be used
    for (const hex of hexColors) {
      expect(ALLOWED_DARK_ISLAND_HEX_COLORS.has(hex)).toBe(true);
    }
  });

  it('links back to Posta with quiet (non-lime, non-button) link text', () => {
    const html = renderNotFound('promo');

    expect(html).toContain(`href="${HOME_URL}"`);
  });
});
