import { describe, expect, it } from 'vitest';
import { escapeHtml, MAX_ESCAPED_HTML_LENGTH } from './escape-html';

// T2.5.1 [security] — escapeHtml is the single control standing between
// attacker-controlled path input (the requested slug) and the one HTML
// document the API renders (S2.5's 404 page). Table-driven over the
// payloads the brief names verbatim, plus the boundary cases a
// hand-rolled escaper most commonly gets wrong: escape ordering,
// oversized input, and multibyte truncation.

const RAW_DANGEROUS_CHARACTERS = ['&', '<', '>', '"', "'", '/'];

// Strips every WELL-FORMED entity escapeHtml can produce, so what
// remains can be checked for a raw dangerous character with a plain
// substring test. A naive "result.includes('&')" check would be
// trivially true for almost any escaped output, since every one of
// these entities itself starts with a literal '&' by definition (that
// is what makes it an entity) — the meaningful question is whether a
// dangerous character survives OUTSIDE a well-formed entity, which is
// exactly what stripping the known-safe entities first isolates.
const KNOWN_ENTITIES = /&amp;|&lt;|&gt;|&quot;|&#x27;|&#x2F;/g;
function withoutKnownEntities(s: string): string {
  return s.replace(KNOWN_ENTITIES, '');
}

// A lone (unpaired) UTF-16 surrogate: a high surrogate not followed by a
// low one, or a low surrogate not preceded by a high one. This is the
// exact shape a naive `.slice(0, n)` clamp produces when it cuts through
// the middle of a surrogate pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

describe('escapeHtml — hostile payloads from the brief', () => {
  it('escapes a script-closing tag', () => {
    expect(escapeHtml('</script>')).toBe('&lt;&#x2F;script&gt;');
  });

  it('escapes an attribute-breakout image payload', () => {
    expect(escapeHtml('"><img src=x onerror=alert(1)>')).toBe(
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('escapes a quote-and-comment-breakout payload', () => {
    expect(escapeHtml("'; alert(1); //")).toBe('&#x27;; alert(1); &#x2F;&#x2F;');
  });
});

describe('escapeHtml — ampersand-first ordering', () => {
  // The classic hand-rolled-escaper bug: escaping '<' before '&' turns
  // "<" into "&lt;", and then a SECOND pass over '&' (run after, over
  // the already-substituted output rather than the original string)
  // corrupts it into "&amp;lt;". A single scan over the SOURCE string —
  // not a chain of sequential .replace() calls — makes that bug
  // structurally unreachable rather than merely avoided by getting the
  // call order right.
  it('double-escapes a literal ampersand entity, proving no accidental second pass', () => {
    // The brief's own test: escapeHtml does not recognise or decode
    // existing entities, so a literal "&amp;" in the input has its own
    // '&' escaped once, same as any other character — correctly
    // producing "&amp;amp;", not a no-op.
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('escapes a bare "<" to exactly one entity, not a corrupted double-escape', () => {
    expect(escapeHtml('<')).toBe('&lt;');
  });
});

describe('escapeHtml — length clamp', () => {
  it('clamps a 10 KB string so it cannot inflate the response', () => {
    const oversized = '<'.repeat(10 * 1024);

    const result = escapeHtml(oversized);

    expect(result.length).toBeLessThanOrEqual(MAX_ESCAPED_HTML_LENGTH);
    // Every character that survived the clamp is still a whole, valid
    // entity rather than a truncated fragment like "&l" — the input here
    // becomes a repeated 4-character entity ("&lt;"), so a result whose
    // length isn't a clean multiple of 4 would mean the clamp cut
    // through an entity rather than around it.
    expect(result).toBe('&lt;'.repeat(result.length / 4));
  });

  it('does not clamp input at or under the limit', () => {
    const atLimit = 'a'.repeat(MAX_ESCAPED_HTML_LENGTH);

    expect(escapeHtml(atLimit)).toBe(atLimit);
  });
});

describe('escapeHtml — multibyte input', () => {
  // An emoji outside the Basic Multilingual Plane is a UTF-16 surrogate
  // PAIR (two code units for one code point). This epic has already
  // shipped a lone-surrogate bug once (redirect-response.ts's
  // encodeDestinationForHeader, for the Location header) — treated here
  // as a known hazard, not a hypothetical.
  const EMOJI = '\u{1F600}'; // 😀 — U+1F600, a surrogate pair in UTF-16.

  it('preserves a surrogate pair well under the clamp', () => {
    expect(escapeHtml(EMOJI)).toBe(EMOJI);
  });

  it('does not split a surrogate pair at the clamp boundary', () => {
    // A single leading ASCII character shifts every emoji pair onto an
    // ODD starting offset. MAX_ESCAPED_HTML_LENGTH is even, so a naive
    // `.slice(0, MAX_ESCAPED_HTML_LENGTH)` on this exact construction
    // would cut between a pair's high and low surrogate, landing on a
    // lone high surrogate as the very last character — this is what
    // actually exercises the split, rather than an input that happens to
    // stay aligned on pair boundaries by coincidence.
    const repeated = 'a' + EMOJI.repeat(200);

    const result = escapeHtml(repeated);

    expect(result.length).toBeLessThanOrEqual(MAX_ESCAPED_HTML_LENGTH);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it('escapes ASCII characters alongside an untouched multibyte character', () => {
    expect(escapeHtml(`<${EMOJI}>`)).toBe(`&lt;${EMOJI}&gt;`);
  });
});

describe('escapeHtml — edge cases', () => {
  it('returns the empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes a string made up of only escapable characters', () => {
    expect(escapeHtml('&<>"\'/')).toBe('&amp;&lt;&gt;&quot;&#x27;&#x2F;');
  });

  it('leaves a string with nothing to escape completely unchanged', () => {
    expect(escapeHtml('promo-2026')).toBe('promo-2026');
  });
});

describe('escapeHtml — no raw dangerous character survives, across every case above', () => {
  it.each([
    ['</script>'],
    ['"><img src=x onerror=alert(1)>'],
    ["'; alert(1); //"],
    ['&amp;'],
    ['<'.repeat(10 * 1024)],
    [`<${'\u{1F600}'}>`],
    ['&<>"\'/'],
  ])('output for %j has no raw character outside a known-safe entity', (input) => {
    const remainder = withoutKnownEntities(escapeHtml(input));

    for (const char of RAW_DANGEROUS_CHARACTERS) {
      expect(remainder.includes(char)).toBe(false);
    }
  });
});
