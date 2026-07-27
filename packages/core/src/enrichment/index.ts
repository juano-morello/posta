// Barrel for packages/core/src/enrichment — pure User-Agent parsing
// (T3.2.1's ua.ts) and in-app browser detection (T3.2.2's
// source-platform.ts). Consumers (apps/worker, later apps/api) import
// from '@posta/core' or this module, never reach past it into './ua' or
// './source-platform' directly — same pattern as ../geoip/index.ts and
// ../redis/index.ts.
//
// Explicit named exports, not `export *` (matching geoip/index.ts's own
// switch — see that file's header for the fuller reasoning): keeps this
// barrel's surface an intentional list. Every export here is a FACT
// (parseUserAgent, ParsedUserAgent, UaDeviceType, IN_APP_MARKERS,
// isInApp) — no bot/human verdict field exists to leak (invariant 4),
// but a future addition to either file should still have to be added
// here on purpose rather than widening @posta/core's public surface
// automatically.
export type { ParsedUserAgent, UaDeviceType } from './ua';
export { parseUserAgent } from './ua';
export { IN_APP_MARKERS, isInApp } from './source-platform';
