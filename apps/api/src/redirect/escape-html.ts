import { SLUG_MAX_LENGTH } from '@posta/contracts';

// T2.5.1 [security] — S2.5's 404 page (T2.5.2) reflects the requested
// slug back to the visitor, and that slug is attacker-controlled path
// input. This is the ONE place in this epic where a one-character
// mistake is a stored-XSS-shaped bug, which is why it gets its own
// module and its own test rather than being a two-line inline function
// beside the template.
//
// This helper escapes for HTML TEXT CONTENT *and* HTML ATTRIBUTE VALUES
// alike — it has no notion of which context its caller drops the result
// into, and escaping all six characters below is what makes that safe
// either way. A future caller must not read more into it than that: it
// does not know about, say, a JS-string context inside a <script> tag
// (a different escaping problem) or a URL context — it is a
// single-purpose HTML escaper, nothing more.

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

const ESCAPABLE_CHARACTERS = /[&<>"'/]/g;

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
 * The clamp runs AFTER escaping, not before: what is being bounded is
 * the RESPONSE the escaped output becomes part of, and clamping the
 * INPUT would still let escaping inflate the output up to ~6x past
 * whatever input limit was chosen — the exact inflation this clamp
 * exists to prevent. Truncation walks the escaped string by Unicode
 * CODE POINT (a `for...of` loop, which — like `Array.from` — treats a
 * UTF-16 surrogate pair as one unit) rather than slicing by UTF-16 code
 * UNIT count, so a multibyte character (an emoji, any supplementary-
 * plane character) straddling the cutoff is dropped whole rather than
 * split into a lone surrogate. A lone surrogate in the response body is
 * invalid UTF-16/UTF-8 on the wire — this epic has already shipped that
 * exact class of bug once, in the redirect Location header (see
 * redirect-response.ts's encodeDestinationForHeader), so it is treated
 * here as a known hazard, not a hypothetical.
 */
export function escapeHtml(s: string): string {
  const escaped = s.replace(ESCAPABLE_CHARACTERS, (char) => ESCAPE_ENTITIES[char] ?? char);
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
