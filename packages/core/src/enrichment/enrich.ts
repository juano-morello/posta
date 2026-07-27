import type { CaptureEvent } from '@posta/contracts';
import { destHost } from './dest-host';
import { isInApp, resolveSourcePlatform } from './source-platform';
import type { SourcePlatformValue } from './source-platform';
import { parseUserAgent } from './ua';
import type { UaDeviceType } from './ua';

// T3.2.5 (E3, S3.2) — enrich() is the ONE place T3.2.1-T3.2.4's four
// FACT-producing functions (parseUserAgent, isInApp, resolveSourcePlatform,
// destHost) get composed together for a real event. Both the worker's live
// flush path (T3.3.2, a later task) and replay (T3.6.3, a much later task)
// call this same function, so the two paths enrich identically by
// construction — there is deliberately no second composition of these four
// functions anywhere else in this codebase. If a future task needs to
// enrich an event, it calls THIS function; it does not re-wire
// parseUserAgent/isInApp/resolveSourcePlatform/destHost together a second
// time.
//
// --- Why EnrichmentInput is not CaptureEvent -------------------------------
//
// enrich()'s input is deliberately NOT CaptureEvent
// (packages/contracts/src/capture.ts) unmodified, even though "a capture
// payload" is the natural way to describe what gets enriched. CaptureEvent
// has no `destination` field — its own header comment explains why:
// capture (E2) doesn't know the enrichment columns, and dest_host needs the
// LINK's destination, which only the redirect hot path resolves (by
// looking up the link), not the capture event itself. But dest_host is one
// of the seven columns this function is required to return, so its input
// MUST carry a destination from somewhere.
//
// This file's own scope (packages/core/src/enrichment/ only — no DB, no
// cache, no link lookup) means enrich() cannot go fetch that destination
// itself; it has to stay pure and receive it from the caller. That caller
// is T3.3.2's flushBatch(events), which resolves each event's destination
// via a batched link lookup keyed by link_id before calling enrich() — an
// implementation decision T3.3.2 made to close a gap the plan text didn't
// specify. So the destination is available at the call site; it just
// doesn't live on CaptureEvent.
//
// EnrichmentInput is therefore Pick<CaptureEvent, 'user_agent' | 'referer'>
// plus a `destination` field, NOT the full CaptureEvent plus one. Picking
// only the two fields this function actually reads (rather than extending
// the whole 20-field CaptureEvent) does two things: it documents precisely
// what enrich() depends on — nothing about event_id, tenant_id, or any of
// the dozen prefetch/client-hint signals CaptureEvent also carries — and it
// keeps this function callable from contexts that never assembled a full
// CaptureEvent at all, e.g. a future admin/debug tool that just wants to
// preview enrichment for a hand-typed UA + referer + destination. If a
// caller already has a full CaptureEvent in hand (as flushBatch does), it
// is a one-line destructure to produce this shape; the type itself commits
// this function to nothing wider.
export type EnrichmentInput = Pick<CaptureEvent, 'user_agent' | 'referer'> & {
  /**
   * The redirect destination the caller already resolved (e.g. via a link
   * lookup keyed by link_id) — `null` when no destination is known. Not a
   * CaptureEvent field; see this file's header for why.
   */
  readonly destination: string | null;
};

/**
 * The seven enrichment columns from spec §8, and nothing else. A plain
 * object type (not `Record<string, unknown>`) so that a caller assigning an
 * object literal with an eighth field to this type gets a compile-time
 * excess-property error — the return type structurally cannot carry more
 * than these seven.
 */
export interface EnrichmentResult {
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  device_type: UaDeviceType;
  source_platform: SourcePlatformValue;
  is_in_app: boolean;
  dest_host: string | null;
}

/**
 * Composes parseUserAgent, isInApp, resolveSourcePlatform, and destHost
 * into the seven enrichment columns for one event. Pure and deterministic
 * — no I/O, no Date.now(), no network — matching every function it
 * composes. Never throws: every field of {@link EnrichmentInput} may be
 * `null`, and this function preserves the null-in/null-out (or
 * null-in/false-out for the boolean) discipline each of its four inputs
 * already guarantees, rather than introducing a new failure mode.
 *
 * `destination` is handled explicitly before reaching destHost(), which
 * takes a non-nullable `string` — a `null` or empty destination resolves
 * `dest_host` to `null` without ever calling destHost() on a non-string.
 *
 * Composes only FACTS (invariant 4 — "the worker enriches; it does not
 * judge"): no bot/human verdict is computed or added here. This is the ONE
 * entry point for this composition — the live flush path (T3.3.2) and
 * replay (T3.6.3) both call this function so they enrich identically.
 */
export function enrich(input: EnrichmentInput): EnrichmentResult {
  const { browser, browser_version, os, device_type } = parseUserAgent(input.user_agent);

  return {
    browser,
    browser_version,
    os,
    device_type,
    source_platform: resolveSourcePlatform(input.referer, input.user_agent),
    is_in_app: isInApp(input.user_agent),
    dest_host: input.destination === null || input.destination === '' ? null : destHost(input.destination),
  };
}
