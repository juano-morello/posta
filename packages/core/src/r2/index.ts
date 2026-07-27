// Barrel for packages/core/src/r2 — the R2/S3-compatible client seam
// (T3.4.1) and the NDJSON batch serializer (T3.4.2). Consumers (apps/api,
// apps/worker) import from '@posta/core' or this module, never reach past
// it into './client'/'./ndjson' directly — same pattern as
// ../redis/index.ts and ../geoip/index.ts.
export * from './client';
export * from './ndjson';
