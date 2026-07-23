import { ensurePartitionsAhead } from '@posta/core';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Pool } from 'pg';

// T1.3.4 — a daily BullMQ repeatable job calling ensurePartitionsAhead(3).
// Lives in the worker because that is the only process with a scheduler;
// it issues DDL only and never touches event rows, so [INV-4] is
// untouched — the worker still does not judge anything.

export const PARTITION_MAINTENANCE_QUEUE_NAME = 'partition-maintenance';
export const PARTITION_MAINTENANCE_JOB_NAME = 'ensure-partitions-ahead';
const SCHEDULER_ID = 'partition-maintenance-daily';
// Midnight UTC, daily — a standard 5-field cron pattern, BullMQ's Job
// Scheduler `pattern` option.
const DAILY_CRON_PATTERN = '0 0 * * *';
// Matches 005_bootstrap_partitions.sql's own "current + 3" policy
// (packages/core/src/db/partitions.ts's DEFAULT_MONTHS_AHEAD) — this is
// the one place that number is spent on the recurring side of the same
// rule the bootstrap migration spends once.
const MONTHS_AHEAD = 3;

/**
 * The job's actual work, extracted so it is directly testable without
 * going through BullMQ/Redis at all. Issues DDL only (creates partitions
 * ahead of need) — never touches event rows, never computes a
 * human/bot verdict [INV-4].
 */
export async function processPartitionMaintenanceJob(pool: Pool): Promise<void> {
  await ensurePartitionsAhead(pool, MONTHS_AHEAD);
}

export interface PartitionMaintenanceJobHandle {
  readonly queue: Queue;
  readonly worker: Worker;
  close(): Promise<void>;
}

/**
 * Registers the daily repeatable schedule (BullMQ's Job Scheduler,
 * `upsertJobScheduler` — idempotent: calling this again with the same
 * scheduler id updates the existing schedule rather than duplicating
 * it) and starts a worker that processes it by calling
 * processPartitionMaintenanceJob(pool).
 */
export async function startPartitionMaintenanceJob(
  connection: ConnectionOptions,
  pool: Pool,
  queueName: string = PARTITION_MAINTENANCE_QUEUE_NAME,
): Promise<PartitionMaintenanceJobHandle> {
  const queue = new Queue(queueName, { connection });

  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: DAILY_CRON_PATTERN },
    { name: PARTITION_MAINTENANCE_JOB_NAME },
  );

  const worker = new Worker(
    queueName,
    async () => {
      await processPartitionMaintenanceJob(pool);
    },
    { connection },
  );

  return {
    queue,
    worker,
    async close(): Promise<void> {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    },
  };
}
