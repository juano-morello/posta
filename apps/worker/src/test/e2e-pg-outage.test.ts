import path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createR2Client,
  enrich,
  eventBatchKey,
  EVENTS_QUEUE,
  eventPrefixes,
  insertEventsBatch,
  newId,
  resolveDestinationsByLinkIds,
  runSqlMigrations,
  serializeBatch,
  streamEventLog,
  type LoggedEvent,
  type R2ClientConfig,
} from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
  type RedisContainerHandle,
} from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { toNewEventRow } from '../batch/flush';
import { FLUSH_STALE_MULTIPLIER, type WorkerHealthStatus } from '../health.controller';
import { buildCaptureEventFromCorpus, HARNESS_DESTINATION, HARNESS_SLUG, loadCorpus, seedLink, seedTenant } from './pipeline-harness-fixtures';
import { getFreePort, sleep } from './pipeline-harness-cleanup';
import { buildWorkerExclusively, fetchHealth, spawnWorkerExclusively, stopWorkerProcess, waitForHealth } from './pipeline-harness-process';

// T3.5.6 [E3, S3.5] — the plan's own literal scenario: pause the REAL
// Postgres container mid-drain, hold it down past several flush intervals,
// restore it, and assert every pushed event eventually lands exactly once
// in both stores, with zero DLQ entries.
//
// --- `docker pause`/`unpause`, NOT stop/start — and why the container id
// has to be found by hand ------------------------------------------------
//
// "Pauses the Postgres container" (this task's own dispatch brief, and the
// plan's own wording) is read literally: `docker pause` freezes every
// process in the container via the cgroup freezer without severing
// established TCP connections or losing any data — a genuine "the box
// stopped responding" outage, not a "the box was destroyed and rebuilt"
// one, which is what `container.stop()`/coupled-writes.test.ts's own
// `docker compose stop minio` technique would model instead. Checked
// testcontainers@12.0.4's own shipped `.d.ts`
// (node_modules/.pnpm/testcontainers@12.0.4/.../test-container.d.ts) before
// assuming any of this: `StartedTestContainer` exposes only `stop()`/
// `restart()` — no `pause()`/`unpause()` anywhere in its public surface,
// and `packages/core/src/test/pg-container.ts`'s own `PgContainerHandle`
// (this story's shared testcontainers harness) exposes only `{ db, pool,
// url, stop }`, not the container id or object underneath. Both are
// genuine gaps against a literal "pause" reading, and this task's own
// dispatch brief is explicit that this file's own list is test-only —
// extending `PgContainerHandle` to carry a container id (or a
// pause()/unpause() method) is a shared-module change this ONE new test
// file has no standing to make unilaterally. The workaround below stays
// entirely inside this file: `pg.url` already carries the host port
// testcontainers published (`getConnectionUri()`), and every
// testcontainers-booted container carries the `org.testcontainers=true`
// label (verified against testcontainers' own build/utils/labels.js) —
// `findPgContainerId()` below lists every container carrying that label
// and `docker inspect`s each one's own `5432/tcp` port mapping until it
// finds the one matching `pg.url`'s port, then shells out to the plain
// `docker pause`/`docker unpause` CLI (mirroring coupled-writes.test.ts's
// own `runDocker` precedent for controlling a container's lifecycle from a
// vitest file — the closest established precedent in this codebase,
// generalized from `docker compose stop/start` on the shared MinIO service
// to `docker pause`/`unpause` on THIS test's own dedicated testcontainer).
//
// --- WHAT "outage" ACTUALLY DOES TO AN IN-FLIGHT QUERY — verified, not
// assumed ------------------------------------------------------------------
//
// `packages/core/src/db/client.ts`'s `createDbClient` sets no
// `statement_timeout`/`connectionTimeoutMillis`/`query_timeout` anywhere —
// confirmed by reading the file. Verified empirically (a standalone probe
// script against a real, `docker pause`d Postgres 16 container, both for a
// query issued on an ALREADY-established connection and for a fresh `Pool`
// with zero prior connections): a query issued against a paused Postgres
// never rejects, at any point — it simply never receives a response until
// the container is unpaused, at which point the SAME pending query
// resolves normally, with no error, no retry, and no new connection
// attempt. This matters for what "retries" in this task's own title
// actually means against this codebase's real behavior: there is no
// BullMQ-level retry/redelivery involved anywhere in this file's own
// scenario (unlike e2e-kill-recovery.test.ts's SIGKILL case) — nothing
// ever REJECTS, so `sink.handle()` never throws, the BullMQ job driving it
// never fails, and its lock keeps renewing normally throughout (the
// worker's own event loop is never blocked — it is only ever waiting on a
// pending socket read). The job simply stays `active` for the outage's
// entire duration and then completes once its own already-in-flight query
// finally returns. "Retries" here is the SAME already-in-flight operation
// eventually succeeding once the outage lifts, not a second attempt of a
// failed one — a materially different (and, empirically, simpler)
// mechanism than T3.5.4's SIGKILL-redelivery path, and this file's own
// assertions are written to match what actually happens rather than to
// assume BullMQ attempts/backoff are involved.
//
// --- THE "PROBE": A DETERMINISTIC DIVERGENCE PROOF, NOT A TIMING RACE ---
//
// An earlier version of this file tried to catch the real worker mid-batch
// by polling Postgres for a row-count threshold, pausing as soon as it
// crossed, and diffing that snapshot against an R2 listing taken right
// after `docker pause` returned. That measurement is fundamentally racy —
// `docker pause`'s own CLI round trip (spawning a new process, an IPC hop
// to the docker daemon) took ~30-100ms in practice, and this pipeline
// drains a 30-event batch (one Postgres SELECT, one R2 PUT, one Postgres
// INSERT, all against localhost) comfortably faster than that. A batch
// that was genuinely still mid-flight at the instant the Postgres snapshot
// was taken could — and empirically did, observed directly by instrumenting
// this file during development — finish BOTH its Postgres write and its R2
// write inside that gap, before the freeze actually took hold. That batch
// then shows up as "in R2 but not in the stale Postgres snapshot" even
// though Postgres genuinely already had it a few milliseconds later — a
// false positive indistinguishable, from a snapshot diff alone, from a
// genuine mid-outage divergence. Proven directly: sabotaging `flushBatch`
// to run the Postgres INSERT BEFORE the R2 PUT (which makes true
// R2-ahead-of-Postgres divergence structurally impossible — Postgres would
// have to be reachable for a batch to ever reach its own R2 write) still
// produced a non-empty "divergent" set under that snapshot-diff design,
// for exactly this reason.
//
// This file instead proves the property directly, with no timing
// dependency at all. A small, separate "probe" batch (`PROBE_EVENT_COUNT`
// events, its own `batchId`/R2 key, never touched by the real worker
// process or BullMQ) is composed by THIS FILE using the exact same
// public, already-exported building blocks `flushBatch` itself uses
// (`resolveDestinationsByLinkIds`, `enrich`, `toNewEventRow` — the last one
// exported from flush.ts itself since T3.6.3) — never reaching into any
// unexported internals. Sequencing is then explicit, not raced:
//   1. Resolve the probe's destination and build its rows WHILE Postgres
//      is still healthy (mirrors flushBatch's own first step).
//   2. Pause Postgres.
//   3. PUT the probe's NDJSON object to R2 directly, and read it back —
//      R2/MinIO is never paused, so this always succeeds regardless of
//      Postgres's state, exactly as `flushBatch`'s own R2-before-Postgres
//      step (T3.4.6) would behave for a batch caught at this point.
//   4. Start (never await yet) `insertEventsBatch` for the SAME probe
//      rows, tracking its settlement with a plain boolean flag rather than
//      inferring it from a query — a query against the now-paused
//      Postgres would itself just hang.
//   5. Hold the outage (`OUTAGE_HOLD_MS`) and assert the flag is STILL
//      false — the probe's own Postgres write has been genuinely pending,
//      unable to complete, for the entire hold.
//   6. Unpause, await the SAME pending call (bounded by `withTimeout`), and
//      query Postgres for the probe's own rows — they exist now, for the
//      first time, with the exact event_ids R2 already held minutes
//      earlier.
// Every step's ordering is under this file's own control — there is no
// "did we react fast enough" question anywhere in it, and RESULT is a
// literal instance of "the R2 object was written during the outage; the
// row it corresponds to is the one that shows up once Postgres recovers"
// — this task's own dispatch brief, made concrete.
//
// The REAL worker/BullMQ pipeline (`TOTAL_EVENTS`, pushed through the
// actual queue and consumer) still runs the SAME outage concurrently and
// is what the "no loss, no duplication, zero DLQ, store equality" checks
// below are about — the probe exists ONLY to prove the divergence
// mechanism itself precisely; it is not a substitute for exercising the
// real pipeline at volume.
//
// --- RED-PHASE PROOF ACTUALLY PERFORMED (not merely planned) -----------
//
// This file's own files-list is test-only. Two separate rounds were
// performed against two separate pieces of logic — round 1 is what
// actually surfaced the snapshot-diff design flaw described above and
// forced the probe-based redesign; round 2 verifies the redesign itself.
//
// Round 1 (against the ORIGINAL, since-abandoned snapshot-diff design):
// `flush.ts`'s `createFlushBatch` was temporarily edited to run the
// Postgres INSERT BEFORE the R2 PUT, `@posta/worker` was rebuilt, and the
// suite was run. Expected a clean failure; instead got a non-empty
// "divergent" set (`divergentIds.length = 30`, exactly one full batch),
// because that design was measuring snapshot staleness (a batch racing to
// finish in the gap between the pre-pause Postgres snapshot and `docker
// pause` actually taking hold — measured directly at ~30-100ms, comfortably
// longer than one local batch's own SELECT+PUT+INSERT round trip) rather
// than true ordering. This finding is WHY the snapshot-diff approach was
// discarded in favor of the deterministic probe: a real ordering bug should
// make the property structurally impossible to observe, not just harder to
// catch, and the snapshot diff could not tell the two apart.
//
// Round 2 (against the deterministic PROBE actually committed here): the
// probe reimplements flushBatch's own steps using the same exported
// building blocks (see "THE PROBE" above) rather than calling flushBatch
// itself, so a `flush.ts` sabotage cannot reach it — the regression that
// matters for the probe's OWN correctness is getting ITS sequencing wrong.
// This file's own two Postgres/R2 steps were temporarily reordered
// (`insertEventsBatch` awaited BEFORE the R2 PUT, while Postgres is already
// paused), and `hookTimeout`/`SETUP_TIMEOUT_MS` were temporarily lowered to
// 45s purely to observe the failure quickly rather than waiting out the
// real 900s. Result: a genuine, unambiguous failure — `beforeAll` itself
// times out ("Hook timed out in 45000ms"), because the reordered
// `insertEventsBatch` call blocks on the paused Postgres before this file's
// own `unpauseContainer()` call (later in the SAME function) is ever
// reached — a real deadlock, not a timing artifact, and not an import/
// module error. The dedicated Postgres testcontainer was left paused when
// the hook aborted; testcontainers' own Ryuk reaper cleaned it up once the
// process exited (confirmed via `docker ps -a` afterward: no paused
// containers, the shared compose stack untouched). All three changes
// (the reorder, both timeout overrides) were then reverted to what is
// committed here, `@posta/worker` rebuilt again, after which every
// assertion below passes, repeatably, at the real timeouts.
//
// --- ISOLATION -----------------------------------------------------------
//
// One dedicated tenant+link, this file's own freshly booted Postgres/Redis
// testcontainers pair (never the shared compose stack — only the R2/MinIO
// side uses the real compose service, matching every sibling S3.5 file's
// own established reasoning, pipeline-harness.ts's header), and a private
// randomized-day fixture window (2130-2137) distinct from every other
// window already claimed in this codebase (pipeline-harness.ts's own
// 2080-2087, reconciliation.test.ts's 2050-2057, replay.test.ts's
// 2090-2127, stream-read.test.ts's 2033/2034) — every Postgres query below
// scopes by `tenantId`, and the R2 listing scopes by this file's own hour
// prefix, so nothing here depends on being the only test touching either
// store.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 900_000 });

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

