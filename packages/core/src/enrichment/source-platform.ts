import { destHost } from './dest-host';

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
//
// --- T3.2.3 addition: resolveSourcePlatform() -----------------------------
//
// resolveSourcePlatform() names which known platform sent a captured
// click. Referer host is checked FIRST — it is the stronger signal (it
// survives UA spoofing, and it works for any browser, not just embedded
// webviews) — falling back to the same IN_APP_MARKERS/isInApp substrings
// above, then 'directo' if nothing matched.
//
// Referer parsing reuses dest-host.ts's destHost(): both functions do the
// exact same thing — parse a URL-shaped string with the WHATWG URL global
// and return a lowercased hostname, or null for anything that doesn't
// parse — so this imports destHost rather than re-implementing the same
// try/catch a second time in this file.
//
// Host matching is an EXACT match against a curated table below, not a
// suffix/endsWith check. A curated list is fully predictable and testable
// (no surprise matches on a lookalike host such as
// "evil.com/l.instagram.com"), and every host in the table is a real,
// documented domain one of these platforms actually uses for outbound
// link referrers or link-shim redirects.
//
// WhatsApp is referer-only: unlike Instagram/Facebook/TikTok/Line,
// WhatsApp does not brand its in-app browser with a UA marker (there is
// no 'WhatsApp' entry in IN_APP_MARKERS above), because tapping a link in
// WhatsApp typically hands off to the system browser or an unbranded
// Custom Tab rather than an embedded webview. Two real referer signals
// exist instead: `web.whatsapp.com` (a link opened from a browser tab on
// WhatsApp Web) and the Android Custom Tabs convention of setting
// `Intent.EXTRA_REFERRER` to `android-app://<package>` — WhatsApp's
// package is `com.whatsapp`, which `URL#hostname` reports as
// `com.whatsapp` for an `android-app://com.whatsapp` referrer. Most
// individual WhatsApp taps that open the plain system browser (not a
// Custom Tab) send NO referer at all — this is the well-known "dark
// social" gap in web analytics — so those clicks correctly fall through
// (no referer match, no UA match) to 'directo'. That is expected
// under-detection here, not a bug to engineer around.
//
// IN_APP_MARKERS has six entries but the return union below has only five
// non-'directo' platforms: BytedanceWebview and Line have no principled
// mapping and are deliberately excluded from UA_MARKER_PLATFORMS below.
// BytedanceWebview marks *some* ByteDance-family app's webview, not
// specifically TikTok — ByteDance ships other apps too — so mapping it to
// 'tiktok' would present a guess as a fact. Line has no corresponding
// platform in this union at all. Both fall through to 'directo'.

/**
 * The platforms {@link resolveSourcePlatform} can name. This is a
 * descriptive fact about where a hit's signals point (invariant 4) — never
 * a bot/human verdict. 'directo' is both a real value (no referer at all)
 * and the fallback for anything unrecognized; there is no separate
 * "unknown" member.
 */
export type SourcePlatformValue = 'instagram' | 'whatsapp' | 'tiktok' | 'facebook' | 'x' | 'directo';

/**
 * Referer hosts (exact match, lowercased) mapped to the platform they
 * belong to. See the file header above for why each entry is here,
 * particularly WhatsApp's two referer-only signals.
 */
const REFERER_HOST_PLATFORMS: Readonly<Record<string, Exclude<SourcePlatformValue, 'directo'>>> = {
  'instagram.com': 'instagram',
  'www.instagram.com': 'instagram',
  'l.instagram.com': 'instagram',
  'facebook.com': 'facebook',
  'www.facebook.com': 'facebook',
  'm.facebook.com': 'facebook',
  'l.facebook.com': 'facebook',
  'lm.facebook.com': 'facebook',
  'twitter.com': 'x',
  'www.twitter.com': 'x',
  'x.com': 'x',
  'www.x.com': 'x',
  't.co': 'x',
  'tiktok.com': 'tiktok',
  'www.tiktok.com': 'tiktok',
  'vm.tiktok.com': 'tiktok',
  'wa.me': 'whatsapp',
  'web.whatsapp.com': 'whatsapp',
  'com.whatsapp': 'whatsapp',
};

interface UaMarkerPlatform {
  readonly marker: string;
  readonly platform: Exclude<SourcePlatformValue, 'directo'>;
}

/**
 * The subset of {@link IN_APP_MARKERS} that maps to a specific
 * {@link SourcePlatformValue}, checked in this order when the referer
 * doesn't resolve to a known host. BytedanceWebview and Line are
 * deliberately absent — see the file header.
 */
const UA_MARKER_PLATFORMS: readonly UaMarkerPlatform[] = [
  { marker: 'Instagram', platform: 'instagram' },
  { marker: 'FBAN', platform: 'facebook' },
  { marker: 'FBAV', platform: 'facebook' },
  { marker: 'TikTok', platform: 'tiktok' },
];

/**
 * Names which known platform a captured hit's signals point to — referer
 * host first, then the in-app UA markers above, then 'directo'. Never
 * throws: an unparseable or unrecognized referer/UA simply falls through
 * to the next signal rather than raising.
 *
 * This is a descriptive fact (invariant 4), not a bot/human verdict: a
 * 'directo' result means no known platform signal was found, not that the
 * hit was inhuman, and an in-app 'instagram' result is still a real
 * person tapping a real link — just from inside Instagram's own webview.
 */
export function resolveSourcePlatform(referer: string | null, ua: string | null): SourcePlatformValue {
  const refererHost = referer === null ? null : destHost(referer);

  if (refererHost !== null) {
    const platformFromReferer = REFERER_HOST_PLATFORMS[refererHost];
    if (platformFromReferer !== undefined) {
      return platformFromReferer;
    }
  }

  if (ua !== null) {
    const platformFromUa = UA_MARKER_PLATFORMS.find(({ marker }) => ua.includes(marker));
    if (platformFromUa !== undefined) {
      return platformFromUa.platform;
    }
  }

  return 'directo';
}

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
