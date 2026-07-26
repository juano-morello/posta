import { describe, expect, it } from 'vitest';
import { escapeHtml, MAX_ESCAPED_HTML_LENGTH, MAX_INPUT_LENGTH } from './escape-html';

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

    // [fix round 1] Two clamps now run in sequence: the 10 KB input is
    // first bounded to MAX_INPUT_LENGTH (128 '<' survive), THEN escaped
    // (128 * 4 = 512 chars), THEN the output is bounded to
    // MAX_ESCAPED_HTML_LENGTH (384). The net observable result is
    // identical to a single output-only clamp for this heavily-escaping
    // input — both give the same 96 whole "&lt;" entities — because 512
    // already exceeds 384, so the output clamp is still what ultimately
    // governs here; only the intermediate allocation size changed.
    expect(result.length).toBeLessThanOrEqual(MAX_ESCAPED_HTML_LENGTH);
    // [S2.5 fan-out review, corrected] Every character that survived the
    // clamp is still a whole, valid entity here — but that is a property
    // of THIS input's uniform expansion width ('<' -> '&lt;', always 4
    // chars), not a guarantee escapeHtml makes in general. The clamp
    // (truncateAtCodePointBoundary, escape-html.ts) is a flat code-point
    // cut with zero entity-boundary awareness — it only ever protects a
    // surrogate PAIR from being split, nothing about where an entity
    // starts or ends. A result whose length happens to be a clean
    // multiple of 4 here is simply what a same-width-entity input
    // produces; see the mixed-entity-width case directly below for the
    // input where it is NOT true, and why that is still safe.
    expect(result).toBe('&lt;'.repeat(result.length / 4));
  });

  // [S2.5 fan-out review] The test above's "clean multiple of 4" observation
  // does not generalize — demonstrated here, not merely asserted, with the
  // exact construction the security review used to prove it: 63 quote
  // characters (each escaping to the WIDER 6-char '&#x27;') followed by
  // two '<' characters (each escaping to '&lt;'). 63*6 = 378 raw escaped
  // chars before either '<' is even reached; the first '<' fits whole
  // (378-382), but the second only has 384-382 = 2 of its 4 escaped
  // characters left before MAX_ESCAPED_HTML_LENGTH cuts it off — landing
  // exactly on the dangling fragment "&l" the earlier test's comment used
  // as its counterexample.
  it('can truncate MID-entity once two different entity widths are mixed — real behavior, not a bug', () => {
    const mixedWidthInput = "'".repeat(63) + '<<';

    const result = escapeHtml(mixedWidthInput);

    expect(result.length).toBe(MAX_ESCAPED_HTML_LENGTH);
    expect(result).toBe(`${'&#x27;'.repeat(63)}&lt;&l`);
    // [security review] This dangling fragment is NOT exploitable in
    // this document: HTML tokenization reads raw input left-to-right and
    // never re-scans its own decoded output, so a decoded '<' appearing
    // this late in the page has no unescaped '>' or attacker-controlled
    // markup after it (only the template's own static, trusted HTML) to
    // complete a tag with. That safety belongs to not-found.ts's TEMPLATE
    // shape — exactly one interpolation site, nothing attacker-controlled
    // downstream of it — not to this escaper; a future template with a
    // second interpolation point after this one could not rely on the
    // same reasoning. See not-found-xss.test.ts for the end-to-end proof
    // against the real template.
  });

  it('leaves content under both the input and output bounds untouched', () => {
    const untouched = 'promo-'.repeat(10); // 60 chars, well under either bound

    expect(escapeHtml(untouched)).toBe(untouched);
  });

  it('does not clamp escaped output landing exactly at the output limit', () => {
    // 64 quote characters is well under MAX_INPUT_LENGTH (128), so the
    // input bound is a no-op here — this isolates the OUTPUT clamp's own
    // boundary behaviour. Each '"' becomes the widest entity ('&quot;',
    // 6 chars), so 64 * 6 = 384 lands EXACTLY on MAX_ESCAPED_HTML_LENGTH.
    // The `<=` (not `<`) in the clamp's fast path is what a test like
    // this actually protects: an off-by-one there would truncate a
    // result that was already exactly at the limit.
    const atOutputLimit = '"'.repeat(64);

    const result = escapeHtml(atOutputLimit);

    expect(result.length).toBe(MAX_ESCAPED_HTML_LENGTH);
    expect(result).toBe('&quot;'.repeat(64));
  });

  it('bounds the INPUT length before escaping runs, not only the escaped output', () => {
    // [fix round 1] 'a' needs no escaping at all, so an output-only
    // clamp would let this straight through to MAX_ESCAPED_HTML_LENGTH
    // (384) unchanged. If the input bound below were removed, this
    // assertion would fail with a 384-character result instead of a
    // 128-character one — proving the input IS being truncated before
    // `.replace()` ever sees the rest of it, not merely that the final
    // output happens to be short.
    const huge = 'a'.repeat(1_000_000);

    const result = escapeHtml(huge);

    expect(result).toBe('a'.repeat(MAX_INPUT_LENGTH));
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

  it('does not split a surrogate pair at the OUTPUT clamp boundary', () => {
    // Isolates the OUTPUT boundary specifically: 'a' + 63 '"' characters
    // is 64 raw characters, well under MAX_INPUT_LENGTH (128), so the
    // input bound is a no-op and cannot be what protects this case.
    // Escaped, that prefix is 1 + 63*6 = 379 characters — an ODD escaped
    // offset — so the emoji sequence right after it starts at an odd
    // position in the ESCAPED string. A naive `.slice(0, 384)` on this
    // exact construction lands index 383 on the high surrogate of the
    // third emoji (379 + 2*2 = 383) and excludes index 384 (its low
    // surrogate) — hand-traced, not assumed — which is what actually
    // exercises a split at THIS boundary, independent of the input-bound
    // fix.
    const prefix = 'a' + '"'.repeat(63);
    const oversized = prefix + EMOJI.repeat(5);

    const result = escapeHtml(oversized);

    expect(result.length).toBeLessThanOrEqual(MAX_ESCAPED_HTML_LENGTH);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it('does not split a surrogate pair at the INPUT clamp boundary', () => {
    // [fix round 1] A single leading ASCII character shifts every emoji
    // pair onto an ODD starting offset. MAX_INPUT_LENGTH is even, so a
    // naive `.slice(0, MAX_INPUT_LENGTH)` applied to the RAW input
    // (before escaping) would cut between a pair's high and low
    // surrogate — this is what actually exercises a split at the NEW
    // input boundary, as opposed to the pre-existing output boundary
    // above. None of these characters are escapable, so the escaped
    // length equals the input-bounded length exactly, isolating the
    // input-side truncation's own correctness.
    const repeated = 'a' + EMOJI.repeat(200);

    const result = escapeHtml(repeated);

    expect(result.length).toBeLessThanOrEqual(MAX_INPUT_LENGTH);
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
