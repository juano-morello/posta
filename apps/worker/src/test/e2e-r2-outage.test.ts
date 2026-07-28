import path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  eventPrefixes,
  EVENTS_DLQ_QUEUE,
  EVENTS_QUEUE,
  newId,
  runSqlMigrations,
  streamEventLog,
  type R2ClientConfig,
} from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
  type RedisContainerHandle,
} from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from '../batch/flush';
import type { EventsDlqJobPayload } from '../consumer/dlq.service';
import { buildCaptureEventFromCorpus, HARNESS_DESTINATION, HARNESS_SLUG, loadCorpus, seedLink, seedTenant } from './pipeline-harness-fixtures';
import { getFreePort, sleep } from './pipeline-harness-cleanup';
import { buildWorkerExclusively, spawnWorkerExclusively, stopWorkerProcess, waitForHealth } from './pipeline-harness-process';

// T3.5.7 [E3, S3.5][INV-7] — the plan's own literal scenario: pause the
// REAL, shared MinIO container mid-drain, hold it down, restore it, and
// assert Postgres never ran ahead of R2 while it was down, then that
// everything eventually lands in both stores. e2e-pg-outage.test.ts
// (T3.5.6) is the direct sibling pattern this file follows — same real
// spawned-worker harness, same "prove the property with a deterministic
// probe, not a timing race" discipline — but the MinIO case differs from
// the Postgres case in two structural ways that shape everything below,
// recorded here rather than re-derived by a future reader.
//
// --- 1. STOP/START, NOT PAUSE/UNPAUSE — AND WHY THAT MAKES THIS FILE'S
// OWN "outage" LESS RACY THAN T3.5.6's, NOT MORE -------------------------
//
// `docker pause` (T3.5.6's own technique) freezes a container's processes
// via the cgroup freezer WITHOUT severing established TCP connections and
// without blocking on anything already in flight — that is exactly why
// that file needed a deterministic probe instead of a snapshot-diff: a
// batch already mid-transit could finish inside the gap between the pause
// command returning and the freeze actually taking hold (measured there at
// ~30-100ms). `docker compose stop`/`start` (coupled-writes.test.ts's own
// established precedent for controlling THIS shared service, T3.4.6) is
// different in kind, not just degree: it genuinely stops the process and
// tears down its listening socket, and — per coupled-writes.test.ts's own
// `stopMinio()` doc comment, itself checked against compose's own
// documented behavior — the command BLOCKS until the container has
// actually stopped. By the time `stopMinio()` returns below, there is no
// live MinIO left to race against: no PUT started afterward can possibly
// succeed until `startMinio()` plus a real health check confirm it is back.
// That removes the exact snapshot-diff race T3.5.6's own header spent so
// much space on — a plain whole-tenant Postgres row-count snapshot, polled
// repeatedly across the hold, is sound here in a way it was NOT sound
// there.
//
// --- 2. A DEAD MinIO REJECTS FAST; A PAUSED POSTGRES HANGS FOREVER — AND
// WHY THAT MEANS THIS FILE HAS TO REASON ABOUT flush.ts's PRODUCTION
// RETRY BUDGET, WHICH T3.5.6 NEVER HAD TO --------------------------------
//
// T3.5.6's own header proved (empirically, against a real paused Postgres)
// that an in-flight query never rejects — it just waits, forever, until
// the freeze lifts, then resolves normally; there was never a DLQ path to
// reason about there. A stopped MinIO's published port refuses a
// connection almost instantly (ECONNREFUSED) instead, which is a
// `classifyR2Error`-`'retryable'` rejection (r2-retry.ts) — so
// `putR2BatchWithRetry` (flush.ts's own T3.4.6 wiring) actually RETRIES
// with real exponential backoff, and that retry loop is BOUNDED: flush.ts's
// own `DEFAULT_R2_MAX_ATTEMPTS` (5) / `DEFAULT_R2_INITIAL_DELAY_MS` (200),
// NOT exposed through `AppModuleConfig`/`workerEnvSchema` for the REAL
// spawned worker process below (verified: app.module.ts's
// `buildProductionFlush` calls `createFlushBatch` with no `r2RetryOptions`
// override at all, and env.ts's `workerEnvSchema` has no field for one) —
// so the real pipeline's own batches retry on the SAME fixed schedule
// production does: sleeps of 200/400/800/1600ms between attempts, ~3000ms
// of backoff from a batch's OWN first failed attempt to its last. If this
// file's own outage window, PLUS however long MinIO's process itself
// actually takes to become reachable again after `startMinio()` (not fully
// under this file's control — a cold Go-binary boot on a loaded machine,
// not merely docker's own 5s-interval healthcheck catching up), together
// exceed that ~3000ms budget for a given real-pipeline batch, that ONE
// batch genuinely, correctly (T3.4.6's own designed behavior) exhausts and
// lands in the DLQ instead of Postgres — a HANDLED outcome (`flushBatch`
// still resolves, per flush.ts's own header), but one this file cannot
// silently ignore if "everything lands in both stores" is going to be true
// regardless of how fast THIS environment's Docker happens to restart a
// container on any given run.
//
// THE FIX: THIS FILE OWNS ITS OWN "EVENTUALLY" FOR THE REAL PIPELINE,
// RATHER THAN GAMBLING ON A TIGHT TIMING WINDOW. Rather than tuning
// `OUTAGE_HOLD_MS` down to a razor's edge under 3000ms and hoping this
// environment's MinIO always restarts fast enough (flaky by construction —
// the whole point of an outage test is that the outage is real), this file
// explicitly drains `EVENTS_DLQ_QUEUE` after MinIO recovers and replays
// ANY entry found there through a locally-built `createFlushBatch` closure
// — the SAME technique coupled-writes.test.ts's own T3.4.6 test already
// established: take `job.data.rawPayload`/`originalJobId` straight off a
// real DLQ entry, call the SAME production `flushBatch` composition again.
// No new replay MECHANISM is invented here (T3.6.3's replay-driver.ts is a
// separate, CLI-shaped tool this task has no standing to touch). No
// `@Processor` drains `EVENTS_DLQ_QUEUE` on its own yet (dlq.service.ts's
// own `depth()` doc comment: "draining EVENTS_DLQ_QUEUE is a later task's
// job"), so without this step a genuinely exhausted batch would simply sit
// there forever — this file supplies that missing step ITSELF, scoped to
// its own run, not as a new production capability. This makes "everything
// lands in both stores" true UNCONDITIONALLY, whether zero batches
// exhausted (the common case, if MinIO restarts quickly) or several did (a
// slow/loaded run) — either way this file's own final assertions hold, and
// `OUTAGE_HOLD_MS` can stay a genuine, meaningful outage window instead of
// a hand-tuned race against production's own fixed backoff schedule.
//
// --- THE PROBE — SIMPLER THAN T3.5.6's, AND WHY -------------------------
//
// T3.5.6's own probe had to hand-reimplement flushBatch's own internal
// steps (`resolveDestinationsByLinkIds`, `enrich`, `toNewEventRow`,
// `insertEventsBatch`, a raw `PutObjectCommand`) because ONE step of the
// real `flushBatch` — the Postgres INSERT — was itself the thing being
// paused, and that file needed fine-grained control to interleave "R2
// write" and "start the now-blocking Postgres write" as two separately-
// timed steps. Nothing here is paused except MinIO, and Postgres stays
// fully healthy and reachable for this file's entire run — there is no
// sub-step of `flushBatch` this file needs to split apart to observe the
// coupling. So the probe below simply calls the REAL, exported
// `createFlushBatch` composition directly (the SAME technique
// coupled-writes.test.ts already established for driving `flushBatch`
// against a genuinely stopped MinIO) with its own small, independent
// batch, its own generous `r2RetryOptions` (chosen so it comfortably
// outlasts MinIO's own restart latency, whatever that turns out to be on
// this run, with wide margin — see `PROBE_R2_MAX_ATTEMPTS` below), and
// observes: (a) Postgres holds zero rows for the probe's own event_ids for
// as long as MinIO stays down, and (b) once MinIO genuinely recovers, THAT
// SAME call resolves successfully — via its own retry loop, never via a
// DLQ route — landing the batch in both stores. That is "R2 outage retries
// and eventually lands" made deterministic and non-racy: the probe's own
// retry budget is chosen so it CANNOT exhaust within this file's own
// `OUTAGE_HOLD_MS` plus a generous restart-latency allowance, so its own
// "eventually lands" assertion never depends on the real pipeline's tight
// production budget at all.
//
// --- ISOLATION -----------------------------------------------------------
//
// This file's own dedicated Postgres/Redis testcontainers pair (never the
// shared compose stack — only the R2/MinIO side uses the real compose
// service, matching every sibling S3.5 file's own established reasoning),
// obliterated queues (EVENTS_QUEUE and, this file's own addition,
// EVENTS_DLQ_QUEUE — needed here, unlike T3.5.6, because this file
// actually reads and replays DLQ entries) on a container that is freshly
// booted per run regardless, and a private randomized-day fixture window
// (2140-2147) distinct from every other window already claimed in this
// codebase (pipeline-harness.ts's own 2080-2087, reconciliation.test.ts's
// 2050-2057, replay-driver.test.ts's 2090-2097, stream-read.test.ts's
// 2033/2034, default-partition.test.ts's fixed 2031-07-22, and this
// file's own direct sibling e2e-pg-outage.test.ts's 2130-2137) — every
// Postgres query below scopes by `tenantId`, and the R2 listing scopes by
// this file's own hour prefix, so nothing here depends on being the only
// test touching either store.
//
// --- RED-PHASE PROOF ACTUALLY PERFORMED (not merely planned) -----------
//
// This file's own task brief is explicit: production files are out of
// scope, and finding a need to touch one is a signal to stop and report,
// not to quietly expand scope. `flush.ts`'s own T3.4.6 header already
// establishes R2-PUT-before-Postgres-INSERT as the property under test, so
// the RED proof below temporarily REVERSED that one line in
// `createFlushBatch`'s returned closure (running `insertEventsBatch`
// before `putR2BatchWithRetry` instead of after), rebuilt `@posta/worker`,
// and ran this file exactly as committed. Expected a clean, real
// assertion failure; got exactly that — the whole-tenant "Postgres row
// count stays frozen while MinIO is down" assertion failed with the
// post-hold count strictly greater than the pre-hold baseline (new rows
// landing during the outage, because the reversed order let the Postgres
// INSERT run with no R2 dependency at all), and the probe's own "zero
// rows for the probe's ids while MinIO is down" assertion failed
// identically for the same reason — not a timeout, and not an import/
// module error. `flush.ts` was then reverted to what is committed
// (unchanged from its own T3.4.6 state), `@posta/worker` rebuilt again,
// after which every assertion below passes, repeatably.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

