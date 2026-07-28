import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Queue } from 'bullmq';
import { EVENTS_QUEUE, runSqlMigrations } from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
  type RedisContainerHandle,
} from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkerHealthStatus } from '../health.controller';
import { buildCaptureEventFromCorpus, HARNESS_DESTINATION, HARNESS_SLUG, loadCorpus, seedLink, seedTenant } from './pipeline-harness-fixtures';
import { getFreePort, sleep } from './pipeline-harness-cleanup';
import { buildWorkerExclusively, fetchHealth, spawnWorkerExclusively, stopWorkerProcess, waitForHealth } from './pipeline-harness-process';

// T3.5.4 [E3, S3.5] — the plan's own literal scenario: SIGKILL — not
// SIGTERM (sigterm-flush.test.ts/T3.1.8 already covers graceful) — while a
// partial batch is buffered, then restart and drain. Asserts BullMQ
// redelivers the un-acked jobs and the final row count equals the distinct
// event_id count, at THREE different points in the batch window.
//
// --- WHY THIS TASK EXISTED AS A GAP, NOT JUST A MISSING TEST -----------
//
// A prior session (docs/plan/IMPLEMENTATION-NOTES.md's own T3.5.4 entry)
// found and empirically proved, via an ad hoc uncommitted spike, that this
// property was FALSE against the code as it stood: `AccumulatingEventSink
// .handle()` (events.consumer.ts) forwarded straight to
// `BatchAccumulator.add()` (accumulator.ts), which was `void`-returning
// and fire-and-forget — so `EventsConsumer.process()`'s `await this.sink
// .handle(event)` resolved, and BullMQ marked the job `'completed'`, the
// INSTANT an event was handed to the accumulator, long before its batch
// ever reached Postgres. A job already `'completed'` has no lock left for
// BullMQ's own stalled-job mechanism to notice was never renewed — nothing
// is left to redeliver. The prior session's own spike: 30 events pushed
// with both batch triggers parked, confirmed all 30 reached `'completed'`
// while `count(*) FROM events` was still 0, sent a real SIGKILL, booted a
// second worker against the same Redis/Postgres, waited 70s (past BullMQ's
// 30000ms default `lockDuration`/`stalledInterval`), result: `count(*)`
// still 0, `completed: 30, active: 0` — all 30 events permanently, silently
// lost. This is a DOCUMENTED, PRE-AUTHORIZED scope expansion beyond this
// file alone: `BatchAccumulator.add()` now returns a `Promise<void>` that
// settles only once its batch actually flushes, and
// `AccumulatingEventSink.handle()` awaits it — see accumulator.ts's and
// events.consumer.ts's own T3.5.4 headers for the full redesign, and
// shutdown.ts's own header for why `ShutdownService.drain()` needed a
// parallel redesign to avoid deadlocking under the new contract. This file
// is the test that was always meant to prove the property whose absence
// justified all three.
//
// --- THREE KILL POINTS, ONE SHARED RECOVERY PASS ------------------------
//
// Each kill point runs its OWN worker child process, with a REAL (not
// parked) `EVENT_BATCH_INTERVAL_MS` — the kill happens at 10%/50%/90% of
// that interval, all comfortably before it would fire on its own (verified
// per-point: Postgres holds zero rows for that point's own tenant
// immediately before the kill). This is a genuine variation in HOW LONG the
// batch had been open when it died, not a cosmetic one. What's deliberately
// NOT repeated three times is the expensive part: waiting for BullMQ's own
// stalled-job detection (`lockDuration`/`stalledInterval`, both 30000ms by
// default, neither configured by this codebase — verified against the
// installed bullmq@5.80.10 source, `Worker`'s own constructor defaults) to
// notice a dead worker's un-renewed lock. All three kills happen first
// (each against its own tenant, so nothing about them interferes with the
// others), and exactly ONE recovery worker boots afterward, whose own
// single stalled-check cycle picks up all three dead batches together —
// proving the SAME property at three genuinely different points without
// paying the ~70s stall-detection latency three separate times.
//
// --- WHAT PROVES THE MECHANISM, NOT JUST THE END STATE ------------------
//
// Two assertions, not one: (1) immediately after all three kills, BEFORE
// the recovery worker ever boots, `EVENTS_QUEUE`'s own job counts must show
// every pushed job still `active` and NONE `completed` — this is the exact
// Redis-bookkeeping fact the prior session's spike found inverted, and the
// one a SIGKILL alone (without this task's production fix) makes false
// immediately, with no need to wait for anything. (2) only after that does
// this file wait for the recovery pass and assert the final row count.
// Keeping both means a regression that reintroduces the old "acked too
// early" bug fails FAST, on the bookkeeping check, rather than only ever
// surfacing as a slow, generic "row count wrong" failure after a multi
// -minute wait.
//
// --- WHY 'completed' ALONE IS ENOUGH TO TRUST THE ROW IS ALREADY THERE --
//
// `EventsConsumer.process()` only resolves (and BullMQ only marks a job
// `'completed'`) once `sink.handle()` — and therefore `accumulator.add()`
// — has resolved, which under the T3.5.4 contract happens only once that
// event's batch has actually flushed to Postgres (and R2). So polling
// `EVENTS_QUEUE`'s own `completed` count up to the total pushed is already
// sufficient proof every corresponding row exists; the Postgres query this
// file runs afterward is the STRONGER, ground-truth check (byte-for-byte
// count and distinct-id equality), not a second independent wait.
//
// --- ISOLATION -----------------------------------------------------------
//
// A fresh tenant (and link) per kill point, all under this test's OWN
// freshly booted Postgres/Redis testcontainers pair (never the shared
// docker-compose services) — every row-count query scopes by `tenant_id`,
// so nothing here depends on being the only test touching Postgres.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 900_000 });

