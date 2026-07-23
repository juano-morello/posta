// Barrel for packages/core/src/db — the db seam (client, migrator, and
// later the tenant-scoped repository helper, T1.1.9). Consumers (apps/api,
// apps/worker) import from '@posta/core' or this module, never reach past
// it into './client' directly, so this file is the one place that has to
// change when the db seam grows.
export * from './client';
export * from './tenant';
export * from './sql-migrate';
export * from './partitions';