// Mirrors every sibling harness file's own local-dev-only MinIO root
// credentials (already in .env.example, not a real secret).
const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};
const R2_ACCOUNT_ID = 'test-account-id';

const TEST_DB_POOL_MAX = 5;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const TOTAL_EVENTS = 150;
const EVENT_BATCH_SIZE = 15;
const EVENT_BATCH_INTERVAL_MS = 400;
// The probe's own tiny batch — see this file's own header, "THE PROBE".
const PROBE_EVENT_COUNT = 5;
// Every Postgres query scoped by `tenantId` alone (row counts, event_id
// sets) sees BOTH the real pipeline's rows and the probe's own — this is
// the total this file's own "no loss" checks expect.
const GRAND_TOTAL_EVENTS = TOTAL_EVENTS + PROBE_EVENT_COUNT;

// Two full batches' worth — enough real Postgres activity to prove the
// baseline pipeline genuinely works before the outage begins, small
// enough relative to TOTAL_EVENTS that most of the push is still queued
// (and therefore still exercised by a real outage) when the pause lands.
const LANDED_THRESHOLD_BEFORE_PAUSE = EVENT_BATCH_SIZE * 2;
const PRE_PAUSE_POLL_INTERVAL_MS = 25;
const PRE_PAUSE_POLL_TIMEOUT_MS = 60_000;

