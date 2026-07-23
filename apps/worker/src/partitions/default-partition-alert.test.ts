import path from 'node:path';
import { runSqlMigrations } from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import { Gauge, Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { processPartitionMaintenanceJob } from './partition-maintenance.job';

// T1.3.5 — the DEFAULT partition (T1.3.2) is a safety net, not a
// legitimate destination: without this alert, it's a silent leak — data
// lands somewhere unqueried and nobody finds out until a dashboard number
// is wrong. Rows there always mean the maintenance job (T1.3.4) failed.
// countDefaultPartitionRows() (packages/core/src/db/partitions.ts) feeds
// both a posta_events_default_rows gauge and an error-level log line
// naming events_default whenever the count is greater than zero.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

interface LoggedError {
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

describe('alert on non-empty events_default (T1.3.5)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, 120_000);

  afterAll(async () => {
    await handle.stop();
  }, 120_000);

  it('a far-future row sets the gauge to 1 and logs one error naming events_default', async () => {
    await handle.pool.query(`
      INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug)
      VALUES ('01T135EVENT00000000000000', '2035-01-01T00:00:00Z', 'tenant-x', 'link-x', 'slug-x')
    `);

    const registry = new Registry();
    const gauge = new Gauge({
      name: 'posta_events_default_rows',
      help: 'test-only gauge, registered on a private Registry',
      registers: [registry],
    });
    const errorCalls: LoggedError[] = [];
    const logger = {
      error(message: string, meta?: Record<string, unknown>): void {
        errorCalls.push({ message, meta });
      },
    };

    await processPartitionMaintenanceJob(handle.pool, gauge, logger);

    const metric = await gauge.get();
    expect(metric.values[0]?.value).toBe(1);

    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.message).toContain('events_default');
    expect(errorCalls[0]?.meta).toMatchObject({ table: 'events_default', rowCount: 1 });
  });
});
