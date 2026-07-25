import type { Response } from 'express';

// T2.4.1 [INV-3] — the response half of S2.4: given an already-resolved
// destination, this is what turns it into a 307. Called from
// middleware.ts's handleLinkTarget with the resolved link's `destination`
// the instant resolveLink returns a hit; enqueueing happens strictly
// AFTER, never before — see handleLinkTarget's own header comment for the
// full composition and why. This function does not GUARANTEE a 307 — a
// destination that cannot be turned into a valid Location header (see the
// `null` case below) has nothing to redirect to.
//
// [T2.5.3 fix round 1] Earlier (T2.4.1 fix round 2 through T2.5.3's first
// pass), this function answered that failure itself with a bare
// `res.status(404).end()`, and handleLinkTarget told the two outcomes
// apart by checking `res.statusCode` afterward. That made this the ONE
// terminal 404 on the redirect path that never got S2.5's branded
// document (T2.5.2): by the time handleLinkTarget regained control, this
// function had already closed the response, with nothing left to attach
// a body to — a real gap against S2.5's own acceptance criterion ("dark
// island styling in ALL cases"), caught in review. Fixed by moving the
// decision to the caller: this function now returns `true` when it sent a
// 307 and `false` when it sent NOTHING AT ALL (no status, no headers, no
// `end()`), leaving handleLinkTarget free to call the exact same
// `sendNotFound(res, renderNotFound, slug)` every other terminal branch on
// this path already uses. This also completes a pattern rather than
// introducing one: handleLinkTarget was already the sole writer of every
// OTHER terminal response on this path; now it is the sole writer of all
// of them, with no carve-out.
//
// [S2.4 fan-out fix round] Split out of middleware.ts once that file
// crossed this epic's 800-line hard cap (T2.4.5's own story-level
// review). This module is the SOLE owner of header safety for the
// redirect hot path — middleware.ts's open-redirect guard (T2.4.5)
// validates the destination's SCHEME and length; it has no opinion on
// whether a given character can survive becoming an HTTP header value at
// all, and says so explicitly in its own comment. That is this file's
// job alone: `isHeaderSafeCodePoint` and `HEADER_SAFE_DESTINATION_PATTERN`
// below encode the exact same 0x00-0xFFFF boundary (verified by an
// exhaustive sweep against a real `http.ServerResponse` — see
// `isHeaderSafeCodePoint`'s own comment), and they must stay together in
// THIS module: splitting them across a file boundary is exactly how the
// two could drift out of agreement with each other without either half
// noticing. [T2.5.3 fix round 1] Neither constant, nor the encode logic
// that uses them, changes at all in this fix — only what happens to the
// RESULT of that check (a return value instead of a self-written 404)
// changes.
//
// `res.redirect(307, destination)` is deliberately NOT used here.
// Express's res.redirect() — and res.location(), which it calls
// internally — run the URL through the `encodeurl` package before
// writing the Location header. Verified by hand against a live Express
// server: a destination containing a Latin-1 accented character (e.g.
// "promoción", the kind of destination this Spanish-first product will
// see routinely) comes back as "promoci%C3%B3n" — encodeurl re-encodes
// UNCONDITIONALLY on any character outside its own allowed set, Latin-1
// accents included, regardless of whether the source was already valid.
// That is exactly the "no normalisation, no re-encoding" this story's
// acceptance criteria rule out — the destination must reach the
// visitor's browser byte-identical to what is in storage. (encodeurl
// does NOT, however, touch an already-valid `%XX` escape sequence like
// `%2F` — it only re-escapes a `%` that is NOT part of one, e.g. `%zz`
// or a trailing `%`; see redirect-response.test.ts's percent-encoding
// case for the destination that actually demonstrates the difference.)
// res.redirect() also formats and writes a Content-Type-negotiated
// HTML/text body plus a Content-Length header on every call, work this
// hot path (every single click) has no use for. res.set() — Express's
// own header setter, NOT res.location() — writes the header value
// untouched, which is what redirect-response.test.ts's byte-identity
// cases depend on.
/**
 * Sends the 307, or reports that it could not. A destination that fails
 * to produce a valid Location header (see encodeDestinationForHeader's
 * `null` case, below) has nothing to redirect to — `false` is returned
 * with `res` left COMPLETELY untouched (no status, no headers, no
 * `end()`), so the caller (handleLinkTarget, middleware.ts) can decide
 * the terminal response on its own, the same way it already decides
 * every other 404 on this path. `true` means the 307 (Cache-Control,
 * Location, status) has already been sent in full — the caller does
 * nothing further.
 */
export function sendLinkRedirect(res: Response, destination: string): boolean {
  const encoded = encodeDestinationForHeader(destination);
  if (encoded === null) {
    return false;
  }

  res.set('Cache-Control', 'no-store');
  res.set('Location', encoded);
  res.status(307).end();
  return true;
}