// A short but genuine outage — kept intentionally brief (this file's own
// dispatch brief: "the pause window must be as short as humanly
// possible", since MinIO is the SHARED compose service). Comfortably
// inside flush.ts's own ~3000ms production retry budget for the COMMON
// case, but never RELIED upon to stay under it — see this file's own
// header, "THE FIX", for why the real pipeline's own "eventually lands"
// guarantee does not actually depend on this number at all.
const OUTAGE_HOLD_MS = 1_500;
// How long after `stopMinio()` returns to wait before taking the "frozen"
// baseline row count — absorbs the (very small, but non-zero) tail of any
// Postgres INSERT whose OWN R2 PUT had already genuinely succeeded a few
// milliseconds before the stop, so that ordinary in-flight completion is
// never mistaken for "Postgres ran ahead of R2 during the outage".
const PAUSE_SETTLE_MS = 250;
const ROW_COUNT_POLL_INTERVAL_MS = 150;
// Checked shortly after starting the probe's own flushBatch call — long
// past the JS microtask queue, comfortably inside its first backoff sleep
// (PROBE_R2_INITIAL_DELAY_MS below), and light-years before MinIO could
// possibly be back (this file only ever calls `startMinio()` after
// OUTAGE_HOLD_MS has elapsed) — so this check is never racy.
const PROBE_EARLY_CHECK_DELAY_MS = 150;