const TOTAL_EVENTS = 300;
const EVENT_BATCH_SIZE = 30;
const EVENT_BATCH_INTERVAL_MS = 5_000;
// The probe's own tiny batch — see this file's own header, "THE PROBE".
const PROBE_EVENT_COUNT = 5;
// Every Postgres query scoped by `tenantId` alone (row counts, event_id
// sets) sees BOTH the real pipeline's rows and the probe's own — this is
// the total this file's own "no loss" checks expect.
const GRAND_TOTAL_EVENTS = TOTAL_EVENTS + PROBE_EVENT_COUNT;

// Two full batches' worth — enough real Postgres activity to prove the
// baseline pipeline genuinely works before the outage begins, small enough
// relative to TOTAL_EVENTS that most of the push is still queued (and
// therefore still exercised by a real, held-down outage) when the pause
// lands.
const LANDED_THRESHOLD_BEFORE_PAUSE = EVENT_BATCH_SIZE * 2;
const PRE_PAUSE_POLL_INTERVAL_MS = 25;
const PRE_PAUSE_POLL_TIMEOUT_MS = 60_000;

// Comfortably past health.controller.ts's own FLUSH_STALE_MULTIPLIER (3)
// threshold, so /health has unambiguously flipped to 'unhealthy' by the
// time this file reads it mid-outage — the plan's own "holds it down past
// several flush intervals" wording, made concrete against a signal this
// codebase already computes rather than this file inventing a new one.
const OUTAGE_HOLD_MS = FLUSH_STALE_MULTIPLIER * EVENT_BATCH_INTERVAL_MS + 5_000;