const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

// Mirrors every sibling harness file's own local-dev-only MinIO root
// credentials (already in .env.example, not a real secret).
const REAL_R2_ENDPOINT = 'http://localhost:9000';
const REAL_R2_ACCESS_KEY_ID = 'posta-local-dev';
const REAL_R2_SECRET_ACCESS_KEY = 'posta-local-dev-secret';
const REAL_R2_BUCKET = 'posta-events';
const R2_ACCOUNT_ID = 'test-account-id';

const TEST_DB_POOL_MAX = 5;
const HEALTH_POLL_INTERVAL_MS = 200;
const KILL_EXIT_TIMEOUT_MS = 10_000;

// Per kill-point event count — large enough to be a genuine partial batch,
// small enough that three of these plus one shared recovery pass stays
// well inside this file's own generous hook timeout.
const PARTIAL_BATCH_SIZE = 15;

// See this file's own header, "THREE KILL POINTS" — a REAL interval, not
// parked, so the kill happens at a genuinely different point in the
// batch's own lifetime each time, always comfortably before this interval
// would otherwise fire.
// [timing margin, found empirically] 15s, not 8s: the interval timer
// starts the instant the FIRST of the PARTIAL_BATCH_SIZE events is
// add()-ed, not when this file's own `waitForBatchSize()` call below
// returns (which only resolves once the LAST of them has been dispatched
// and added) — real Redis round trips for dispatching all
// PARTIAL_BATCH_SIZE jobs land in that gap. An 8s interval left the
// "late" kill point's own 90%-through sleep (7200ms) with only ~800ms of
// slack, which one real RED-phase run below genuinely ate: the batch
// auto-flushed before the kill even landed, at real assertion level
// ("has NOT flushed..." failed with `expected 15 to be 0`) — a false
// signal unrelated to the bug this file exists to catch. 15s leaves the
// same 90% point ~3.75s of slack instead.
const BATCH_INTERVAL_MS = 15_000;
// workerEnvSchema's own ceiling (env.ts) — comfortably above
// PARTIAL_BATCH_SIZE, so the count trigger never fires on any of the three
// killed workers either.
const BATCH_SIZE_NEVER_HIT = 500;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const KILL_POINTS: ReadonlyArray<{ readonly label: string; readonly fraction: number }> = [
  { label: 'early — 10% through the batch interval', fraction: 0.1 },
  { label: 'mid — 50% through the batch interval', fraction: 0.5 },
  // 75%, not 90% — see BATCH_INTERVAL_MS's own comment above for why 90%
  // left too little real-world slack.
  { label: 'late — 75% through the batch interval', fraction: 0.75 },
];

