// T3.2.2 (E3, S3.2) — the in-app browser marker table and isInApp(), the
// seam the worker's enrichment step (a later E3 task) calls with the raw
// User-Agent header off every captured event.
//
// Filename note: this is source-platform.ts, NOT is-in-app.ts, even though
// today's test file is is-in-app.test.ts. That is deliberate, not a
// mismatch to "fix" — T3.2.3 (a later task) adds a source_platform
// resolver (referer first, then these same UA markers) to THIS file, so
// the filename already reflects the module's eventual full scope. Only
// IN_APP_MARKERS and isInApp() exist here for now.
//
// IN_APP_MARKERS is exported rather than inlined into isInApp() because
// T3.2.3's resolver needs the identical list to decide source_platform
// from the same UA. A second, separately maintained copy of these six
// strings would risk drifting from this one — the plan calls out exactly
// that failure mode: an event that is is_in_app: true with
// source_platform: 'directo'. One exported array, read by both.
//
// Pure and deterministic: no I/O, no Date.now(), no network — same input,
// same output, forever, matching ua.ts's own purity contract in this
// directory.
//
// isInApp() reports a FACT — "one of these marker substrings was present
// in this UA string" — never a bot/human verdict (invariant 4: "the
// worker enriches; it does not judge"). There is no isBot field here and
// there must never be one; that verdict is computed later, read-time, by
// the events_classified SQL view.

/**
 * Substrings that identify a request as coming from an in-app (embedded
 * webview) browser rather than a full standalone browser — Instagram,
 * Facebook (iOS and Android build tags), TikTok, a generic ByteDance
 * webview, and LINE. Matched case-sensitively as plain substrings against
 * the raw User-Agent header; see {@link isInApp}.
 */
export const IN_APP_MARKERS = ['Instagram', 'FBAN', 'FBAV', 'TikTok', 'BytedanceWebview', 'Line'] as const;

/**
 * Reports whether a User-Agent header contains any known in-app browser
 * marker substring (case-sensitive). Returns `false` for `null` and for a
 * UA that matches none of {@link IN_APP_MARKERS} — never throws.
 *
 * This is a fact about UA string content, not a bot/human verdict
 * (invariant 4): an in-app browser is still a real person tapping a real
 * link, just from inside Instagram/TikTok/etc.'s own webview instead of
 * Safari or Chrome.
 */
export function isInApp(ua: string | null): boolean {
  if (ua === null) {
    return false;
  }

  return IN_APP_MARKERS.some((marker) => ua.includes(marker));
}
