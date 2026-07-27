// packages/core only ever runs server-side: it holds the Drizzle schema,
// database clients, and R2 credentials, and must never reach a browser
// bundle. The boundary is enforced by the no-illegal-core-import
// dependency-cruiser rule (.dependency-cruiser.js), which catches both
// static and dynamic imports at build time.
//
// The package barrel: apps/api and apps/worker import from '@posta/core'
// (this file), never reaching past it into individual submodules — so
// this is the one place that has to change as E1 adds the db seam, the
// schema, and the tenant-scoped repository helper.
export * from './db';
// T3.2.1 — pure User-Agent parsing (enrichment/ua.ts), same barrel pattern
// as db/geoip/redis below/above.
export * from './enrichment';
// T2.3.4 — the GeoIP loader seam (geoip/loader.ts), same barrel pattern
// as db/redis above.
export * from './geoip';
// T3.1.1 — the shared BullMQ queue contract (queue/events-queue.ts), same
// barrel pattern as db/geoip/redis above.
export * from './queue';
export * from './redis';
export * from './ulid';
// T1.5.5 — the first consumer that needs schema TABLE OBJECTS through
// the barrel, not just the db seam: packages/core/scripts/seed.ts runs
// under Node directly (never through this package's own tsc build,
// which only covers src/ — see packages/core/scripts/tsconfig.json's own
// comment), so it consumes @posta/core the same way apps/api/apps/worker
// do, through this compiled entry point, rather than reaching into
// ../src/schema/*.ts sibling files whose ESM import/export syntax only
// resolves correctly once tsc has compiled them to this package's
// declared "commonjs" module system. schema/events.ts stays out
// deliberately (see this file's own history / events.ts's docstring):
// it is a read-only typing mirror of hand-written SQL, not a table
// anything inserts through Drizzle.
export * from './schema/auth';
export * from './schema/bio';
export * from './schema/links';