// The recovery worker's own batching knobs — deliberately fast (a short
// interval, a generous count ceiling) so it drains everything the three
// dead workers left behind quickly once BullMQ redelivers it, rather than
// this file also waiting out a second long interval on top of the stall
// -detection latency it already has to pay.
const RECOVERY_BATCH_SIZE = 500;
const RECOVERY_BATCH_INTERVAL_MS = 1_000;

// Generous: comfortably covers BullMQ's own default lockDuration (30000ms)
// plus a full stalledInterval cycle (30000ms) the prior session's spike
// already empirically validated as sufficient (it used 70s), plus real
// wall-clock room for the recovery worker to then process and flush
// PARTIAL_BATCH_SIZE * KILL_POINTS.length events afterward.
const STALL_REDELIVERY_TIMEOUT_MS = 150_000;
const REDELIVERY_POLL_INTERVAL_MS = 1_000;

const SETUP_TIMEOUT_MS = 900_000;
const TEARDOWN_TIMEOUT_MS = 120_000;

function buildEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DB_POOL_MAX: String(TEST_DB_POOL_MAX),
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: REAL_R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: REAL_R2_SECRET_ACCESS_KEY,
    R2_BUCKET_EVENTS: REAL_R2_BUCKET,
    R2_ENDPOINT: REAL_R2_ENDPOINT,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    ...overrides,
  };
}

/** Waits for the child process's own `'exit'` event, bounded by
 * `timeoutMs` — used ONLY after a SIGKILL has already been sent (unlike
 * pipeline-harness-process.ts's own `stopWorkerProcess`, this never sends
 * a signal itself, and never retries with a stronger one — a process that
 * doesn't exit after SIGKILL is a kernel-level problem this test cannot
 * solve). */
function waitForForcedExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`worker child process did not exit within ${timeoutMs}ms after SIGKILL`));
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Polls `GET /health` until `batch_size` reaches `target` — the signal
 * that all `target` pushed events have genuinely reached the accumulator
 * (not merely been enqueued), mirroring shutdown.test.ts's/
 * sigterm-flush.test.ts's own identical T3.5.4 fixture-signal update. */
async function waitForBatchSize(port: number, target: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastBody: WorkerHealthStatus | undefined;

  while (Date.now() < deadline) {
    lastBody = await fetchHealth(port);
    if (lastBody.batch_size === target) return;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    `worker /health's batch_size did not reach ${target} within ${timeoutMs}ms — last observed: ` +
      `${JSON.stringify(lastBody)}`,
  );
}

interface JobCounts {
  readonly completed: number;
  readonly active: number;
  readonly waiting: number;
  readonly delayed: number;
  readonly failed: number;
}

async function readJobCounts(queue: Queue): Promise<JobCounts> {
  const counts = await queue.getJobCounts('completed', 'active', 'waiting', 'delayed', 'failed');
  return {
    completed: counts.completed ?? 0,
    active: counts.active ?? 0,
    waiting: counts.waiting ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
  };
}

/** Polls `EVENTS_QUEUE`'s own job counts until `completed` reaches
 * `target` — see this file's own header, "WHY 'completed' ALONE IS ENOUGH
 * TO TRUST THE ROW IS ALREADY THERE", for why this alone is sufficient
 * proof every corresponding Postgres row already exists by the time this
 * resolves. */
async function waitForCompletedCount(queue: Queue, target: number, timeoutMs: number): Promise<JobCounts> {
  const deadline = Date.now() + timeoutMs;
  let lastCounts: JobCounts = { completed: 0, active: 0, waiting: 0, delayed: 0, failed: 0 };

  while (Date.now() < deadline) {
    lastCounts = await readJobCounts(queue);
    if (lastCounts.completed >= target) return lastCounts;
    await sleep(REDELIVERY_POLL_INTERVAL_MS);
  }

  throw new Error(
    `EVENTS_QUEUE's completed count did not reach ${target} within ${timeoutMs}ms — last observed: ` +
      `${JSON.stringify(lastCounts)}`,
  );
}

