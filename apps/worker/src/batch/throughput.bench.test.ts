import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Pool, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  EVENTS_DLQ_QUEUE,
  EVENTS_JOB_OPTIONS,
  EVENTS_QUEUE,
  eventBatchKey,
  links,
  newId,
  runSqlMigrations,
  user,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, startRedisContainer, type PgContainerHandle, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { AppModule } from '../app.module';
import { EventsConsumer } from '../consumer/events.consumer';
import type { BatchFlushCallback } from './accumulator';
import { createFlushBatch, type FlushBatch } from './flush';

// T3.3.6 [E3, S3.3] — "throughput benchmark for 10k events through the
// batch path." Every earlier S3.3 test proves CORRECTNESS (idempotency,
// poison-row isolation, ...) at a scale (100 events) too small to notice
// a per-event-INSERT regression sneaking back in — the destination SELECT
// and the events INSERT would still each run exactly once at that scale
// even if some future change accidentally chunked the batch into, say,
// groups of 10. This file exists to catch exactly that class of
// regression: it asserts the STATEMENT COUNT stays flat (100 batches ->
// 100 INSERTs, never 10,000) as the input scales to a real production
// order of magnitude, and puts a throughput FLOOR under the whole path so
// a future slowdown shows up as a red test here instead of as a queue
// backlog in production (this file's own task text).
//
// REAL QUEUE, NOT A DIRECT flushBatch() LOOP — unlike T3.4.7's
// reconciliation.test.ts (which deliberately calls flushBatch() directly,
// its OWN header explains why that was the correct scope for THAT task),
// this task's own dispatch brief is explicit that T3.3.6 benchmarks
// "accumulator -> enrichment -> insert" and must go "through EVENTS_QUEUE
// via BullMQ, same production ingestion path" — the accumulator's own
// count/interval race logic (T3.3.1) is itself part of what this task
// measures, not a detail to bypass. `AppModule.forRoot()` (app.module.ts)
// is the SAME production DI wiring events.consumer.test.ts already boots
// this way: a real `@Processor`/`WorkerHost` consumer, discovered via
// `BullExplorer`, feeding the real `AccumulatingEventSink` ->
// `BatchAccumulator` chain — the only override here is `flush`
// (AppModuleConfig's own documented seam, already used by
// shutdown.test.ts to substitute a controllable delay), pointed at a
// `createFlushBatch` built from clients THIS file constructs directly so
// it can spy on the underlying `pg.Pool` the same way flush.test.ts does
// and time each flush call — `buildProductionFlush`'s own internal R2/db
// construction is bypassed for that reason alone, not because the real
// production `flushBatch` composition differs in any way.
//
// EXPLICIT BatchAccumulator CONFIG OF 100, NOT THE 500 CEILING — this
// task's own dispatch brief: "'exactly 100 insert statements for 10k
// events' implies EVENT_BATCH_SIZE = 100 for THIS benchmark's own
// configuration... pick 100 explicitly, don't inherit whatever the
// default happens to be." `EVENT_BATCH_SIZE`'s real ceiling is 500
// (env.ts's Zod schema, reconciliation.test.ts's own BATCH_SIZE) — this
// file deliberately does NOT use that value, because the task's own
// verify text asks for exactly 100 statements over 10,000 events, and
// 10,000 divides evenly by 100 with zero remainder. `BATCH_INTERVAL_MS`
// is set far larger than this run could possibly take, so the COUNT
// trigger is the only thing that ever fires — a live interval trigger
// racing the count trigger could flush a partial (< 100-event) batch and
// break the "always exactly 100 events per INSERT" property this file
// exists to prove, independent of whether the total event count still
// came out right.
//
// WHERE THE CLOCK STARTS AND STOPS — deliberately the WHOLE pipeline, not
// just the flush half: the timer starts immediately before the 10,000
// jobs are pushed onto EVENTS_QUEUE and stops the instant the 100th (last)
// flush's own promise settles. That is "events/sec through the batch
// path" in the fullest sense this task's own title uses the phrase —
// BullMQ enqueue, the real consumer's dequeue/decode loop at
// WORKER_CONCURRENCY (production's own default, 8 — events.consumer.ts's
// own DEFAULT_WORKER_CONCURRENCY, left untouched here), the accumulator,
// enrichment, and — because of T3.4.6's write-coupling, commit `2f8ea40`
// — a REAL sequential R2-PUT-then-Postgres-INSERT per flush, not the
// concurrent `Promise.all` the floor was originally calibrated against.
// Measuring anything narrower (e.g. starting the clock only once the
// first job is dequeued) would flatter the number by excluding real
// pipeline latency a production backlog would still have to pay.
//
// [dispatch brief, point 5] TIMEOUTS ARE MEASURED, NOT GUESSED — the
// values below reflect an actual local run against real Postgres/MinIO/
// Redis testcontainers (see this task's own commit message / PR
// description for the measured events/sec and p95 this file's own
// beforeAll produced), with generous headroom on top, not a blind guess.
//
// [T3.5.4] BATCH_SIZE (100) MUST NOT EXCEED THE WORKER'S OWN CONCURRENCY:
// `accumulator.add()` now blocks its caller until its batch flushes
// (accumulator.ts's own T3.5.4 header), so at most `concurrency` events
// can ever be simultaneously "added but not yet flushed" — each one
// occupying a `process()` call that hasn't returned. With the default
// `WORKER_CONCURRENCY` (8), the count trigger configured for 100 could
// never fire; only the (here deliberately 10-minutes-away) interval
// trigger would, stalling this benchmark past its own timeout. `beforeAll`
// below bumps `app.get(EventsConsumer).worker.concurrency` to `BATCH_SIZE`
// right after booting — the same public setter (verified against the
// installed bullmq@5.80.10 types) shutdown.test.ts's own T3.5.4 fixture
// update uses, for the identical reason.
const BATCH_SIZE = 100;
const TOTAL_EVENTS = 10_000;
const NUM_BATCHES = TOTAL_EVENTS / BATCH_SIZE;
const BATCH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes — see header: only the count trigger may fire.
const THROUGHPUT_FLOOR_EVENTS_PER_SEC = 2000;