// [T2.4.1 fix round 1, CRITICAL] `zDestination` (packages/contracts/src/links.ts)
// accepts an absolute http(s) URL containing ANY Unicode character —
// verified by hand: `https://example.test/日本語` and
// `https://exámple.test/x` both parse successfully. Node's raw HTTP
// header writer does not: it throws `ERR_INVALID_CHAR` synchronously for
// any code point above the Latin-1 supplement block, confirmed by direct
// measurement against a real `http.ServerResponse` on this Node version
// (0x00-0xFF swept one code point at a time; see isHeaderSafeCodePoint's
// own comment for the exact accepted set — narrower than the commonly
// cited `checkInvalidHeaderChar` regex, which does not match this
// runtime's actual behaviour). Left uncaught, that turns a
// legitimately-created link whose destination contains such a character
// into a PERMANENT per-slug outage: every request for that slug throws
// inside sendLinkRedirect, forever — worse than the 404 T2.4.5 ships for
// a genuinely malicious destination, and not something T2.4.5's guard
// (dangerous URL SCHEMES, a different concern) or E5's write-time
// validation (Redis is a second writer that write-time validation
// structurally cannot cover — the same reasoning T2.4.5's own brief
// already establishes) would catch. It is this function's problem.
//
// The fix percent-encodes ONLY the characters that would actually make
// the header write throw, leaving every already-safe character —
// including every ASCII delimiter this hot path must never touch (`/`,
// `?`, `&`, `=`, `#`) and every Latin-1 accented character — completely
// untouched, so the byte-identical guarantee for every destination that
// CAN be sent verbatim still holds exactly as before. A destination that
// needed encoding still lands the visitor on the identical target: this
// is the same transform a browser applies when it parses a URL
// containing such a character by any other route.
function isHeaderSafeCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09) return true; // horizontal tab
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true; // printable ASCII
  if (codePoint >= 0x80 && codePoint <= 0xff) return true; // Latin-1 supplement
  return false;
}

// [T2.4.1 fix round 2, INV-2] This hot path runs on every single
// redirect, and the overwhelming common case is a destination that
// needs NO transformation at all — yet the original fix round 1
// implementation ran `Array.from(destination).map(...).join('')` on
// EVERY call regardless, paying an array allocation plus a per-character
// codePointAt/function-call for a destination that never had anything to
// encode. This pattern expresses isHeaderSafeCodePoint's exact same
// 0x00-0xFF boundary (tab, printable ASCII, Latin-1 supplement) as a
// single non-allocating regex scan: when the WHOLE destination already
// matches, encodeDestinationForHeader returns it completely unchanged
// with no further work — no Array.from, no per-character loop, nothing
// beyond one `.test()` call. Only a destination containing at least one
// character outside this set falls through to the slower per-code-point
// path below, which is the rare path, not the hot one.
const HEADER_SAFE_DESTINATION_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * Percent-encodes `destination` for the Location header, touching only
 * the characters {@link isHeaderSafeCodePoint} says Node's raw header
 * writer cannot represent. Returns `null` when the destination cannot be
 * represented AT ALL — [T2.4.1 fix round 2, CRITICAL] a lone, unpaired
 * UTF-16 surrogate (malformed input with no valid Unicode representation
 * on its own) makes `encodeURIComponent` throw `URIError` rather than
 * return anything, and this IS reachable through the normal validated
 * path: `zDestination` (`z.url()`) accepts
 * `String.fromCharCode(0xd800)` embedded in an otherwise-valid URL,
 * confirmed by hand. `sendLinkRedirect` treats `null` as "no valid
 * Location exists for this destination" and reports failure to ITS OWN
 * caller (returns `false` — see that function's own doc comment, T2.5.3
 * fix round 1) rather than let the exception escape and crash the
 * request — this is a narrower, purely mechanical fact ("this string
 * cannot become a valid HTTP header value"), not the malicious-URL-scheme
 * concern T2.4.5's guard exists
 * for.
 *
 * The fast-path regex above doubles as the detector for this case with
 * no separate check needed: an unpaired surrogate's own UTF-16 code unit
 * (0xD800-0xDFFF) falls outside the regex's safe ranges exactly like a
 * CJK or emoji character's code units do, so it already falls through to
 * this per-code-point path, where the `catch` below is what actually
 * turns the throw into `null` instead of letting it propagate.
 *
 * Iterates by Unicode CODE POINT (a plain `for...of` over the string,
 * which — like `Array.from` — respects surrogate PAIRS) so a
 * supplementary-plane character such as an emoji is read and encoded as
 * the single code point it is, not as two broken halves; see
 * redirect-response.test.ts's emoji case, which specifically exercises
 * this. `encodeURIComponent` on that one resulting character/pair
 * produces its exact percent-encoded UTF-8 bytes.
 */
function encodeDestinationForHeader(destination: string): string | null {
  if (HEADER_SAFE_DESTINATION_PATTERN.test(destination)) {
    return destination;
  }

  const parts: string[] = [];
  for (const char of destination) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isHeaderSafeCodePoint(codePoint)) {
      parts.push(char);
      continue;
    }
    try {
      parts.push(encodeURIComponent(char));
    } catch {
      return null;
    }
  }
  return parts.join('');
}
