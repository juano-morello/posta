// Barrel for packages/core/src/enrichment — pure User-Agent parsing
// (T3.2.1's ua.ts), in-app browser detection plus source_platform
// resolution (T3.2.2 and T3.2.3's source-platform.ts), destination-host
// extraction (T3.2.4's dest-host.ts), and the composition of all of the
// above into one enrich() entry point (T3.2.5's enrich.ts). Consumers
// (apps/worker, later apps/api) import from '@posta/core' or this module,
// never reach past it into './ua', './source-platform', './dest-host', or
// './enrich' directly — same pattern as ../geoip/index.ts and
// ../redis/index.ts.
//
// Explicit named exports, not `export *` (matching geoip/index.ts's own
// switch — see that file's header for the fuller reasoning): keeps this
// barrel's surface an intentional list. Every export here is a FACT
// (parseUserAgent, ParsedUserAgent, UaDeviceType, IN_APP_MARKERS,
// isInApp, resolveSourcePlatform, SourcePlatformValue, destHost, enrich,
// EnrichmentInput, EnrichmentResult) — no bot/human verdict field exists to
// leak (invariant 4), but a future addition to any file in this directory
// should still have to be added here on purpose rather than widening
// @posta/core's public surface automatically.
//
// T3.2.5 note: apps/worker's real enrichment step (T3.3.2) and replay
// (T3.6.3) must both call enrich() — the composed entry point — rather
// than importing parseUserAgent/isInApp/resolveSourcePlatform/destHost
// individually and re-composing them. This barrel exporting both the parts
// AND the composed whole is intentional (callers with a narrower need,
// e.g. a debug tool that only wants device_type, still have the parts
// available), but a second composition of all four for a real event would
// defeat the "one entry point" point of T3.2.5 — don't add one.
export type { ParsedUserAgent, UaDeviceType } from './ua';
export { parseUserAgent } from './ua';
export type { SourcePlatformValue } from './source-platform';
export { IN_APP_MARKERS, isInApp, resolveSourcePlatform } from './source-platform';
export { destHost } from './dest-host';
export type { EnrichmentInput, EnrichmentResult } from './enrich';
export { enrich } from './enrich';
