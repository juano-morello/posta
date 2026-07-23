import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runSqlMigrations } from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import { QueueEvents } from 'bullmq';
import { Gauge, Registry } from 'prom-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  consoleErrorLogger,
  DEFAULT_PARTITION_ROWS_GAUGE_NAME,
  PARTITION_MAINTENANCE_JOB_NAME,
  processPartitionMaintenanceJob,
  startPartitionMaintenanceJob,
  type PartitionMaintenanceJobHandle,
} from './partition-maintenance.job';

// T1.3.4 — a daily BullMQ repeatable job calling ensurePartitionsAhead(3).
// Lives in the worker because that is the only process with a scheduler;
// it issues DDL only and never touches event rows, so [INV-4] stays
// untouched — the worker still does not judge anything.
//
// Two layers tested separately, deliberately:
//   1. processPartitionMaintenanceJob() directly, with the clock advanced
//      via vi.useFakeTimers() — this is the exact scenario the task asks
//      for ("clock advanced two months"), and faking only around this
//      call (never wrapping the real BullMQ round-trip below, which
//      needs genuine timers for its own retries/backoffs against real
//      Redis) keeps it deterministic without risking BullMQ's internal
//      time-dependent machinery.
//   2. startPartitionMaintenanceJob() end-to-end against real Redis
//      (REDIS_URL, same convention as tests/infra/redis-policy.test.ts)
//      and a real BullMQ Queue/Worker, proving the actual scheduling
//      wiring works, not just the underlying logic.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const REDIS_URL = process.env.REDIS_URL;
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);
const MONTHLY_PARTITION_PATTERN = /^events_\d{4}_\d{2}$/;

async function listEventsPartitions(handle: PgContainerHandle): Promise<string[]> {
  const result = await handle.pool.query<{ relname: string }>(`
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'events'
  `);
  return result.rows.map((row) => row.relname);
}

describe('processPartitionMaintenanceJob (T1.3.4)', () => {
  let handle: PgContainerHandle;
  // A dedicated Registry, not prom-client's shared global default one —
  // this test only cares about the job's own behavior, not about a
  // metric's registered value, so a private registry avoids any risk of
  // colliding with another test file's own Gauge of the same name.
  const gauge = new Gauge({
    name: DEFAULT_PARTITION_ROWS_GAUGE_NAME,
    help: 'test-only gauge, registered on a private Registry',
    registers: [new Registry()],
  });

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, 120_000);

  afterAll(async () => {
    await handle.stop();
  }, 120_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('with the clock advanced two months, creates exactly the two missing months', async () => {
    const before = (await listEventsPartitions(handle)).filter((name) =>
      MONTHLY_PARTITION_PATTERN.test(name),
    );
    expect(before).toHaveLength(4); // bootstrap: current + 3 (T1.3.3)

    const twoMonthsFromNow = new Date();
    twoMonthsFromNow.setUTCMonth(twoMonthsFromNow.getUTCMonth() + 2);
    vi.useFakeTimers();
    vi.setSystemTime(twoMonthsFromNow);

    await processPartitionMaintenanceJob(handle.pool, gauge, consoleErrorLogger);

    vi.useRealTimers();

    const after = (await listEventsPartitions(handle)).filter((name) =>
      MONTHLY_PARTITION_PATTERN.test(name),
    );
    // Bootstrap already covered "now" through "+3"; the job, believing
    // it's 2 months later, wants "+2" through "+5" — only "+4" and "+5"
    // are genuinely new.
    expect(after.length).toBe(before.length + 2);
  });

  it('a second immediate run (same faked time) creates nothing new', async () => {
    const twoMonthsFromNow = new Date();
    twoMonthsFromNow.setUTCMonth(twoMonthsFromNow.getUTCMonth() + 2);
    vi.useFakeTimers();
    vi.setSystemTime(twoMonthsFromNow);

    const before = (await listEventsPartitions(handle)).sort();
    await processPartitionMaintenanceJob(handle.pool, gauge, consoleErrorLogger);
    const after = (await listEventsPartitions(handle)).sort();

    expect(after).toEqual(before);
  });
});

describe('startPartitionMaintenanceJob (T1.3.4) — real BullMQ wiring', () => {
  if (!REDIS_URL) {
    it('fails loudly: REDIS_URL is not set, so the BullMQ wiring cannot be verified', () => {
      throw new Error(
        'REDIS_URL is not set. Start the local stack (`docker compose up -d --wait redis`) ' +
          'and export REDIS_URL (see .env.example) before running this test.',
      );
    });
  } else {
    describe('when REDIS_URL is configured', () => {
      let handle: PgContainerHandle;
      let jobHandle: PartitionMaintenanceJobHandle;
      let queueEvents: QueueEvents;
      const queueName = `partition-maintenance-test-${randomUUID()}`;

      beforeAll(async () => {
        handle = await startPgContainer();
        await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

        jobHandle = await startPartitionMaintenanceJob(
          { url: REDIS_URL },
          handle.pool,
          { queueName },
        );
        queueEvents = new QueueEvents(queueName, { connection: { url: REDIS_URL } });
        await queueEvents.waitUntilReady();
      }, 120_000);

      afterAll(async () => {
        await queueEvents.close();
        await jobHandle.close();
        await handle.stop();
      }, 120_000);

      it('registers a daily repeatable job scheduler', async () => {
        const schedulers = await jobHandle.queue.getJobSchedulers();
        expect(schedulers.some((scheduler) => scheduler.pattern === '0 0 * * *')).toBe(true);
      });

      it('processes a manually-triggered run through the real Queue/Worker', async () => {
        const job = await jobHandle.queue.add(PARTITION_MAINTENANCE_JOB_NAME, {});
        await job.waitUntilFinished(queueEvents, 60_000);

        const partitions = await listEventsPartitions(handle);
        const monthlyPartitions = partitions.filter((name) => MONTHLY_PARTITION_PATTERN.test(name));
        expect(monthlyPartitions.length).toBeGreaterThanOrEqual(4);
      });
    });
  }
});
