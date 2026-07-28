import path from 'node:path';
import { Queue } from 'bullmq';
import type { S3Client } from '@aws-sdk/client-s3';
import { createR2Client, EVENTS_QUEUE, runSqlMigrations, type R2ClientConfig } from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
  type RedisContainerHandle,
} from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import type { WorkerHealthStatus } from '../health.controller';
import {
  buildCaptureEventFromCorpus,
  HARNESS_DESTINATION,
  HARNESS_SLUG,
  loadCorpus,
  seedLink,
  seedTenant,
} from './pipeline-harness-fixtures';
import { cleanupAll, getFreePort, sleep } from './pipeline-harness-cleanup';
import { buildWorkerExclusively, fetchHealth, spawnWorker, stopWorkerProcess, waitForHealth } from './pipeline-harness-process';

// T3.5.1 [E3, S3.5] — the shared harness this whole story's own dispatch
// brief names directly: "every test in this story reuses it rather than
// each booting its own stack." Ties together the three already-split
// modules beside this file (pipeline-harness-fixtures.ts,
// pipeline-harness-cleanup.ts, pipeline-harness-process.ts — see each
// one's own header for what it owns) into the one thing every S3.5 test
// file actually calls: `startPipelineHarness()`, returning `{ push,
// drain, stop, ... }` plus the raw Postgres/R2/tenant handles a test
// needs to make its own assertions (this file deliberately does NOT grow
// its own `countRows()`/`countR2Objects()` convenience — every existing
// precedent in this epic (sigterm-flush.test.ts, reconciliation.test.ts)
// queries Postgres/R2 directly in the TEST file, and duplicating that
// here, before a second S3.5 task exists to say what shape it actually
// wants, would be scope this task was not asked to take on).
//
// --- WHY THERE IS NO MinIO CONTAINER HERE, DESPITE THE PLAN'S OWN
// WORDING ("boots Postgres... plus Redis and MinIO containers") --------
//
// Checked every existing R2/MinIO-touching file in this exact epic
// (packages/core/src/r2/client.test.ts, T3.4.4's r2-put.test.ts, T3.4.6's
// coupled-writes.test.ts, T3.4.7's reconciliation.test.ts): NONE of them
// boot a testcontainers MinIO. Every one of them connects to the SAME
// already-running docker-compose MinIO service at a fixed
// `http://localhost:9000` (T0.4.3/T0.4.4), and the one file that needs a
// genuinely stopped MinIO (coupled-writes.test.ts) does so by shelling
// out to `docker compose stop/start minio` against that SAME persistent
// service — never by booting a second, disposable one. This task's own
// dispatch brief is explicit about the SAME constraint from the other
// direction: "Docker is already up and healthy... do not try to
// start/stop the compose stack." Both signals point the same way: MinIO
// is deliberately never testcontainers-managed anywhere in this repo.
// `startPipelineHarness()` below follows that same, consistently
// established precedent — `r2Client` addresses the real compose MinIO,
// exactly like `sigterm-flush.test.ts`'s own `REAL_R2_*` constants (this
// file's `REAL_R2_CONFIG` mirrors them byte-for-byte) — and `stop()`
// releases the three resources genuinely under THIS harness's own
// lifecycle: the Postgres testcontainer, the Redis testcontainer, and
// the worker child process. A future S3.5 task that needs a genuinely
// stopped MinIO (T3.5.7) mirrors coupled-writes.test.ts's own
// `docker compose stop/start minio` directly, the same way that task's
// own sibling already does — that is a concern for the TEST file at that
// point, not something this shared boot/push/drain/stop harness should
// take on.
//
// --- push(): ONE tenant, ONE link, cycling the T3.2.6 UA corpus --------
//
// A single seeded tenant+link (pipeline-harness-fixtures.ts's
// `seedTenant`/`seedLink`, `HARNESS_SLUG`/`HARNESS_DESTINATION`) that
// every `push()`-built event resolves its `dest_host` against, rather
// than one link per corpus entry matching the corpus's own `destination`
// field. Every existing corpus consumer (enrich.test.ts) already proves
// `destHost()` against the corpus's `input.destination` directly, with no
// database in the loop — this harness's own job is proving the PIPELINE
// (queue → consumer → accumulator → flush → Postgres/R2), not
// re-deriving `dest_host` correctness a unit test already owns. One link
// id keeps `push(n)`'s own seeding O(1) regardless of `n`, instead of
// seeding up to 40 links (the corpus's own length) for a call that might
// only ask for 10 events.
//
// --- ONE BATCH, ONE OBJECT — how push(10)+drain() actually lands
// exactly one R2 object, the way this task's own verify text requires --
//
// Every event `push()` builds shares the SAME `occurredAt` (computed once
// per harness instance, below) — the one property `eventBatchKey`
// actually keys an R2 object by (via `firstEvent.occurred_at`, flush.ts).
// `EVENT_BATCH_SIZE` defaults far above any single `push()` call this
// task exercises (500, `workerEnvSchema`'s own ceiling — the SAME value
// reconciliation.test.ts and coupled-writes.test.ts already standardize
// on for their own 10k/100-event runs), so the COUNT trigger never trips
// for a 10-event push; only the INTERVAL trigger (`EVENT_BATCH_INTERVAL_MS`,
// defaulted short — see `DEFAULT_BATCH_INTERVAL_MS` below) ever flushes
// it, exactly once. One flush, one `PutObjectCommand`, one object.
// (A future task pushing thousands of events through this SAME harness
// will trip the count trigger repeatedly instead, producing MANY objects
// under the same prefix — expected and fine; nothing about this harness
// assumes "always exactly one".)
//
// The `occurredAt` itself is a RANDOMIZED day inside a fixed 8-year
// window (2080-2087) that this task deliberately claims for itself,
// picked fresh per harness instance — mirroring reconciliation.test.ts's
// own `FIXTURE_DAY_MS` technique (T3.4.7) and its own stated reason: this
// worktree's docker-compose MinIO bucket is shared with concurrent
// sibling agents, so a genuinely private R2 key prefix is what makes an
// "exactly N objects" LISTING assertion safe to make at all. Distinct
// from every other fixture window already claimed in this codebase
// (stream-read.test.ts's 2033/2034, reconciliation.test.ts's own
// 2050-2057) so this harness's own random window can never collide with
// either.
//
// --- drain(): why last_flush_age_ms ALONE is not enough ----------------
//
// This task's own dispatch brief: drain() "waits on last_flush_age_ms
// from the health endpoint." Taken completely literally — poll until
// `last_flush_age_ms` drops back near zero — that alone is not a correct
// signal: a flush that happened for some OTHER reason (or, in a longer
// multi-push test, a PRIOR push's own flush) would satisfy it without
// this call's own events having landed anywhere yet. `drain()` below
// still polls `last_flush_age_ms` as its core signal (this is what makes
// it genuinely event-driven, not a fixed sleep — CLAUDE.md's own testing
// rules forbid asserting on a guessed delay), but combines it with two
// more health-endpoint fields the SAME response already carries, at
// no extra cost:
//   1. `last_flush_age_ms` translated into an absolute "when did the
//      last successful flush complete" instant (`Date.now() -
//      last_flush_age_ms`, computed against the TEST process's own
//      clock — same host as the worker child process, so no clock-skew
//      correction is needed) and compared against the instant THIS
//      harness's own most recent `push()` call started enqueueing. Only
//      a flush that completed AT OR AFTER that instant can possibly
//      contain this push's own events.
//   2. `queue_depth === 0` — every job this push() enqueued has been
//      picked up by the real BullMQ consumer (`EventsConsumer.process()`
//      already ran for it, `AccumulatingEventSink.handle()` already
//      called `accumulator.add()`).
//   3. `batch_size === 0` — the accumulator's own currently-open batch is
//      empty, which (combined with #2, meaning nothing NEW can arrive)
//      can only be true because a trigger already swapped it out via a
//      completed flush (accumulator.ts's own "swap before invoke"
//      design — `size()` can only return to 0 after having held
//      something by way of `triggerFlush()` detaching it).
// All three must hold simultaneously; `drain()` never returns on a
// partial match.
export interface PipelineHarnessOptions {
  /** Defaults to 500 — `workerEnvSchema`'s own hard ceiling (env.ts),
   * comfortably above any single `push()` call this task's own verify
   * text names (10), so the interval trigger — not the count trigger —
   * is what flushes a small push. */
  readonly batchSize?: number;
  /** Defaults to 1500ms — short enough to keep a small push()+drain()
   * fast, long enough that a real (if slow) Redis/Postgres round trip for
   * up to a few thousand queued jobs still lands inside the SAME batch
   * before the timer trips, on a local docker-compose stack. */
  readonly batchIntervalMs?: number;
  /** Defaults to 10s — matches sigterm-flush.test.ts's own
   * SHUTDOWN_TIMEOUT_MS, comfortably covering a real flush of up to
   * `batchSize` events against Postgres+R2 inside the worker's own
   * SIGTERM handler. */
  readonly shutdownTimeoutMs?: number;
}