const CONTAINER_TEST_TIMEOUT_MS = 120_000;
// Generous, measured-then-padded — see this file's own header, point 5.
// A real local run (10,000 events through the real BullMQ consumer plus
// 100 sequential R2-PUT-then-Postgres-INSERT flushes) completed in well
// under a minute; this leaves several times that as headroom for a
// loaded CI runner or a worktree sharing Docker with concurrent sibling
// test suites, without masking a genuine hang for minutes on end.
const BENCH_SETUP_TIMEOUT_MS = 180_000;

const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

// Same local-dev-only MinIO root credentials every other flush test in
// this directory hardcodes (flush.test.ts, r2-put.test.ts,
// reconciliation.test.ts's own REAL_R2_CONFIG/REAL_CONFIG) — already in
// .env.example in plaintext, duplicated rather than imported per this
// directory's own established precedent (no shared test-fixtures module
// exists for it, and inventing one is out of this task's scope).
const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

// The internal DB_CLIENT provider AppModule.forRoot() always constructs
// (app.module.ts's own header: "constructed eagerly... regardless of
// whether anything ever actually drives it") is never queried in this
// file — `config.flush` below overrides the accumulator's flush callback
// entirely, so `buildProductionFlush` (and the `dbClient` it would have
// used) is never reached. `pg.Pool` never connects eagerly, so a
// syntactically valid but unreachable connection string is enough — same
// placeholder events.consumer.test.ts's own UNUSED_DATABASE_URL/
// UNUSED_ACCUMULATOR_CONFIG already establishes for the identical reason,
// including `dbPoolMax` needing to be set EXPLICITLY: leaving it unset
// makes createDbClient() read `process.env.DB_POOL_MAX`, unset under
// `pnpm test`, and NestFactory's default `abortOnError: true` turns that
// into a hard `process.abort()` (verified: the first run of this file
// crashed the whole worker process this way) instead of a catchable
// rejection.
const UNUSED_DATABASE_URL = 'postgresql://unused:unused@localhost:5432/unused';
const UNUSED_DB_POOL_MAX = 5;

interface QuerySpyCall {
  readonly text: string;
  readonly paramCount: number;
}

interface QuerySpy {
  readonly calls: QuerySpyCall[];
  restore(): void;
}

/** Identical mechanism to flush.test.ts's own spyOnPoolQueries — see that
 * file's own docstring for the full rationale (reassigning the INSTANCE
 * property so drizzle's own internal `this.client.query(...)` calls are
 * captured too, and why the first argument is `string | { text: string }`).
 * Duplicated, not imported: flush.test.ts does not export it, matching
 * this directory's own "small per-file test helpers, not a shared test
 * utility module" convention (buildCaptureEvent, REAL_R2_CONFIG, ... are
 * each duplicated the same way across flush.test.ts, r2-put.test.ts,
 * reconciliation.test.ts). */
function spyOnPoolQueries(pool: Pool): QuerySpy {
  const originalQuery = pool.query.bind(pool) as (
    textOrConfig: string | { text: string },
    params?: unknown[],
  ) => Promise<QueryResult>;
  const calls: QuerySpyCall[] = [];

  const spied = (textOrConfig: string | { text: string }, params?: unknown[]): Promise<QueryResult> => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    calls.push({ text, paramCount: params?.length ?? 0 });
    return originalQuery(textOrConfig, params);
  };

  pool.query = spied as unknown as Pool['query'];

  return {
    calls,
    restore() {
      pool.query = originalQuery as unknown as Pool['query'];
    },
  };
}

