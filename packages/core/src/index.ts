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
// T3.4.1 — the R2/S3-compatible client seam (r2/client.ts), same barrel
// pattern as db/geoip/redis above.
export * from './r2';
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
// declared "commonjs" module system.
export * from './schema/auth';
export * from './schema/bio';
export * from './schema/links';
// T3.3.2 — schema/events.ts stayed OUT of this barrel until now: earlier
// revisions of this comment said it never would ("not a table anything
// inserts through Drizzle"), because until this task nothing did.
// apps/worker/src/batch/flush.ts (T3.3.2) is the first real INSERT
// through this table (via packages/core/src/db/events.ts's
// insertEventsBatch, which needs the `events` table object and
// events.ts's own header names `.onConflictDoNothing({ target:
// [events.eventId, events.occurredAt] })` as the exact call this task
// makes), and apps/worker never reaches past this barrel into
// ../schema/events.ts directly (same "import from '@posta/core', never a
// submodule" discipline every other consumer in this file follows) — so
// EventRow/NewEvent and the `events` table object itself have to be
// reachable from here now. events.ts remains excluded from
// drizzle.config.ts's schema glob (drizzle-kit still can't emit
// `PARTITION BY`) — only ITS OWN barrel-visibility changes, not its
// DDL-ownership status.
export * from './schema/events';