export interface PipelineHarness {
  readonly pg: PgContainerHandle;
  readonly redis: RedisContainerHandle;
  readonly r2Client: S3Client;
  readonly r2Bucket: string;
  readonly tenantId: string;
  readonly linkId: string;
  readonly slug: string;
  /** The single ISO-8601 instant every `push()`-built event shares — see
   * this file's own "ONE BATCH, ONE OBJECT" section above. Exposed so a
   * test can derive the exact R2 prefix(es) it should list
   * (`eventPrefixes(occurredAt, occurredAt)`, `@posta/core`). */
  readonly occurredAt: string;
  /** The worker child process's own HTTP port — exposed so a test can
   * prove `stop()` genuinely released the worker process itself (a
   * post-`stop()` `fetchHealth(port)` call must reject: nothing is
   * listening anymore), the same way `pg`/`redis` prove their own
   * release through a post-`stop()` query/command rejecting. */
  readonly port: number;
  /** Builds `n` `CaptureEvent`s, cycling the T3.2.6 UA corpus
   * (pipeline-harness-fixtures.ts's `loadCorpus`), and enqueues every one
   * onto `EVENTS_QUEUE` via a real BullMQ `Queue` — the same
   * `{ name: 'capture', data: event }` job shape every other producer in
   * this codebase uses. Returns the exact events enqueued, so a caller
   * can assert against their own `event_id`s afterward. */
  push(n: number): Promise<readonly CaptureEvent[]>;
  /** Polls `GET /health` until every event this harness has ever pushed
   * has genuinely landed (see this file's own header for the three-part
   * signal this checks). Throws, naming the last observed health body,
   * if that never happens within the timeout. */
  drain(): Promise<void>;
  /** Releases all three resources this harness's own lifecycle owns — the
   * worker child process, the Postgres testcontainer, and the Redis
   * testcontainer (plus this harness's own BullMQ producer connection) —
   * via `cleanupAll()`, so a failure releasing one can never leak
   * another. */
  stop(): Promise<void>;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_BATCH_INTERVAL_MS = 1_500;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
// Sequential queries from a single test file, no horizontal-scaling
// concern — same value sigterm-flush.test.ts's own TEST_DB_POOL_MAX uses.
const TEST_DB_POOL_MAX = 5;

const DRAIN_POLL_INTERVAL_MS = 200;
// Generous: comfortably above DEFAULT_BATCH_INTERVAL_MS plus real
// wall-clock room for a genuinely large push (thousands of events) to be
// consumed and flushed across possibly many batches.
const DRAIN_TIMEOUT_MS = 60_000;

const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

// Same local-dev-only MinIO root credentials as sigterm-flush.test.ts's
// own REAL_R2_* constants (already in .env.example, not a real secret) —
// see this file's own header for why this points at the real,
// already-running compose MinIO rather than a testcontainers one.
const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};
// Schema-validated (workerEnvSchema) but never actually consumed on the
// local-MinIO-endpoint-override path (r2/client.ts's own header) — any
// non-empty value satisfies it.
const R2_ACCOUNT_ID = 'test-account-id';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
// See this file's own "ONE BATCH, ONE OBJECT" header section for why
// this window (2080-2087) and not any other.
const FIXTURE_BASE_YEAR = 2080;
const FIXTURE_RANGE_DAYS = 2920;
const FIXTURE_HOUR_UTC = 12;

