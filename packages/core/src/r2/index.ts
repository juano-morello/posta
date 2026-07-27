// Barrel for packages/core/src/r2 — the R2/S3-compatible client seam
// (T3.4.1), the NDJSON batch serializer (T3.4.2), and the partitioned key
// scheme (T3.4.3). Consumers (apps/api, apps/worker) import from
// '@posta/core' or this module, never reach past it into
// './client'/'./ndjson'/'./keys' directly — same pattern as
// ../redis/index.ts and ../geoip/index.ts.
export * from './client';
export * from './ndjson';
export * from './keys';