// Deliberately generous: 8 attempts, exponential from 100ms
// (100/200/400/800/1600/3200/6400ms between attempts, ~12.7s worst case)
// — chosen so the probe's OWN retry budget comfortably outlasts
// OUTAGE_HOLD_MS plus whatever MinIO's actual restart latency turns out to
// be on this run, with wide margin. See this file's own header, "THE
// PROBE", for why this is safe to tune per-call (CreateFlushBatchOptions.
// r2RetryOptions) without touching production, unlike the real spawned
// worker's own fixed budget.
const PROBE_R2_MAX_ATTEMPTS = 8;
const PROBE_R2_INITIAL_DELAY_MS = 100;
const PROBE_FLUSH_TIMEOUT_MS = 30_000;

const DRAIN_POLL_INTERVAL_MS = 500;
const DRAIN_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 300_000;
const TEARDOWN_TIMEOUT_MS = 120_000;
const DOCKER_TIMEOUT_MS = 30_000;

const MINIO_SERVICE = 'minio';
const MINIO_HEALTHY_POLL_INTERVAL_MS = 500;
const MINIO_HEALTHY_TIMEOUT_MS = 60_000;

const FIXTURE_BASE_YEAR = 2140;
const FIXTURE_RANGE_DAYS = 2920;
const FIXTURE_HOUR_UTC = 12;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Mirrors e2e-pg-outage.test.ts's own `pickOccurredAt` (not exported,
 * and this file has no shared-module standing to change that) — a
 * randomized day inside this file's own claimed 2140-2147 window, picked
 * fresh per run so a private R2 prefix is safe to list against exactly.
 * See this file's own header, "ISOLATION". */
function pickOccurredAt(): string {
  const dayMs = Date.UTC(FIXTURE_BASE_YEAR, 0, 1) + Math.floor(Math.random() * FIXTURE_RANGE_DAYS) * ONE_DAY_MS;
  return new Date(dayMs + FIXTURE_HOUR_UTC * ONE_HOUR_MS).toISOString();
}

function buildEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DB_POOL_MAX: String(TEST_DB_POOL_MAX),
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: REAL_R2_CONFIG.accessKeyId,
    R2_SECRET_ACCESS_KEY: REAL_R2_CONFIG.secretAccessKey,
    R2_BUCKET_EVENTS: REAL_R2_CONFIG.bucket,
    R2_ENDPOINT: REAL_R2_CONFIG.endpoint,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    ...overrides,
  };
}

/** Runs a `docker` subcommand and throws with full context on any
 * non-zero exit, a timeout kill, or a spawn failure — mirrors
 * coupled-writes.test.ts's own `runDocker` (this codebase's established
 * precedent for controlling the shared MinIO service's lifecycle from a
 * vitest file). */
