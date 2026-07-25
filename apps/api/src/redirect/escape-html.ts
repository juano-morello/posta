import { SLUG_MAX_LENGTH } from '@posta/contracts';

// T2.5.1 [security] — S2.5's 404 page (T2.5.2) reflects the requested
// slug back to the visitor, and that slug is attacker-controlled path
// input. This is the ONE place in this epic where a one-character
// mistake is a stored-XSS-shaped bug, which is why it gets its own
// module and its own test rather than being a two-line inline function
// beside the template.
//
// [fix round 1] This helper escapes for HTML TEXT CONTENT and for
// QUOTED HTML ATTRIBUTE VALUES (delimited by " or ') — escaping all six
// characters below is what makes both of those safe with the SAME
// output, with no notion of which one its caller is producing. It does
// NOT make an UNQUOTED attribute value safe:
// `<div data-slug=${escapeHtml(slug)}>` with a slug like
// `x onmouseover=alert(1)` breaks out via a bare space without touching
// any of the six escaped characters — a future caller must always QUOTE
// the attribute it interpolates this into. Also out of scope, so a
// future caller does not assume more than this function provides:
//   - a backtick-delimited attribute value (`` `...` ``, a legacy IE
//     quirks-mode attribute delimiter) — `escapeHtml('`')` returns the
//     backtick untouched;
//   - a JS-string literal inside an inline <script> block (a different
//     escaping problem entirely);
//   - a URL context (query string, href attribute target).
// It is a single-purpose HTML escaper for text content and quoted
// attributes, nothing more.

/**
 * Every character this function escapes, and the exact entity it
 * becomes. Hex numeric references for the quote characters (`&#x27;`,
 * `&#x2F;`) rather than the named `&apos;`/`&sol;` — `&apos;` was never
 * defined in HTML4, so the numeric form is the portable one.
 */
const ESCAPE_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  // Not strictly required for HTML text content on its own, but kept
  // deliberately: it hardens against a `</script>` sequence closing an
  // inline <script> block early, which none of the other five
  // characters can do by themselves. A future "simplify the escaper"
  // pass should not drop this on the reasoning that '/' is inert in
  // bare text — it stops being inert the moment it sits next to a '<'.
  '/': '&#x2F;',
};

// [fix round 1] Characters that carry a distinct meaning INSIDE a
// `[...]` character class even though most regex metacharacters lose
// their special meaning there: `]` closes the class, `^` negates it
// when it is the class's first character, `-` forms a range with its
// neighbours, and `\` is the class's own escape character. None of
// ESCAPE_ENTITIES' current keys need escaping for this, but deriving
// the pattern from the map's OWN keys below — rather than hand-writing
// a second literal that merely happens to agree with it today — means
// the two can never drift apart if a future key is added. Escaping
// correctly here, instead of relying on today's six characters not
// needing it, is what keeps that true the day one of THESE four
// characters becomes a key.
const CHARACTER_CLASS_METACHARACTERS = /[\]^\\-]/;

function escapeForCharacterClass(char: string): string {
  return CHARACTER_CLASS_METACHARACTERS.test(char) ? `\\${char}` : char;
}

const ESCAPABLE_CHARACTERS = new RegExp(
  `[${Object.keys(ESCAPE_ENTITIES).map(escapeForCharacterClass).join('')}]`,
  'g',
);

/**
 * The INPUT length ceiling, applied BEFORE escaping runs.
 *
 * [fix round 1] MAX_ESCAPED_HTML_LENGTH alone bounds the RESPONSE, but
 * `.replace()` still has to walk — and, when it substitutes, allocate —
 * up to ~6x the INPUT length before that clamp ever gets a chance to
 * run. Leaving the input unbounded meant this function's own cost
 * ceiling was an accident of Node's ~16 KB HTTP request-line limit, a
 * setting owned by a different layer entirely — the exact "safe by
 * accident" shape this epic has been closing everywhere else (see e.g.
 * host.ts's own MAX_ENCODED_SLUG_LENGTH check, which rejects an
 * oversized path before decoding it for the identical reason). Bounding
 * the input here makes the escaper's own cost a property of THIS
 * module, not a borrowed guarantee from an HTTP server setting defined
 * elsewhere.
 *
 * `SLUG_MAX_LENGTH * 2` (128): a small, deliberate multiple of the one
 * length constant this module already anchors to, comfortably bigger
 * than any legitimate slug (<=64 chars) could ever need, small enough
 * that even the widest per-character expansion (6 characters, e.g.
 * `&quot;`) on every one of its 128 characters — 768 — safely clears
 * MAX_ESCAPED_HTML_LENGTH (384), so the OUTPUT clamp remains the
 * property that actually bounds the worst case. For a low- or
 * no-expansion input (most of an attacker's filler text, which by
 * definition contains few or none of the six special characters), THIS
 * bound is what actually governs in practice, yielding a shorter result
 * than 384 — which is fine: this path only ever serves a slug that
 * could never be a real link, so there is no display fidelity of a real
 * link being sacrificed, only an upper bound on how much of an
 * attacker's garbage this function will ever process or echo.
 */
