import { UAParser } from 'ua-parser-js';

// T3.2.1 (E3, S3.2) — a null-safe wrapper around ua-parser-js, the seam the
// worker's enrichment step (a later E3 task) calls with the raw
// User-Agent header off every captured event. This module hands back
// FACTS only — browser name/version, OS name, and a normalised
// device_type — and never a bot/human verdict. Invariant 4 ("the worker
// enriches; it does not judge") is enforced right here: this file only
// ever imports ua-parser-js's plain root entry point (the `UAParser`
// class/function), never its './bot-detection' or './browser-detection'
// extension modules — that is where that package's own crawler/bot
// classification lives. Don't add that import "for convenience" later; it
// would hand this module a verdict to leak, which is exactly what a later
// worker-enrichment task is written to catch if it ever reaches the
// worker.
//
// Pure and deterministic: no I/O, no Date.now(), no network — same input,
// same output, forever. That is what lets it run from the worker's real
// enrichment path AND any future admin/debug tool without dragging in a DB
// or network dependency.
//
// The try/catch below is deliberate, not defensive theater: ua-parser-js@2
// already guards its own regex matching against pathological input (any UA
// over 500 chars is trimmed before matching — see its docs) and did not
// throw on a 4 KB block of random bytes in manual testing done for this
// task. But that is this specific version's behavior, not a contract this
// file can assume holds across a future ua-parser-js bump. A malformed
// header must never crash a redirect's enrichment step, so the catch stays
// regardless of what today's version does — and it stays silent on
// purpose: the caller (an event on the hot path) has no logger to hand
// this pure function, and "malformed UA" is an expected, high-volume shape
// of real bot traffic, not an operational failure worth logging on every
// occurrence.

/**
 * Device categories this module ever reports — deliberately narrower than
 * ua-parser-js's own `DeviceType` enum, which also includes `console`,
 * `smarttv`, `wearable`, `xr`, and `embedded`. Anything outside
 * mobile/tablet/desktop collapses to `null` rather than inventing a fourth
 * bucket.
 */
export type UaDeviceType = 'mobile' | 'tablet' | 'desktop' | null;

/**
 * Enrichment facts extracted from a User-Agent header. Every field is a
 * plain fact ua-parser-js reported (or `null` if it reported nothing) —
 * never a computed bot/human verdict (invariant 4).
 */
export interface ParsedUserAgent {
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  device_type: UaDeviceType;
}

function allNullResult(): ParsedUserAgent {
  return { browser: null, browser_version: null, os: null, device_type: null };
}

/**
 * Normalises ua-parser-js's `device.type` into this module's 3-way bucket.
 *
 * ua-parser-js only ever sets `device.type` for devices it can positively
 * identify as non-desktop (mobile, tablet, smarttv, console, wearable, xr,
 * embedded) — see https://docs.uaparser.dev/info/device/type. A plain
 * desktop browser (confirmed against a real Chrome-on-Windows UA while
 * building this) leaves `device.type` `undefined`. That is exactly why
 * `undefined` alone can't mean "desktop": the SAME `undefined` shows up for
 * strings ua-parser-js couldn't parse at all (facebookexternalhit, empty,
 * garbage — also confirmed by hand). `browserName` disambiguates the two:
 * an `undefined` device type only becomes `'desktop'` when ua-parser-js
 * also recognised an actual browser; otherwise nothing was identified, so
 * this returns `null` rather than guessing.
 */
function normaliseDeviceType(deviceType: string | undefined, browserName: string | undefined): UaDeviceType {
  if (deviceType === 'mobile' || deviceType === 'tablet') {
    return deviceType;
  }

  if (deviceType === undefined && browserName !== undefined) {
    return 'desktop';
  }

  return null;
}

/**
 * Parses a User-Agent header into browser/OS/device facts. Never throws —
 * `null`, the empty string, and unparseable garbage all resolve to a
 * {@link ParsedUserAgent} with every field `null` rather than propagating
 * an error, so a malformed header from the wild never crashes a caller on
 * the redirect hot path or in the worker's enrichment step.
 */
export function parseUserAgent(ua: string | null): ParsedUserAgent {
  if (ua === null || ua === '') {
    return allNullResult();
  }

  try {
    const { browser, os, device } = new UAParser(ua).getResult();

    return {
      browser: browser.name ?? null,
      browser_version: browser.version ?? null,
      os: os.name ?? null,
      device_type: normaliseDeviceType(device.type, browser.name),
    };
  } catch {
    return allNullResult();
  }
}