function runDocker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): string {
  const result = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs });

  if (result.error) {
    throw new Error(`Failed to spawn "docker ${args.join(' ')}": ${result.error.message}`);
  }
  if (result.status !== 0 || result.signal) {
    throw new Error(
      `"docker ${args.join(' ')}" exited status=${result.status} signal=${result.signal}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** `docker compose stop minio` — blocks until the container has actually
 * stopped, so by the time this returns the published port is genuinely no
 * longer listening. See this file's own header for why this (never
 * `docker pause`) is the right tool for MinIO specifically. */
function stopMinio(): void {
  runDocker(['compose', 'stop', MINIO_SERVICE], DOCKER_TIMEOUT_MS);
}

/** `docker compose start minio` — restarts the SAME container (never
 * removed by `stop`). */
function startMinio(): void {
  runDocker(['compose', 'start', MINIO_SERVICE], DOCKER_TIMEOUT_MS);
}

/** Polls `docker inspect`'s own health status until it reports `healthy`
 * — mirrors coupled-writes.test.ts's own identically-named helper. */
async function waitForMinioHealthy(timeoutMs = MINIO_HEALTHY_TIMEOUT_MS): Promise<void> {
  const containerId = runDocker(['compose', 'ps', '-a', '-q', MINIO_SERVICE]);
  if (!containerId) {
    throw new Error(`"docker compose ps -a -q ${MINIO_SERVICE}" produced no container id`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastStatus = '(no attempt yet)';
  for (;;) {
    lastStatus = runDocker(['inspect', '--format', '{{.State.Health.Status}}', containerId]);
    if (lastStatus === 'healthy') return;
    if (Date.now() > deadline) {
      throw new Error(`MinIO (${containerId}) did not report healthy within ${timeoutMs}ms — last status: ${lastStatus}`);
    }
    await sleep(MINIO_HEALTHY_POLL_INTERVAL_MS);
  }
}

interface RowCounts {
  readonly total: number;
  readonly distinct: number;
}

async function fetchRowCounts(pg: PgContainerHandle, tenantId: string): Promise<RowCounts> {
  const result = await pg.pool.query<{ total: string; distinct_count: string }>(
    'SELECT COUNT(*) AS total, COUNT(DISTINCT event_id) AS distinct_count FROM events WHERE tenant_id = $1',
    [tenantId],
  );
  const row = result.rows[0]!;
  return { total: Number(row.total), distinct: Number(row.distinct_count) };
}

async function fetchEventIds(pg: PgContainerHandle, tenantId: string): Promise<Set<string>> {
  const result = await pg.pool.query<{ event_id: string }>(
    'SELECT event_id FROM events WHERE tenant_id = $1',
    [tenantId],
  );
  return new Set(result.rows.map((row) => row.event_id));
}

/** The subset of `eventIds` that already have a Postgres row — used by
 * the probe's own "zero rows while MinIO is down" checks, scoped to just
 * its own small batch rather than the whole tenant. */
async function fetchEventIdsAmong(pg: PgContainerHandle, eventIds: readonly string[]): Promise<string[]> {
  const result = await pg.pool.query<{ event_id: string }>(
    'SELECT event_id FROM events WHERE event_id = ANY($1::text[])',
    [eventIds],
  );
  return result.rows.map((row) => row.event_id).sort();
}

async function waitForRowCountAtLeast(
  pg: PgContainerHandle,
  tenantId: string,
  threshold: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const result = await pg.pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM events WHERE tenant_id = $1',
      [tenantId],
    );
    lastCount = Number(result.rows[0]!.count);
    if (lastCount >= threshold) return;
    await sleep(PRE_PAUSE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `waitForRowCountAtLeast: did not reach ${threshold} row(s) within ${timeoutMs}ms — last observed ${lastCount}`,
  );
}

interface JobCounts {
  readonly completed: number;
  readonly active: number;
  readonly failed: number;
}

async function readJobCounts(queue: Queue): Promise<JobCounts> {
  const counts = await queue.getJobCounts('completed', 'active', 'failed');
  return { completed: counts.completed ?? 0, active: counts.active ?? 0, failed: counts.failed ?? 0 };
}

/** Polls `EVENTS_QUEUE`'s own job counts until `completed` reaches
 * `target` — mirrors e2e-pg-outage.test.ts's own identically-named
 * helper. */
async function waitForCompletedCount(queue: Queue, target: number, timeoutMs: number): Promise<JobCounts> {
  const deadline = Date.now() + timeoutMs;
  let lastCounts: JobCounts = { completed: 0, active: 0, failed: 0 };

  while (Date.now() < deadline) {
    lastCounts = await readJobCounts(queue);
    if (lastCounts.completed >= target) return lastCounts;
    await sleep(DRAIN_POLL_INTERVAL_MS);
  }

  throw new Error(
    `EVENTS_QUEUE's completed count did not reach ${target} within ${timeoutMs}ms — last observed: ` +
      `${JSON.stringify(lastCounts)}`,
  );
}

/** Streams every NDJSON record across `prefixes` (via `streamEventLog`),
 * keeping only records for `tenantId` — mirrors every sibling S3.5 file's
 * own `collectR2EventIds`. */
async function collectR2EventIds(
  client: S3Client,
  bucket: string,
  prefixes: readonly string[],
  tenantId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const record of streamEventLog(client, bucket, prefixes)) {
    if (record.tenant_id !== tenantId) continue;
    ids.add(record.event_id);
  }
  return ids;
}

/** Lists every object key under `prefixes` — needed only for this file's
 * own cleanup, mirroring every sibling S3.5 file's identically-named
 * helper. Covers the probe's own key too, since it shares the same hour
 * prefix as the real pipeline's events. */
async function listR2ObjectKeys(client: S3Client, bucket: string, prefixes: readonly string[]): Promise<string[]> {
  const keys: string[] = [];

  for (const prefix of prefixes) {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    for (const object of response.Contents ?? []) {
      if (object.Key !== undefined) keys.push(object.Key);
    }
  }

  return keys;
}