const DRAIN_POLL_INTERVAL_MS = 500;
const DRAIN_TIMEOUT_MS = 120_000;
const PROBE_INSERT_TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 900_000;
const TEARDOWN_TIMEOUT_MS = 120_000;
const DOCKER_TIMEOUT_MS = 30_000;

const FIXTURE_BASE_YEAR = 2130;
const FIXTURE_RANGE_DAYS = 2920;
const FIXTURE_HOUR_UTC = 12;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Mirrors pipeline-harness.ts's own `pickHarnessOccurredAt` (not
 * exported, and this file has no shared-module standing to change that) —
 * a randomized day inside this file's own claimed 2130-2137 window, picked
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

/** Runs a `docker` subcommand and throws with full context on any non-zero
 * exit, a timeout kill, or a spawn failure — mirrors coupled-writes.test.ts's
 * own `runDocker` (this codebase's established precedent for controlling a
 * real container's lifecycle from a vitest file). */
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

/** The host port `startPgContainer()` published, read back off `pg.url`
 * (a `postgresql://...@localhost:PORT/...` connection string,
 * `container.getConnectionUri()`) — see this file's own header for why
 * this indirection is necessary at all. */
function extractHostPort(connectionUri: string): string {
  return new URL(connectionUri).port;
}

/** Finds the real docker container id backing THIS test's own testcontainers
 * Postgres by listing every `org.testcontainers=true`-labeled container
 * (testcontainers' own convention, verified against its `labels.js`) and
 * `docker inspect`-ing each one's `5432/tcp` port mapping until one matches
 * `hostPort` — see this file's own header for why `PgContainerHandle` alone
 * doesn't already expose this. A candidate that disappears between listing
 * and inspecting (a concurrent sibling suite's own container being torn
 * down) is skipped rather than treated as fatal. */
