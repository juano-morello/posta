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
export * from './ulid';
