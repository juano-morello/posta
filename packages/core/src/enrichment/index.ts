// Barrel for packages/core/src/enrichment — pure User-Agent parsing
// (T3.2.1's ua.ts). Consumers (apps/worker, later apps/api) import from
// '@posta/core' or this module, never reach past it into './ua' directly
// — same pattern as ../geoip/index.ts and ../redis/index.ts.
//
// Explicit named exports, not `export *` (matching geoip/index.ts's own
// switch — see that file's header for the fuller reasoning): keeps this
// barrel's surface an intentional list. ua.ts exports FACTS only
// (parseUserAgent, ParsedUserAgent, UaDeviceType) — no bot/human verdict
// field exists to leak (invariant 4), but a future addition to ua.ts
// should still have to be added here on purpose rather than widening
// @posta/core's public surface automatically.
export type { ParsedUserAgent, UaDeviceType } from './ua';
export { parseUserAgent } from './ua';