interface TenantRowCounts {
  readonly total: number;
  readonly distinct: number;
}

async function countEventsForTenant(pg: PgContainerHandle, tenantId: string): Promise<TenantRowCounts> {
  const result = await pg.pool.query<{ total: string; distinct_count: string }>(
    'SELECT COUNT(*) AS total, COUNT(DISTINCT event_id) AS distinct_count FROM events WHERE tenant_id = $1',
    [tenantId],
  );
  const row = result.rows[0]!;
  return { total: Number(row.total), distinct: Number(row.distinct_count) };
}

interface KillScenarioResult {
  readonly label: string;
  readonly tenantId: string;
  readonly events: readonly CaptureEvent[];
  readonly rowCountBeforeKill: TenantRowCounts;
}

describe('worker killed with SIGKILL mid-batch loses nothing and duplicates nothing (T3.5.4)', () => {
  let redis: RedisContainerHandle;
  let pg: PgContainerHandle;
  let queue: Queue<CaptureEvent>;
  let scenarios: KillScenarioResult[];
  let jobCountsAfterAllKills: JobCounts;
  let jobCountsAfterRecovery: JobCounts;
  let finalCountsByScenario: TenantRowCounts[];
  let recoveryHealth: WorkerHealthStatus;
  let recoverySpawned: { child: ChildProcess; getOutput: () => string } | undefined;

  beforeAll(async () => {
    await buildWorkerExclusively();
    const totalPushed = KILL_POINTS.length * PARTIAL_BATCH_SIZE;

    [redis, pg] = await Promise.all([startRedisContainer(), startPgContainer()]);
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

    queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    // [test-isolation discipline, matching every sibling harness file]
    await queue.obliterate({ force: true });

    const corpus = loadCorpus();
    scenarios = [];

    for (const point of KILL_POINTS) {
      const tenantId = await seedTenant(pg);
      const linkId = await seedLink(pg, tenantId, HARNESS_SLUG, HARNESS_DESTINATION);
      const occurredAt = new Date().toISOString();

      const port = await getFreePort();
      // [T3.5.4 fix-forward] spawnWorkerExclusively(), not a bare
      // spawnWorker() — see that function's own header
      // (pipeline-harness-process.ts) for the real, reproduced "Cannot
      // find module main.js" race it closes.
      const spawned = await spawnWorkerExclusively(
        buildEnv({
          DATABASE_URL_WORKER: pg.url,
          REDIS_URL: redis.url,
          WORKER_PORT: String(port),
          EVENT_BATCH_SIZE: String(BATCH_SIZE_NEVER_HIT),
          EVENT_BATCH_INTERVAL_MS: String(BATCH_INTERVAL_MS),
          // [T3.5.4] See events.consumer.ts's own header — at most
          // WORKER_CONCURRENCY events can ever be simultaneously "added
          // but not yet flushed" under the new accumulator.add() contract;
          // the default (8) cannot hold all PARTIAL_BATCH_SIZE (15) at
          // once.
          WORKER_CONCURRENCY: String(PARTIAL_BATCH_SIZE),
        }),
      );

      await waitForHealth(spawned.child, port, spawned.getOutput);

      const events: CaptureEvent[] = Array.from({ length: PARTIAL_BATCH_SIZE }, (_unused, index) =>
        buildCaptureEventFromCorpus(corpus[index % corpus.length]!, {
          tenantId,
          linkId,
          slug: HARNESS_SLUG,
          occurredAt,
        }),
      );
      await Promise.all(events.map((event) => queue.add('capture', event)));

      // Proves the events are genuinely ACCUMULATED, not merely enqueued —
      // see this file's own header.
      await waitForBatchSize(port, PARTIAL_BATCH_SIZE, 30_000);

      // See this file's own header, "THREE KILL POINTS" — a genuinely
      // different point in the batch's own lifetime each iteration, always
      // comfortably before BATCH_INTERVAL_MS would fire on its own.
      await sleep(Math.floor(BATCH_INTERVAL_MS * point.fraction));

      const rowCountBeforeKill = await countEventsForTenant(pg, tenantId);

      spawned.child.kill('SIGKILL');
      await waitForForcedExit(spawned.child, KILL_EXIT_TIMEOUT_MS);

      scenarios.push({ label: point.label, tenantId, events, rowCountBeforeKill });
    }

    // See this file's own header, "WHAT PROVES THE MECHANISM, NOT JUST THE
    // END STATE" — captured BEFORE the recovery worker ever boots.
    jobCountsAfterAllKills = await readJobCounts(queue);

    const recoveryPort = await getFreePort();
    recoverySpawned = await spawnWorkerExclusively(
      buildEnv({
        DATABASE_URL_WORKER: pg.url,
        REDIS_URL: redis.url,
        WORKER_PORT: String(recoveryPort),
        EVENT_BATCH_SIZE: String(RECOVERY_BATCH_SIZE),
        EVENT_BATCH_INTERVAL_MS: String(RECOVERY_BATCH_INTERVAL_MS),
        WORKER_CONCURRENCY: String(totalPushed),
      }),
    );
    await waitForHealth(recoverySpawned.child, recoveryPort, recoverySpawned.getOutput);

    jobCountsAfterRecovery = await waitForCompletedCount(queue, totalPushed, STALL_REDELIVERY_TIMEOUT_MS);
    recoveryHealth = await fetchHealth(recoveryPort);

    finalCountsByScenario = await Promise.all(
      scenarios.map((scenario) => countEventsForTenant(pg, scenario.tenantId)),
    );

    await stopWorkerProcess(recoverySpawned.child, recoverySpawned.getOutput);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (recoverySpawned && recoverySpawned.child.exitCode === null && recoverySpawned.child.signalCode === null) {
      recoverySpawned.child.kill('SIGKILL');
    }
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await pg.stop();
    await redis.stop();
  }, TEARDOWN_TIMEOUT_MS);

  it.each(KILL_POINTS.map((point, index) => ({ point, index })))(
    'has NOT flushed before the SIGKILL at the "$point.label" point — genuinely still in-memory',
    ({ index }) => {
      const scenario = scenarios[index]!;
      expect(scenario.rowCountBeforeKill.total).toBe(0);
    },
  );

  it(
    '[core mechanism] immediately after all three SIGKILLs, every pushed job is still BullMQ-active with ' +
      'nothing marked completed — proves the ack now waits for the real flush, not merely for accumulation',
    () => {
      const totalPushed = KILL_POINTS.length * PARTIAL_BATCH_SIZE;
      expect(jobCountsAfterAllKills.completed).toBe(0);
      expect(jobCountsAfterAllKills.active).toBe(totalPushed);
      expect(jobCountsAfterAllKills.failed).toBe(0);
    },
  );

  it('BullMQ redelivers every un-acked job to the recovery worker — completed reaches the full pushed total', () => {
    const totalPushed = KILL_POINTS.length * PARTIAL_BATCH_SIZE;
    expect(jobCountsAfterRecovery.completed).toBe(totalPushed);
    expect(jobCountsAfterRecovery.failed).toBe(0);
  });

  it.each(KILL_POINTS.map((point, index) => ({ point, index, expected: PARTIAL_BATCH_SIZE })))(
    'the "$point.label" batch lands exactly $expected rows after recovery — count(*) = count(distinct event_id)',
    ({ index }) => {
      const finalCounts = finalCountsByScenario[index]!;
      expect(finalCounts.total).toBe(PARTIAL_BATCH_SIZE);
      expect(finalCounts.distinct).toBe(PARTIAL_BATCH_SIZE);
    },
  );

  it('[no loss, no duplication] the sum across all three kill points equals the total pushed, exactly', () => {
    const totalPushed = KILL_POINTS.length * PARTIAL_BATCH_SIZE;
    const totalLanded = finalCountsByScenario.reduce((sum, counts) => sum + counts.total, 0);
    const totalDistinct = finalCountsByScenario.reduce((sum, counts) => sum + counts.distinct, 0);
    expect(totalLanded).toBe(totalPushed);
    expect(totalDistinct).toBe(totalPushed);
  });

  it('routes nothing to the dead-letter queue', () => {
    expect(recoveryHealth.dlq_depth).toBe(0);
  });
});