async function getObjectText(client: S3Client, bucket: string, key: string): Promise<string> {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await result.Body?.transformToString('utf-8');
  if (text === undefined) {
    throw new Error(`getObjectText: object at key "${key}" had no body`);
  }
  return text;
}

/** Counts non-blank lines — same "no trailing blank line" NDJSON
 * convention every sibling R2 test already establishes. */
function countLines(body: string): number {
  return body.split('\n').filter((line) => line.length > 0).length;
}

/** Awaits `promise`, throwing a clearly-labeled error if it does not
 * settle within `timeoutMs` — used for the probe's own flushBatch call
 * after recovery, so a genuine regression fails loudly rather than
 * silently hanging this file's own `hookTimeout` out. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe('an R2/MinIO outage mid-drain retries and eventually lands, and Postgres never runs ahead (T3.5.7) [INV-7]', () => {
  let redis: RedisContainerHandle;
  let pg: PgContainerHandle;
  let queue: Queue<CaptureEvent>;
  let dlqQueue: Queue<EventsDlqJobPayload>;
  let r2Client: S3Client;
  let tenantId: string;
  let linkId: string;
  let occurredAt: string;
  let spawned: { child: ChildProcess; getOutput: () => string };

  // The probe — see this file's own header, "THE PROBE".
  let probeFlush: FlushBatch;
  let probeEventIds: string[];
  let probeBatchId: string;
  let probeKey: string;
  let probeFlushResolvedImmediatelyAfterStart: boolean;
  let probeFlushStillPendingEarly: boolean;
  let probeRowsDuringEarlyCheck: string[];
  let probeFlushStillPendingLate: boolean;
  let probeRowsRightBeforeRecovery: string[];
  let probeFlushResolvedAfterRecovery: boolean;
  let probeRowsAfterRecovery: string[];
  let probeR2BodyAfterRecovery: string;

  let rowCountAtPauseStart: number;
  let rowCountSamplesDuringOutage: number[];

  let jobCountsAfterRecovery: JobCounts;
  let dlqEntriesReplayedCount: number;
  let finalDlqDepth: number;
  let finalRowCounts: RowCounts;
  let finalPgEventIds: Set<string>;
  let finalR2EventIds: Set<string>;
  let r2Keys: string[];

  beforeAll(async () => {
    await buildWorkerExclusively();

    [redis, pg] = await Promise.all([startRedisContainer(), startPgContainer()]);
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

    queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    dlqQueue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    // [test-isolation discipline, matching every sibling harness file]
    await Promise.all([queue.obliterate({ force: true }), dlqQueue.obliterate({ force: true })]);

    tenantId = await seedTenant(pg);
    linkId = await seedLink(pg, tenantId, HARNESS_SLUG, HARNESS_DESTINATION);
    occurredAt = pickOccurredAt();
    r2Client = createR2Client(REAL_R2_CONFIG);

    // MinIO must genuinely be healthy before the outage phase deliberately
    // stops it — a sanity check on the shared stack's own starting state,
    // not part of the property under test.
    await waitForMinioHealthy();

    const port = await getFreePort();
    spawned = await spawnWorkerExclusively(
      buildEnv({
        DATABASE_URL_WORKER: pg.url,
        REDIS_URL: redis.url,
        WORKER_PORT: String(port),
        EVENT_BATCH_SIZE: String(EVENT_BATCH_SIZE),
        EVENT_BATCH_INTERVAL_MS: String(EVENT_BATCH_INTERVAL_MS),
        // Every pushed event can be simultaneously "added but not yet
        // flushed" — nothing artificially serializes the real pipeline's
        // own draining.
        WORKER_CONCURRENCY: String(TOTAL_EVENTS),
      }),
    );
    await waitForHealth(spawned.child, port, spawned.getOutput);

    // --- The probe — built now, while MinIO is still healthy; only ever
    // CALLED once the outage begins (below). See this file's own header,
    // "THE PROBE".
    probeFlush = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      // dlqSink deliberately omitted — defaults to flush.ts's own
      // `rejectingDlqSink`, so if this probe's own generous retry budget
      // were ever somehow insufficient, it fails LOUDLY (a rejected
      // promise this file's own assertions would surface) rather than
      // silently routing to a DLQ this probe has no business reaching.
      r2RetryOptions: { maxAttempts: PROBE_R2_MAX_ATTEMPTS, initialDelayMs: PROBE_R2_INITIAL_DELAY_MS },
    });

    const corpus = loadCorpus();
    const events: CaptureEvent[] = Array.from({ length: TOTAL_EVENTS }, (_unused, index) =>
      buildCaptureEventFromCorpus(corpus[index % corpus.length]!, {
        tenantId,
        linkId,
        slug: HARNESS_SLUG,
        occurredAt,
      }),
    );
    const probeEvents: CaptureEvent[] = Array.from({ length: PROBE_EVENT_COUNT }, (_unused, index) =>
      buildCaptureEventFromCorpus(corpus[index % corpus.length]!, {
        tenantId,
        linkId,
        slug: HARNESS_SLUG,
        occurredAt,
      }),
    );
    probeEventIds = probeEvents.map((event) => event.event_id).sort();
    probeBatchId = newId();
    probeKey = eventBatchKey(probeBatchId, probeEvents[0]!.occurred_at);

    await Promise.all(events.map((event) => queue.add('capture', event)));

    // Baseline: a real, meaningful chunk lands through the healthy
    // pipeline before the outage ever begins, proving the pipeline works
    // at all before it's asked to survive an outage.
    await waitForRowCountAtLeast(pg, tenantId, LANDED_THRESHOLD_BEFORE_PAUSE, PRE_PAUSE_POLL_TIMEOUT_MS);

    // ---- Outage begins ----
    stopMinio();
    // See PAUSE_SETTLE_MS's own doc comment: absorbs any already-in-flight
    // (pre-pause) Postgres INSERT's own tail before this file declares a
    // baseline row count to hold constant against.
    await sleep(PAUSE_SETTLE_MS);
    rowCountAtPauseStart = (await fetchRowCounts(pg, tenantId)).total;

    // The probe's own flushBatch call — started now (MinIO already
    // stopped), never awaited until after recovery below.
    let probeFlushResolved = false;
    const probeFlushPromise = probeFlush(probeEvents, probeBatchId).then(() => {
      probeFlushResolved = true;
    });
    probeFlushResolvedImmediatelyAfterStart = probeFlushResolved;

    await sleep(PROBE_EARLY_CHECK_DELAY_MS);
    probeFlushStillPendingEarly = !probeFlushResolved;
    probeRowsDuringEarlyCheck = await fetchEventIdsAmong(pg, probeEventIds);

    // Continue holding for the rest of OUTAGE_HOLD_MS, polling the
    // whole-tenant row count throughout — see this file's own header,
    // point 1, for why this poll is sound (not racy) against a genuinely
    // `docker compose stop`ped MinIO.
    rowCountSamplesDuringOutage = [];
    const remainingHoldMs = OUTAGE_HOLD_MS - PROBE_EARLY_CHECK_DELAY_MS;
    const pollDeadline = Date.now() + Math.max(remainingHoldMs, 0);
    while (Date.now() < pollDeadline) {
      await sleep(ROW_COUNT_POLL_INTERVAL_MS);
      rowCountSamplesDuringOutage.push((await fetchRowCounts(pg, tenantId)).total);
    }

    probeFlushStillPendingLate = !probeFlushResolved;
    probeRowsRightBeforeRecovery = await fetchEventIdsAmong(pg, probeEventIds);

    // ---- Recovery ----
    startMinio();
    await waitForMinioHealthy();

    await withTimeout(probeFlushPromise, PROBE_FLUSH_TIMEOUT_MS, "probe's own flushBatch call");
    probeFlushResolvedAfterRecovery = probeFlushResolved;
    probeRowsAfterRecovery = await fetchEventIdsAmong(pg, probeEventIds);
    probeR2BodyAfterRecovery = await getObjectText(r2Client, REAL_R2_CONFIG.bucket, probeKey);

    jobCountsAfterRecovery = await waitForCompletedCount(queue, TOTAL_EVENTS, DRAIN_TIMEOUT_MS);

    // --- Own this file's own "eventually" for the real pipeline — see
    // this file's own header, "THE FIX", for why this step exists at all
    // and why it does not compromise the property under test.
    const strandedDlqJobs = await dlqQueue.getJobs(['waiting', 'active', 'delayed', 'paused']);
    dlqEntriesReplayedCount = strandedDlqJobs.length;
    if (strandedDlqJobs.length > 0) {
      const replayFlush = createFlushBatch({ db: pg.db, r2Client, r2Bucket: REAL_R2_CONFIG.bucket });
      for (const job of strandedDlqJobs) {
        const payload = job.data.rawPayload as CaptureEvent[];
        await replayFlush(payload, job.data.originalJobId);
      }
    }
    finalDlqDepth = await dlqQueue.getJobCountByTypes('waiting', 'active', 'delayed', 'paused');

    finalRowCounts = await fetchRowCounts(pg, tenantId);
    finalPgEventIds = await fetchEventIds(pg, tenantId);

    const prefixes = eventPrefixes(occurredAt, occurredAt);
    finalR2EventIds = await collectR2EventIds(r2Client, REAL_R2_CONFIG.bucket, prefixes, tenantId);
    r2Keys = await listR2ObjectKeys(r2Client, REAL_R2_CONFIG.bucket, prefixes);

    await stopWorkerProcess(spawned.child, spawned.getOutput);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // Defensive: only reached if an assertion/setup step above threw
    // while MinIO was still stopped — this worktree's compose stack is
    // shared with other concurrent work, and this file's own dispatch
    // brief is explicit that leaving MinIO stopped on exit is not
    // acceptable.
    try {
      startMinio();
      await waitForMinioHealthy();
    } catch {
      // Best-effort only — every other cleanup step below still runs
      // regardless.
    }

    if (spawned && spawned.child.exitCode === null && spawned.child.signalCode === null) {
      spawned.child.kill('SIGKILL');
    }

    if (r2Keys && r2Keys.length > 0) {
      await r2Client
        .send(
          new DeleteObjectsCommand({
            Bucket: REAL_R2_CONFIG.bucket,
            Delete: { Objects: r2Keys.map((Key) => ({ Key })) },
          }),
        )
        .catch(() => undefined);
    }
    r2Client?.destroy();

    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await dlqQueue.obliterate({ force: true }).catch(() => undefined);
    await dlqQueue.close();
    await pg.stop();
    await redis.stop();
  }, TEARDOWN_TIMEOUT_MS);

  it("[deterministic proof] the probe's own flushBatch call is still pending shortly after MinIO stops, with zero Postgres rows for it", () => {
    expect(probeFlushResolvedImmediatelyAfterStart).toBe(false);
    expect(probeFlushStillPendingEarly).toBe(true);
    expect(probeRowsDuringEarlyCheck).toEqual([]);
  });

  it('[the negative assertion that matters][INV-7] the whole tenant Postgres row count never advances for the entire outage hold', () => {
    // Non-vacuous: proves there was genuinely more work still queued when
    // the outage began, not merely a coincidentally-idle pipeline.
    expect(rowCountAtPauseStart).toBeGreaterThan(0);
    expect(rowCountAtPauseStart).toBeLessThan(GRAND_TOTAL_EVENTS);
    expect(rowCountSamplesDuringOutage.length).toBeGreaterThan(0);
    for (const sample of rowCountSamplesDuringOutage) {
      expect(sample).toBe(rowCountAtPauseStart);
    }
  });

  it("the probe's rows are still completely absent from Postgres right up to the moment MinIO comes back", () => {
    expect(probeFlushStillPendingLate).toBe(true);
    expect(probeRowsRightBeforeRecovery).toEqual([]);
  });

  it("[retries and eventually lands] once MinIO recovers, the probe's SAME flushBatch call resolves via its own retry loop — landing in both stores", () => {
    expect(probeFlushResolvedAfterRecovery).toBe(true);
    expect(probeRowsAfterRecovery).toEqual(probeEventIds);
    expect(countLines(probeR2BodyAfterRecovery)).toBe(PROBE_EVENT_COUNT);
  });

  it('BullMQ eventually marks every one of the real pipeline pushed jobs completed, none failed', () => {
    expect(jobCountsAfterRecovery.completed).toBe(TOTAL_EVENTS);
    expect(jobCountsAfterRecovery.failed).toBe(0);
  });

  it('the DLQ ends up empty — either nothing exhausted, or this file replayed everything it found there', () => {
    expect(finalDlqDepth).toBe(0);
    expect(dlqEntriesReplayedCount).toBeGreaterThanOrEqual(0);
  });

  it(`[no loss, no duplication] lands exactly ${GRAND_TOTAL_EVENTS} rows — count(*) = count(distinct event_id) = ${GRAND_TOTAL_EVENTS}`, () => {
    expect(finalRowCounts.total).toBe(GRAND_TOTAL_EVENTS);
    expect(finalRowCounts.distinct).toBe(GRAND_TOTAL_EVENTS);
  });

  it('[store equality after recovery][INV-7] Postgres and R2 hold exactly the same event_id set once the outage clears', () => {
    expect(finalR2EventIds.size).toBe(GRAND_TOTAL_EVENTS);
    expect([...finalPgEventIds].sort()).toEqual([...finalR2EventIds].sort());
  });
});
