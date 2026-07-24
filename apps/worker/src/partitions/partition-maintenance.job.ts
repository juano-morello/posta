import { countDefaultPartitionRows, ensurePartitionsAhead } from '@posta/core';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Pool } from 'pg';
import { Gauge, type Registry } from 'prom-client';

// T1.3.4 — a daily BullMQ repeatable job calling ensurePartitionsAhead(3).
// Lives in the worker because that is the only process with a scheduler;
// it issues DDL only and never touches event rows, so [INV-4] is
// untouched — the worker still does not judge anything.
//
// T1.3.5 — the same job also checks events_default (T1.3.2): a non-zero
// row count there always means THIS job failed to create a partition
// ahead of need, and a row landed somewhere unqueried instead. Without
// this check the DEFAULT partition is a silent leak — nobody finds out
// until a dashboard number is wrong.

export const PARTITION_MAINTENANCE_QUEUE_NAME = 'partition-maintenance';
export const PARTITION_MAINTENANCE_JOB_NAME = 'ensure-partitions-ahead';
export const DEFAULT_PARTITION_ROWS_GAUGE_NAME = 'posta_events_default_rows';
const SCHEDULER_ID = 'partition-maintenance-daily';
// Midnight UTC, daily — a standard 5-field cron pattern, BullMQ's Job
// Scheduler `pattern` option.
const DAILY_CRON_PATTERN = '0 0 * * *';
// Matches 005_bootstrap_partitions.sql's own "current + 3" policy
// (packages/core/src/db/partitions.ts's DEFAULT_MONTHS_AHEAD) — this is
// the one place that number is spent on the recurring side of the same
// rule the bootstrap migration spends once.
const MONTHS_AHEAD = 3;

/** Minimal logger shape the job needs — just enough to log one error
 * line, so tests can pass a plain spy object instead of a real pino
 * instance (which isn't wired up anywhere in this codebase yet). */
export interface PartitionMaintenanceLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export const consoleErrorLogger: PartitionMaintenanceLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** Builds the posta_events_default_rows gauge. Pass a dedicated
 * `registry` in tests to avoid colliding with prom-client's shared
 * global default registry (creating two Gauges with the same name
 * against the same registry throws). */
export function createDefaultPartitionRowsGauge(registry?: Registry): Gauge<string> {
  // `exactOptionalPropertyTypes` forbids passing `registers: undefined`
  // explicitly — the key must be OMITTED entirely (not present-but-
  // undefined) when no registry override is given, so prom-client falls
  // back to its own default registry.
  return new Gauge({
    name: DEFAULT_PARTITION_ROWS_GAUGE_NAME,
    help:
      'Row count in the events_default partition. Always zero when partition ' +
      'maintenance succeeds; any non-zero value means the maintenance job failed ' +
      'to create a partition ahead of need.',
    ...(registry ? { registers: [registry] } : {}),
  });
}

/**
 * The job's actual work, extracted so it is directly testable without
 * going through BullMQ/Redis at all. Issues DDL only (creates partitions
 * ahead of need) — never touches event rows, never computes a
 * human/bot verdict [INV-4].
 *
 * Also checks events_default (T1.3.5): sets `gauge` to the current row
 * count every run, and logs at error level — naming the table and the
 * row count — whenever that count is greater than zero. Rows there
 * always mean this job failed to create a partition ahead of need.
 */
export async function processPartitionMaintenanceJob(
  pool: Pool,
  gauge: Gauge<string>,
  logger: PartitionMaintenanceLogger,
): Promise<void> {
  await ensurePartitionsAhead(pool, MONTHS_AHEAD);

  const defaultPartitionRows = await countDefaultPartitionRows(pool);
  gauge.set(defaultPartitionRows);

  if (defaultPartitionRows > 0) {
    logger.error(
      `events_default has ${defaultPartitionRows} row(s) — the partition maintenance job ` +
        `failed to create a partition ahead of need. Rows in events_default always mean the ` +
        `maintenance job failed.`,
      { table: 'events_default', rowCount: defaultPartitionRows },
    );
  }
}

export interface PartitionMaintenanceJobHandle {
  readonly queue: Queue;
  readonly worker: Worker;
  close(): Promise<void>;
}

export interface StartPartitionMaintenanceJobOptions {
  readonly queueName?: string;
  readonly gauge?: Gauge<string>;
  readonly logger?: PartitionMaintenanceLogger;
}

/**
 * Registers the daily repeatable schedule (BullMQ's Job Scheduler,
 * `upsertJobScheduler` — idempotent: calling this again with the same
 * scheduler id updates the existing schedule rather than duplicating
 * it) and starts a worker that processes it by calling
 * processPartitionMaintenanceJob(pool, gauge, logger).
 */
export async function startPartitionMaintenanceJob(
  connection: ConnectionOptions,
  pool: Pool,
  options: StartPartitionMaintenanceJobOptions = {},
): Promise<PartitionMaintenanceJobHandle> {
  const queueName = options.queueName ?? PARTITION_MAINTENANCE_QUEUE_NAME;
  const gauge = options.gauge ?? createDefaultPartitionRowsGauge();
  const logger = options.logger ?? consoleErrorLogger;

  const queue = new Queue(queueName, { connection });

  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: DAILY_CRON_PATTERN },
    { name: PARTITION_MAINTENANCE_JOB_NAME },
  );

  const worker = new Worker(
    queueName,
    async () => {
      await processPartitionMaintenanceJob(pool, gauge, logger);
    },
    { connection },
  );

  // [silent-failure review, batch 1] BullMQ's own bookkeeping always
  // marks a thrown-processor job as failed regardless of listeners — but
  // nothing in THIS process previously surfaced that anywhere else (no
  // log, no metric), so a real partition-creation failure would sit
  // silently in Redis until someone thought to query job state by hand.
  // This is exactly the same class of gap T1.3.5 closed for
  // events_default: a failure with no visible signal.
  worker.on('failed', (job, error) => {
    logger.error(
      `Partition maintenance job ${job?.id ?? '(unknown)'} failed: ${error.message}`,
      { jobId: job?.id, error: error.message },
    );
  });

  return {
    queue,
    worker,
    async close(): Promise<void> {
      // [silent-failure review, batch 1] Mirrors pg-container.ts's
      // closeClientAndContainer(): attempt every cleanup step regardless
      // of an earlier one failing, and report every failure together —
      // a plain `.catch(() => undefined)` on obliterate() would silently
      // drop a real cleanup failure (Redis unavailable, permissions)
      // with no way to ever notice it happened.
      await worker.close();

      let obliterateError: unknown;
      try {
        await queue.obliterate({ force: true });
      } catch (error) {
        obliterateError = error;
      }

      let closeError: unknown;
      try {
        await queue.close();
      } catch (error) {
        closeError = error;
      }

      if (obliterateError && closeError) {
        throw new Error(
          `Failed to clean up the partition maintenance queue: obliterate() failed with ` +
            `"${describeCleanupError(obliterateError)}", then close() failed with ` +
            `"${describeCleanupError(closeError)}".`,
        );
      }
      if (obliterateError) throw obliterateError;
      if (closeError) throw closeError;
    },
  };
}

function describeCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
