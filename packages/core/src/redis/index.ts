// Barrel for packages/core/src/redis — the Redis seam (client + key
// builders, T2.1.3). Consumers (apps/api, apps/worker) import from
// '@posta/core' or this module, never reach past it into './client' or
// './keys' directly, so this file is the one place that has to change as
// E2 grows this seam (T2.2.x's slug cache, T2.3.6's salt manager, T2.4.2's
// BullMQ producer) — same pattern as ../db/index.ts.
export * from './client';
export * from './keys';