function insertStatements(calls: readonly QuerySpyCall[]): QuerySpyCall[] {
  return calls.filter((call) => /^\s*insert\s+into\s+"?events"?/i.test(call.text));
}

/**
 * Nearest-rank percentile over an ALREADY sorted (ascending) array — the
 * exact same formula and rationale as
 * apps/api/src/redirect/test/latency.test.ts's own `percentile()`
 * (T2.6.9): `Math.ceil(length * p) - 1`, clamped to `[0, length - 1]`.
 * Duplicated rather than imported — that file lives under apps/api, and
 * apps/worker importing from another app is exactly what CLAUDE.md's
 * dependency arrows forbid ("no app imports another app").
 */
function percentile(sortedAscendingMs: readonly number[], p: number): number {
  const index = Math.ceil(sortedAscendingMs.length * p) - 1;
  const clampedIndex = Math.min(Math.max(index, 0), sortedAscendingMs.length - 1);
  const value = sortedAscendingMs[clampedIndex];
  if (value === undefined) {
    throw new Error(`percentile: no sample at index ${clampedIndex} (length ${sortedAscendingMs.length})`);
  }
  return value;
}

function buildCaptureEvent(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: null,
    referer: null,
    accept: null,
    accept_language: null,
    sec_fetch_site: null,
    sec_fetch_mode: null,
    sec_fetch_dest: null,
    sec_fetch_user: null,
    sec_purpose: null,
    sec_ch_ua: null,
    sec_ch_ua_mobile: null,
    sec_ch_ua_platform: null,
    purpose: null,
    x_purpose: null,
    x_moz: null,
    country: null,
    asn: null,
    visitor_hash: null,
    ...overrides,
  };
}

async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

async function seedLink(
  handle: PgContainerHandle,
  tenantId: string,
  slug: string,
  destination: string,
): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({ id: linkId, tenantId, slug, destination });
  return linkId;
}

describe('percentile — proves the p95 helper actually ranks samples [T3.3.6 RED-phase proof]', () => {
  it('picks the nearest-rank value for a known 100-sample set', () => {
    const sorted = Array.from({ length: 100 }, (_unused, index) => index + 1); // 1..100
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 0.5)).toBe(50);
  });

  it('clamps to the last sample when p === 1', () => {
    expect(percentile([10, 20, 30], 1)).toBe(30);
  });
});