function findPgContainerId(hostPort: string): string {
  const listing = runDocker(['ps', '-a', '--filter', 'label=org.testcontainers=true', '--format', '{{.ID}}']);
  const candidateIds = listing.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

  for (const id of candidateIds) {
    let mappedPort: string;
    try {
      mappedPort = runDocker([
        'inspect',
        '--format',
        '{{ with index .NetworkSettings.Ports "5432/tcp" }}{{ (index . 0).HostPort }}{{ end }}',
        id,
      ]);
    } catch {
      continue;
    }
    if (mappedPort === hostPort) return id;
  }

  throw new Error(
    `findPgContainerId: no org.testcontainers=true container publishes host port ${hostPort} ` +
      `(checked ${candidateIds.length} candidate(s))`,
  );
}

function containerStatus(id: string): string {
  return runDocker(['inspect', '--format', '{{.State.Status}}', id]);
}

function pauseContainer(id: string): void {
  runDocker(['pause', id]);
}

function unpauseContainer(id: string): void {
  runDocker(['unpause', id]);
}

/** Polls `SELECT COUNT(*) FROM events WHERE tenant_id = $1` (this file's
 * OWN separate `pg.pool` connection — never the worker's own) until at
 * least `threshold` rows exist — proves the real pipeline is genuinely
 * mid-drain (not merely queued) before the outage begins. */
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
 * `target` — mirrors e2e-kill-recovery.test.ts's own identically-named
 * helper and the same reasoning: `EventsConsumer.process()` only resolves
 * (and BullMQ only marks a job `'completed'`) once `sink.handle()` —
 * `accumulator.add()` under the hood — has resolved, which only happens
 * once that event's batch has actually flushed to Postgres AND R2. Scoped
 * to the real pipeline's own `TOTAL_EVENTS` jobs — the probe never goes
 * through BullMQ at all (see this file's own header). */
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
 * keeping only records for `tenantId` — mirrors e2e-exactly-once.test.ts's
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

/** Awaits `promise`, throwing a clearly-labeled error if it does not settle
 * within `timeoutMs` — used only for the probe's own `insertEventsBatch`
 * call after recovery, so a genuine regression fails loudly rather than
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

describe('a Postgres outage mid-drain blocks in flight, then lands every event exactly once with no loss (T3.5.6)', () => {
  let redis: RedisContainerHandle;
  let pg: PgContainerHandle;
  let containerId: string;
  let queue: Queue<CaptureEvent>;
  let r2Client: S3Client;
  let tenantId: string;
  let linkId: string;
  let occurredAt: string;
  let spawned: { child: ChildProcess; getOutput: () => string };

  // The probe — see this file's own header, "THE PROBE".
  let probeEventIds: string[];
  let probeReadBackDuringOutage: string;
  let probeInsertResolvedImmediatelyAfterR2Write: boolean;
  let probeInsertStillPendingAfterHold: boolean;
  let probeInsertResolvedAfterRecovery: boolean;
  let probeLandedIds: string[];

  let healthDuringOutage: WorkerHealthStatus;
  let jobCountsAfterRecovery: JobCounts;
  let finalHealth: WorkerHealthStatus;
  let finalRowCounts: RowCounts;
  let finalPgEventIds: Set<string>;
  let finalR2EventIds: Set<string>;
  let r2Keys: string[];

  beforeAll(async () => {
    await buildWorkerExclusively();

    [redis, pg] = await Promise.all([startRedisContainer(), startPgContainer()]);
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    containerId = findPgContainerId(extractHostPort(pg.url));

    queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    // [test-isolation discipline, matching every sibling harness file]
    await queue.obliterate({ force: true });

    tenantId = await seedTenant(pg);
    linkId = await seedLink(pg, tenantId, HARNESS_SLUG, HARNESS_DESTINATION);
    occurredAt = pickOccurredAt();
    r2Client = createR2Client(REAL_R2_CONFIG);

    const port = await getFreePort();
    spawned = await spawnWorkerExclusively(
      buildEnv({
        DATABASE_URL_WORKER: pg.url,
        REDIS_URL: redis.url,
        WORKER_PORT: String(port),
        EVENT_BATCH_SIZE: String(EVENT_BATCH_SIZE),
        EVENT_BATCH_INTERVAL_MS: String(EVENT_BATCH_INTERVAL_MS),
        // Every pushed event can be simultaneously "added but not yet
        // flushed" (accumulator.ts's own T3.5.4 contract) — nothing
        // artificially serializes the real pipeline's own draining.
        WORKER_CONCURRENCY: String(TOTAL_EVENTS),
      }),
    );
    await waitForHealth(spawned.child, port, spawned.getOutput);

    const corpus = loadCorpus();
    const events: CaptureEvent[] = Array.from({ length: TOTAL_EVENTS }, (_unused, index) =>
      buildCaptureEventFromCorpus(corpus[index % corpus.length]!, {
        tenantId,
        linkId,
        slug: HARNESS_SLUG,
        occurredAt,
      }),
    );

    // --- Prepare the deterministic probe WHILE Postgres is still healthy
    // — mirrors flushBatch's own first step (resolveDestinationsByLinkIds)
    // exactly, see this file's own header.
    const probeEvents: CaptureEvent[] = Array.from({ length: PROBE_EVENT_COUNT }, (_unused, index) =>
      buildCaptureEventFromCorpus(corpus[index % corpus.length]!, {
        tenantId,
        linkId,
        slug: HARNESS_SLUG,
        occurredAt,
      }),
    );
    probeEventIds = probeEvents.map((event) => event.event_id).sort();

    const probeDestinations = await resolveDestinationsByLinkIds(pg.db, [linkId]);
    const probeLookup = probeDestinations.get(linkId);
    if (probeLookup === undefined || probeLookup.tenantId !== tenantId) {
      throw new Error('probe destination resolution failed unexpectedly — seedLink()/seedTenant() mismatch');
    }
    const probeLoggedEvents: LoggedEvent[] = probeEvents.map((event) => ({
      ...event,
      ...enrich({ user_agent: event.user_agent, referer: event.referer, destination: probeLookup.destination }),
    }));
    const probeRows = probeLoggedEvents.map(toNewEventRow);
    const probeBatchId = newId();
    const probeKey = eventBatchKey(probeBatchId, occurredAt);

    await Promise.all(events.map((event) => queue.add('capture', event)));

    // Baseline: a real, meaningful chunk lands through the healthy
    // pipeline before the outage ever begins, proving the pipeline works
    // at all before it's asked to survive an outage.
    await waitForRowCountAtLeast(pg, tenantId, LANDED_THRESHOLD_BEFORE_PAUSE, PRE_PAUSE_POLL_TIMEOUT_MS);

    // ---- Outage begins ----
    pauseContainer(containerId);

    // The probe's own R2 write — unaffected by the paused Postgres, exactly
    // as flushBatch's own R2-before-Postgres step (T3.4.6) would behave for
    // a real batch caught at this point.
    await r2Client.send(
      new PutObjectCommand({
        Bucket: REAL_R2_CONFIG.bucket,
        Key: probeKey,
        Body: Buffer.from(serializeBatch(probeLoggedEvents), 'utf-8'),
        ContentType: 'application/x-ndjson',
      }),
    );
    const probeGetResult = await r2Client.send(
      new GetObjectCommand({ Bucket: REAL_R2_CONFIG.bucket, Key: probeKey }),
    );
    probeReadBackDuringOutage = (await probeGetResult.Body?.transformToString('utf-8')) ?? '';

    // The probe's own Postgres write — started now (Postgres already
    // paused), tracked via a plain flag rather than a query, since a query
    // against the paused Postgres would itself just hang.
    let probeInsertResolved = false;
    const probeInsertPromise = insertEventsBatch(pg.db, probeRows).then(() => {
      probeInsertResolved = true;
    });
    probeInsertResolvedImmediatelyAfterR2Write = probeInsertResolved;

    // Hold past FLUSH_STALE_MULTIPLIER flush intervals — the plan's own
    // "holds it down past several flush intervals", made concrete against
    // health.controller.ts's own staleness threshold.
    await sleep(OUTAGE_HOLD_MS);
    probeInsertStillPendingAfterHold = !probeInsertResolved;
    healthDuringOutage = await fetchHealth(port);

    // ---- Recovery ----
    unpauseContainer(containerId);

    await withTimeout(probeInsertPromise, PROBE_INSERT_TIMEOUT_MS, "probe's own insertEventsBatch call");
    probeInsertResolvedAfterRecovery = probeInsertResolved;

    const probeLandedResult = await pg.pool.query<{ event_id: string }>(
      'SELECT event_id FROM events WHERE event_id = ANY($1::text[])',
      [probeEventIds],
    );
    probeLandedIds = probeLandedResult.rows.map((row) => row.event_id).sort();

    jobCountsAfterRecovery = await waitForCompletedCount(queue, TOTAL_EVENTS, DRAIN_TIMEOUT_MS);
    finalHealth = await fetchHealth(port);
    finalRowCounts = await fetchRowCounts(pg, tenantId);
    finalPgEventIds = await fetchEventIds(pg, tenantId);

    const prefixes = eventPrefixes(occurredAt, occurredAt);
    finalR2EventIds = await collectR2EventIds(r2Client, REAL_R2_CONFIG.bucket, prefixes, tenantId);
    r2Keys = await listR2ObjectKeys(r2Client, REAL_R2_CONFIG.bucket, prefixes);

    await stopWorkerProcess(spawned.child, spawned.getOutput);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // Defensive: only reached if an assertion/setup step above threw while
    // Postgres was still paused — this worktree's own dedicated
    // testcontainer, but left paused it would otherwise leak past this
    // file's own teardown.
    if (containerId) {
      try {
        if (containerStatus(containerId) === 'paused') unpauseContainer(containerId);
      } catch {
        // Best-effort only — pg.stop() below still runs regardless.
      }
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
    await pg.stop();
    await redis.stop();
  }, TEARDOWN_TIMEOUT_MS);

  it("[deterministic divergence proof] the probe's R2 object is durably written and readable during the outage, exactly PROBE_EVENT_COUNT records", () => {
    const lines = probeReadBackDuringOutage.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(PROBE_EVENT_COUNT);
  });

  it("[core mechanism] the probe's own Postgres row stays pending for the entire outage — genuinely unavailable, not merely slow", () => {
    expect(probeInsertResolvedImmediatelyAfterR2Write).toBe(false);
    expect(probeInsertStillPendingAfterHold).toBe(true);
  });

  it('once Postgres recovers, the probe row lands with exactly the event_ids R2 already held during the outage', () => {
    expect(probeInsertResolvedAfterRecovery).toBe(true);
    expect(probeLandedIds).toEqual(probeEventIds);
  });

  it('/health reports unhealthy while genuinely stuck mid-outage, past FLUSH_STALE_MULTIPLIER flush intervals — stuck, not crashed', () => {
    expect(healthDuringOutage.status).toBe('unhealthy');
    expect(healthDuringOutage.last_flush_age_ms).toBeGreaterThan(FLUSH_STALE_MULTIPLIER * EVENT_BATCH_INTERVAL_MS);
    expect(healthDuringOutage.dlq_depth).toBe(0);
  });

  it('BullMQ eventually marks every pushed job completed once Postgres recovers, none failed', () => {
    expect(jobCountsAfterRecovery.completed).toBe(TOTAL_EVENTS);
    expect(jobCountsAfterRecovery.failed).toBe(0);
  });

  it(`[no loss, no duplication] lands exactly ${GRAND_TOTAL_EVENTS} rows — count(*) = count(distinct event_id) = ${GRAND_TOTAL_EVENTS}`, () => {
    expect(finalRowCounts.total).toBe(GRAND_TOTAL_EVENTS);
    expect(finalRowCounts.distinct).toBe(GRAND_TOTAL_EVENTS);
  });

  it('routes nothing to the dead-letter queue', () => {
    expect(finalHealth.dlq_depth).toBe(0);
  });

  it('[store equality after recovery][INV-7] Postgres and R2 hold exactly the same event_id set once the outage clears', () => {
    expect(finalR2EventIds.size).toBe(GRAND_TOTAL_EVENTS);
    expect([...finalPgEventIds].sort()).toEqual([...finalR2EventIds].sort());
  });
});
