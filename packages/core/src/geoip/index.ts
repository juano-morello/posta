// Barrel for packages/core/src/geoip — GeoIP database loading (T2.3.4)
// and, landing separately, lookup (T2.3.5's lookup.ts). Consumers
// (apps/api) import from '@posta/core' or this module, never reach past
// it into './loader' directly — same pattern as ../redis/index.ts.
export * from './loader';