describe('flushBatch through the real BullMQ pipeline — 10k event throughput (T3.3.6)', () => {
  let pg: PgContainerHandle;
  let redis: RedisContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  let queue: Queue<CaptureEvent>;
  let dlqQueue: Queue;
  let app: INestApplicationContext | undefined;
  const r2CreatedKeys: string[] = [];

  let insertStatementCount: number;
  let flushDurationsMs: number[];
  let throughputEventsPerSec: number;
  let p95FlushDurationMs: number;
  let totalDurationMs: number;

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    redis = await startRedisContainer();
    r2Client = createR2Client(REAL_R2_CONFIG);

    const tenantId = await seedTenant(pg);
    const linkId = await seedLink(pg, tenantId, 'promo', 'https://Shop.Example.com/promo');

    queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
      defaultJobOptions: EVENTS_JOB_OPTIONS,
    });
    dlqQueue = new Queue(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    // [dispatch brief, point 6] This file's own Redis is a freshly booted
    // testcontainer (never shared with another test FILE), so the
    // job-id-counter collision events.consumer.test.ts's own header
    // documents cannot happen ACROSS files here — obliterating both
    // queues up front is still cheap insurance against this container
    // somehow starting non-empty, matching the dispatch brief's explicit
    // instruction regardless.
    await queue.obliterate({ force: true });
    await dlqQueue.obliterate({ force: true });

    const flushBatch: FlushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });
    const querySpy = spyOnPoolQueries(pg.pool);

    const durationsMs: number[] = [];
    let completedFlushes = 0;
    let resolveAllFlushesDone!: () => void;
    const allFlushesDone = new Promise<void>((resolve) => {
      resolveAllFlushesDone = resolve;
    });

    // The `config.flush` override this file relies on — see this file's
    // own header for why. Times the REAL flushBatch() call (R2 PUT then
    // Postgres INSERT, T3.4.6's coupled order) end to end, and tracks the
    // R2 key it wrote for cleanup — accumulator.ts's own
    // BatchFlushCallback<T> contract guarantees `events` is always
    // non-empty here (BatchAccumulator never opens/flushes an empty
    // batch), so `events[0]` is always defined.
    const timedFlush: BatchFlushCallback<CaptureEvent> = async (events, batchId) => {
      const flushStart = performance.now();
      await flushBatch(events, batchId);
      durationsMs.push(performance.now() - flushStart);
      r2CreatedKeys.push(eventBatchKey(batchId, events[0]!.occurred_at));

      completedFlushes += 1;
      if (completedFlushes === NUM_BATCHES) {
        resolveAllFlushesDone();
      }
    };

    app = await NestFactory.createApplicationContext(
      AppModule.forRoot({
        redisUrl: redis.url,
        databaseUrl: UNUSED_DATABASE_URL,
        dbPoolMax: UNUSED_DB_POOL_MAX,
        batchSize: BATCH_SIZE,
        batchIntervalMs: BATCH_INTERVAL_MS,
        shutdownTimeoutMs: 30_000,
        flush: timedFlush,
      }),
    );
    // [T3.5.4] See BATCH_SIZE's own comment above.
    app.get(EventsConsumer).worker.concurrency = BATCH_SIZE;

    const events: CaptureEvent[] = Array.from({ length: TOTAL_EVENTS }, (_unused, index) =>
      buildCaptureEvent({ tenant_id: tenantId, link_id: linkId, slug: 'promo', http_method: index % 2 === 0 ? 'GET' : 'HEAD' }),
    );
    // 'capture' — the SAME literal job name events.consumer.test.ts's own
    // `queue.add('capture', event)` calls use; EventsConsumer.process()
    // never inspects the job NAME, only `job.data` (events.consumer.ts's
    // own header), so this is not something apps/worker exports for a
    // consumer to import — apps/api's enqueue.ts owns CAPTURE_JOB_NAME
    // for its own producer side, and this file (apps/worker) cannot import
    // across apps regardless (CLAUDE.md's dependency arrows).
    const jobs = events.map((event) => ({ name: 'capture', data: event }));

    // [T3.3.6 own header] The measured window: enqueue start -> last flush
    // settled.
    const runStart = performance.now();
    await queue.addBulk(jobs);
    await allFlushesDone;
    const runEnd = performance.now();

    querySpy.restore();

    totalDurationMs = runEnd - runStart;
    throughputEventsPerSec = TOTAL_EVENTS / (totalDurationMs / 1000);
    flushDurationsMs = durationsMs;
    p95FlushDurationMs = percentile([...durationsMs].sort((a, b) => a - b), 0.95);
    insertStatementCount = insertStatements(querySpy.calls).length;

    // [dispatch brief] "report the ACTUAL measured events/sec and p95" —
    // console.log for a benchmark's own reported numbers matches
    // apps/api/src/redirect/test/latency.test.ts's own established
    // precedent (T2.6.9) for exactly this purpose, not a stray debug log.
    // eslint-disable-next-line no-console
    console.log(
      `[T3.3.6 throughput] ${TOTAL_EVENTS} events / ${totalDurationMs.toFixed(1)}ms = ` +
        `${throughputEventsPerSec.toFixed(1)} events/sec | p95 flush duration ` +
        `${p95FlushDurationMs.toFixed(1)}ms | ${insertStatementCount} INSERT statement(s) across ` +
        `${NUM_BATCHES} batches (floor: ${THROUGHPUT_FLOOR_EVENTS_PER_SEC} events/sec)`,
    );
  }, BENCH_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await dlqQueue.obliterate({ force: true }).catch(() => undefined);
    await dlqQueue.close();
    await app?.close();

    if (r2CreatedKeys.length > 0) {
      await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: REAL_R2_CONFIG.bucket,
          Delete: { Objects: r2CreatedKeys.map((key) => ({ Key: key })) },
        }),
      );
    }
    r2Client.destroy();
    await pg.stop();
    await redis.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(`accumulates all ${TOTAL_EVENTS} events into exactly ${NUM_BATCHES} flushes, every flush's own duration recorded`, () => {
    expect(flushDurationsMs).toHaveLength(NUM_BATCHES);
  });

  it(`issues exactly 100 INSERT statements for ${TOTAL_EVENTS} events — never one per event, never chunked below the configured batch size`, () => {
    expect(insertStatementCount).toBe(100);
  });

  it(`sustains at least ${THROUGHPUT_FLOOR_EVENTS_PER_SEC} events/sec through accumulator -> enrichment -> insert, R2-PUT-then-Postgres-INSERT coupled per batch (T3.4.6)`, () => {
    expect(throughputEventsPerSec).toBeGreaterThanOrEqual(THROUGHPUT_FLOOR_EVENTS_PER_SEC);
  });

  it('reports a real, finite p95 flush duration computed from all 100 per-flush samples', () => {
    expect(Number.isFinite(p95FlushDurationMs)).toBe(true);
    expect(p95FlushDurationMs).toBeGreaterThan(0);
  });
});