export const MAX_INPUT_LENGTH = SLUG_MAX_LENGTH * 2;

/**
 * The escaped-OUTPUT length ceiling. A legitimate slug
 * (`isValidSlug`/`SLUG_PATTERN`, `@posta/contracts`) can never contain
 * any of the six characters above at all — its charset is
 * `[a-z0-9-]` — so this clamp never fires for a link that could
 * actually exist. It exists purely to bound how much an illegitimate,
 * attacker-crafted path can inflate the 404 response.
 *
 * `SLUG_MAX_LENGTH * 6` is the worst-case escaped size a
 * legitimate-LENGTH (<=64 char) slug could reach if every one of its
 * characters happened to need the widest entity this map produces (6
 * characters, e.g. `&quot;`) — even though no real slug's charset ever
 * lets that happen. Anything this clamp actually cuts was already
 * outside what a real link's slug could be, so no fidelity is being
 * sacrificed, only response-size inflation being capped. 384 characters
 * is comfortably inside T2.5.2's whole-document 4 KB page budget.
 */
export const MAX_ESCAPED_HTML_LENGTH = SLUG_MAX_LENGTH * 6;

/**
 * Escapes `s` for safe inclusion in an HTML document — `&`, `<`, `>`,
 * `"`, `'` and `/` — then clamps the ESCAPED result to
 * {@link MAX_ESCAPED_HTML_LENGTH} characters.
 *
 * Escaping is a SINGLE pass over the original string (`String.replace`
 * with one global regex, looked up against one character map) rather
 * than a chain of sequential per-character `.replace()` calls. That is
 * deliberate, not a style preference: a sequential chain that escapes
 * `&` anywhere but first would re-scan its OWN prior output and
 * double-escape an ampersand a previous substitution just introduced
 * (escape `<` to `&lt;` first, then run the `&` rule, and it corrupts
 * into `&amp;lt;`) — the classic hand-rolled-escaper bug. Scanning the
 * SOURCE string once makes that ordering question, and that bug,
 * structurally unreachable rather than merely avoided by getting the
 * call order right. `escapeHtml('&amp;')` correctly comes back as
 * `'&amp;amp;'`: this function does not parse or decode existing
 * entities, it only escapes the raw characters actually present in the
 * input, exactly once each.
 *
 * [fix round 1] The INPUT is ALSO bounded, to {@link MAX_INPUT_LENGTH},
 * BEFORE escaping runs — see that constant's own comment for why an
 * output-only clamp left the `.replace()` call's own cost tied to an
 * HTTP-layer setting this module has no business depending on. Both
 * truncation steps reuse the SAME {@link truncateAtCodePointBoundary}
 * helper rather than each hand-rolling its own slice, specifically so
 * the surrogate-pair safety below applies at both boundaries identically
 * rather than being re-derived (and possibly gotten wrong) twice.
 *
 * Whichever clamp actually ends up binding for a given input — the
 * escaped-output ceiling ({@link MAX_ESCAPED_HTML_LENGTH}) for a
 * heavily-escaped input, or the input ceiling for one with little or
 * nothing to escape — truncation walks by Unicode CODE POINT (a
 * `for...of` loop, which — like `Array.from` — treats a UTF-16 surrogate
 * pair as one unit) rather than slicing by UTF-16 code UNIT count, so a
 * multibyte character (an emoji, any supplementary-plane character)
 * straddling a cutoff is dropped whole rather than split into a lone
 * surrogate. A lone surrogate in the response body is invalid
 * UTF-16/UTF-8 on the wire — this epic has already shipped that exact
 * class of bug once, in the redirect Location header (see
 * redirect-response.ts's encodeDestinationForHeader), so it is treated
 * here as a known hazard, not a hypothetical.
 */
export function escapeHtml(s: string): string {
  const boundedInput = truncateAtCodePointBoundary(s, MAX_INPUT_LENGTH);
  const escaped = boundedInput.replace(
    ESCAPABLE_CHARACTERS,
    (char) => ESCAPE_ENTITIES[char] ?? char,
  );
  return truncateAtCodePointBoundary(escaped, MAX_ESCAPED_HTML_LENGTH);
}

/**
 * Truncates `s` to at most `maxLength` UTF-16 code units without ever
 * splitting a surrogate pair in two.
 */
function truncateAtCodePointBoundary(s: string, maxLength: number): string {
  // Fast path: UTF-16 code UNIT count is always >= code POINT count, so
  // a string already at or under maxLength code units can never exceed
  // it in code points either, and needs no per-character walk at all —
  // the overwhelmingly common case, since a legitimate slug never
  // reaches this clamp in the first place.
  if (s.length <= maxLength) return s;

  let result = '';
  let length = 0;
  for (const codePoint of s) {
    // codePoint.length is 1 for a BMP character, 2 for a surrogate pair
    // — this is what keeps a pair from ever being split: it is admitted
    // or rejected as a whole two-unit step, never half of one.
    if (length + codePoint.length > maxLength) break;
    result += codePoint;
    length += codePoint.length;
  }
  return result;
}
