// Barrel for packages/core/src/enrichment — pure User-Agent parsing
// (T3.2.1's ua.ts), in-app browser detection plus source_platform
// resolution (T3.2.2 and T3.2.3's source-platform.ts), and destination-host
// extraction (T3.2.4's dest-host.ts). Consumers (apps/worker, later
// apps/api) import from '@posta/core' or this module, never reach past it
// into './ua', './source-platform', or './dest-host' directly — same
// pattern as ../geoip/index.ts and ../redis/index.ts.
//
// Explicit named exports, not `export *` (matching geoip/index.ts's own
// switch — see that file's header for the fuller reasoning): keeps this
// barrel's surface an intentional list. Every export here is a FACT
// (parseUserAgent, ParsedUserAgent, UaDeviceType, IN_APP_MARKERS,
// isInApp, resolveSourcePlatform, SourcePlatformValue, destHost) — no
// bot/human verdict field exists to leak (invariant 4), but a future
// addition to any file in this directory should still have to be added
// here on purpose rather than widening @posta/core's public surface
// automatically.
export type { ParsedUserAgent, UaDeviceType } from './ua';
export { parseUserAgent } from './ua';
export type { SourcePlatformValue } from './source-platform';
export { IN_APP_MARKERS, isInApp, resolveSourcePlatform } from './source-platform';
export { destHost } from './dest-host';
