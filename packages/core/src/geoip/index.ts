// Barrel for packages/core/src/geoip — GeoIP database loading (T2.3.4)
// and, landing separately, lookup (T2.3.5's lookup.ts). Consumers
// (apps/api) import from '@posta/core' or this module, never reach past
// it into './loader' directly — same pattern as ../redis/index.ts.
//
// Deliberately NAMED exports here, not `export * from './loader'` (T2.3.4
// review fixup): loader.ts also exports resetGeoDatabases, a TEST-ONLY
// memo-reset for loader.test.ts's own teardown — its docstring says so
// explicitly, and unlike closeRedis (../redis/client.ts, re-exported here
// via ../redis/index.ts's `export *` because T0.7.8's SIGTERM handler is a
// REAL production caller), nothing in production ever needs it. An
// `export *` would put it on `@posta/core`'s public surface, where a
// caller could clear the boot-time GeoIP memo mid-process and reopen the
// per-request file-I/O this loader exists to close (invariant 2).
// tests/conventions/no-geoip-reset-in-core-barrel.test.ts pins this against
// the built package entry point, so a future `export *` here (or a new
// loader.ts export nobody thought to exclude) fails loudly instead of
// silently widening this surface again. loader.test.ts itself imports
// resetGeoDatabases straight from './loader', bypassing this barrel
// entirely, so it is unaffected by what this file does or doesn't
// re-export.
export type { GeoDatabaseOptions, GeoDatabases } from './loader';
export { createGeoDatabases, openGeoDatabases } from './loader';