function pickHarnessOccurredAt(): string {
  const dayMs = Date.UTC(FIXTURE_BASE_YEAR, 0, 1) + Math.floor(Math.random() * FIXTURE_RANGE_DAYS) * ONE_DAY_MS;
  return new Date(dayMs + FIXTURE_HOUR_UTC * ONE_HOUR_MS).toISOString();
}

/**
 * Boots a fresh Postgres + Redis testcontainers pair, seeds one
 * tenant/link, builds and spawns the real compiled worker
 * (`apps/worker/dist/main.js`) against them and the real compose MinIO,
 * and returns a handle exposing `push`/`drain`/`stop` plus the raw
 * resource handles a test needs for its own assertions. See this file's
 * own header for the full design rationale.
 */
export async function startPipelineHarness(options: PipelineHarnessOptions = {}): Promise<PipelineHarness> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  await buildWorkerExclusively();

  const [redis, pg] = await Promise.all([startRedisContainer(), startPgContainer()]);
  await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

  const tenantId = await seedTenant(pg);
  const linkId = await seedLink(pg, tenantId, HARNESS_SLUG, HARNESS_DESTINATION);
  const occurredAt = pickHarnessOccurredAt();

  const queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
    connection: { url: redis.url, maxRetriesPerRequest: null },
  });
  // [test-isolation discipline] Belt-and-suspenders even against this
  // harness's own FRESH testcontainers Redis — same reasoning
  // sigterm-flush.test.ts's own header gives for the identical call.
  await queue.obliterate({ force: true });

  const r2Client = createR2Client(REAL_R2_CONFIG);

  const port = await getFreePort();
  const spawned = spawnWorker({
    ...process.env,
    DATABASE_URL_WORKER: pg.url,
    DB_POOL_MAX: String(TEST_DB_POOL_MAX),
    REDIS_URL: redis.url,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: REAL_R2_CONFIG.accessKeyId,
    R2_SECRET_ACCESS_KEY: REAL_R2_CONFIG.secretAccessKey,
    R2_BUCKET_EVENTS: REAL_R2_CONFIG.bucket,
    R2_ENDPOINT: REAL_R2_CONFIG.endpoint,
    WORKER_PORT: String(port),
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    EVENT_BATCH_SIZE: String(batchSize),
    EVENT_BATCH_INTERVAL_MS: String(batchIntervalMs),
    SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
  });

  await waitForHealth(spawned.child, port, spawned.getOutput);

  // Set on every push() below — drain() reads it to know which flush(es)
  // could possibly contain the events THIS push produced. Initialized to
  // harness-boot time so a drain() called with no push() beforehand
  // (unusual, but not this file's job to forbid) waits for a flush after
  // boot rather than treating the accumulator's own construction-time
  // `lastFlushAt` as already satisfying it.
  let lastPushStartedAtMs = Date.now();

  async function push(n: number): Promise<readonly CaptureEvent[]> {
    const corpus = loadCorpus();
    const events: CaptureEvent[] = Array.from({ length: n }, (_unused, index) =>
      buildCaptureEventFromCorpus(corpus[index % corpus.length]!, {
        tenantId,
        linkId,
        slug: HARNESS_SLUG,
        occurredAt,
      }),
    );

    lastPushStartedAtMs = Date.now();
    // 'capture' — CAPTURE_JOB_NAME's own literal value
    // (apps/api/src/redirect/enqueue.ts) can't be imported here: apps/worker
    // never imports apps/api (CLAUDE.md's one-way dependency arrows), so
    // this literal is duplicated intentionally, the SAME way
    // sigterm-flush.test.ts's own `eventsQueue.add('capture', event)`
    // already does.
    await Promise.all(events.map((event) => queue.add('capture', event)));

    return events;
  }

  async function drain(): Promise<void> {
    const sinceMs = lastPushStartedAtMs;
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    let lastHealth: WorkerHealthStatus | undefined;

    while (Date.now() < deadline) {
      lastHealth = await fetchHealth(port);
      const lastFlushAtMs = Date.now() - lastHealth.last_flush_age_ms;
      const flushedSincePush = lastFlushAtMs >= sinceMs;
      const queueEmpty = lastHealth.queue_depth === 0;
      const accumulatorEmpty = lastHealth.batch_size === 0;

      if (flushedSincePush && queueEmpty && accumulatorEmpty) {
        return;
      }

      await sleep(DRAIN_POLL_INTERVAL_MS);
    }

    throw new Error(
      `pipeline-harness: drain() did not observe a flush covering the last push() within ` +
        `${DRAIN_TIMEOUT_MS}ms — last health: ${JSON.stringify(lastHealth)}`,
    );
  }

  async function stop(): Promise<void> {
    await cleanupAll('pipeline harness', [
      { label: 'worker child process', run: () => stopWorkerProcess(spawned.child, spawned.getOutput) },
      { label: 'events queue (BullMQ producer)', run: () => queue.close() },
      { label: 'Postgres testcontainer', run: () => pg.stop() },
      { label: 'Redis testcontainer', run: () => redis.stop() },
    ]);
  }

  return {
    pg,
    redis,
    r2Client,
    r2Bucket: REAL_R2_CONFIG.bucket,
    tenantId,
    linkId,
    slug: HARNESS_SLUG,
    occurredAt,
    port,
    push,
    drain,
    stop,
  };
}
