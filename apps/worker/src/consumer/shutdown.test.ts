import 'reflect-metadata';
import path from 'node:path';
import { Queue } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { EVENTS_QUEUE, newId, runSqlMigrations } from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
  type RedisContainerHandle,
} from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../app.module';
import { BATCH_ACCUMULATOR, EventsConsumer } from './events.consumer';
import type { BatchAccumulator } from '../batch/accumulator';

// T3.1.6 [E3, S3.1] — the plan's own literal verify command for this
// task: "fills a partial batch of 30, triggers onModuleDestroy, and
// asserts all 30 rows are in Postgres before the promise resolves"
// (docs/plan/03-event-pipeline.md). This is the ONE test in this epic
// that needs BOTH a real testcontainers Redis (to drive the real BullMQ
// consumer, same discipline as dlq.service.test.ts/
// events.consumer.test.ts/malformed-job.test.ts) AND a real
// testcontainers Postgres (to prove the flush this task adds actually
// lands rows, the same discipline flush.test.ts uses) — booted through
// the SAME production `AppModule.forRoot()` wiring main.ts uses, not a
// parallel test-only module.
//
// WHY 30, AND WHY batchSize=1000/batchIntervalMs=60_000: the plan's own
// number (30) only proves anything if it is genuinely a PARTIAL batch —
// far below the count trigger and nowhere near the interval trigger
// during this test's own runtime — so the only thing that can put those
// 30 rows in Postgres is `ShutdownService.onModuleDestroy()` itself, not
// either of `BatchAccumulator`'s own two automatic triggers (T3.3.1)
// firing first and making this test pass for the wrong reason.
//
// "BEFORE THE PROMISE RESOLVES": `NestFactory.createApplicationContext()`
// hands back an `INestApplicationContext` whose `close()` awaits
// `callDestroyHook()` (verified against the installed @nestjs/core@11.1.28
// source, node_modules/@nestjs/core/nest-application-context.js) — the
// exact hook `onModuleDestroy()` is — before `close()` itself resolves.
// So `await app.close()` below IS "triggers onModuleDestroy and waits for
// it to finish" with no separate synchronization needed; the row-count
// assertion runs immediately afterward, on the same tick.
//
// "PARTIAL BATCH" MEANS ACCUMULATED, NOT MERELY ENQUEUED [T3.5.4 —
// REVISED FIXTURE MECHANISM, SAME CLAIM]: this test used to wait for all
// 30 jobs to reach BullMQ's `'completed'` state as its proof the
// accumulator was genuinely holding a partial, unflushed batch —
// `AccumulatingEventSink.handle()` used to be unable to reject, so
// `'completed'` could only mean `accumulator.add()` had already run.
// [T3.5.4] made that signal a CONTRADICTION with what this test is
// proving: `add()` now returns a `Promise<void>` that settles only once
// its batch flushes, so `handle()` — and therefore the job's own
// `process()` call — cannot resolve, and the job cannot reach
// `'completed'`, until AFTER a flush. Waiting for `completed === 30`
// would just time out waiting for a flush this test explicitly configures
// to never happen automatically (`BATCH_SIZE_NEVER_HIT`/
// `BATCH_INTERVAL_MS_NEVER_HIT` below). This is fixing the test's
// FIXTURE-SETUP MECHANISM to match an intentionally-changed contract, not
// weakening what it proves — the claim ("30 buffered-but-unflushed events
// survive a graceful shutdown, exactly once, no loss") is unchanged; only
// HOW the test detects "buffered" changes.
//
// The new signal: `BatchAccumulator.size()` (BATCH_ACCUMULATOR, the same
// DI token production wires `AccumulatingEventSink`/`ShutdownService`
// through) reaching exactly 30 — this is the accumulator's own open-batch
// item count, so it can ONLY be 30 once all 30 `add()` calls have pushed
// their event into it, independent of whether any of those calls has
// settled yet. Reading it requires no test double and no change to
// production wiring, just `app.get(BATCH_ACCUMULATOR)` against the SAME
// `INestApplicationContext` this test already boots.
//
// GETTING 30 SIMULTANEOUSLY IN-FLIGHT: with 30 events all blocking inside
// `add()` until a flush unblocks them, `EventsConsumer`'s own BullMQ
// `Worker` needs `concurrency >= 30` for all 30 to be dispatched to
// `process()` at once — `@Processor(EVENTS_QUEUE, { concurrency:
// readWorkerConcurrency() })`'s default (8) is fixed at MODULE-LOAD time
// (the decorator evaluates once, at import), not reconfigurable through
// `AppModuleConfig` here. `Worker` exposes a public `concurrency` setter
// (verified against the installed bullmq@5.80.10 types/source) that takes
// effect immediately post-construction — `app.get(EventsConsumer).worker
// .concurrency = PARTIAL_BATCH_SIZE` below sidesteps the module-load-time
// env-var timing problem entirely, with no process env var and no rebuild
// needed for this in-process test.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

// Mirrors packages/core/src/test/pg-container.ts's own CONTAINER_POOL_MAX
// (5) — a single test file, sequential queries, no horizontal-scaling
// concern, but still explicit rather than left to the pg driver default
// (createDbClient's own rule, db/client.ts).
const TEST_DB_POOL_MAX = 5;

// [T3.4.4] Unlike dlq.service.test.ts/events.consumer.test.ts/
// malformed-job.test.ts (which override `eventSink` and never really
// flush, so a no-op `flush` sidesteps R2 entirely), THIS test does NOT
// override `flush` — its whole point is proving a real
// `ShutdownService.onModuleDestroy()` flush lands rows, so it needs a
// REAL, working R2 client too (flushBatch now writes to both stores).
// Same local-dev-only MinIO root credentials as
// packages/core/src/r2/client.test.ts's own `REAL_CONFIG` (already in
// .env.example, not a real secret). This test does not clean up the R2
// object its own real flush creates — unlike client.test.ts/
// r2-put.test.ts/flush.test.ts, it never learns the accumulator's own
// internally-minted `batch_id`, so there is no key to target a
// `DeleteObjectCommand` at without listing (and risking deleting) other
// tests' objects sharing the same UTC date/hour partition; a few bytes
// of leftover local-dev NDJSON debris is the accepted tradeoff.
const REAL_R2_ENDPOINT = 'http://localhost:9000';
const REAL_R2_ACCESS_KEY_ID = 'posta-local-dev';
const REAL_R2_SECRET_ACCESS_KEY = 'posta-local-dev-secret';
const REAL_R2_BUCKET = 'posta-events';

const PARTIAL_BATCH_SIZE = 30;
// Comfortably above PARTIAL_BATCH_SIZE — the count trigger must never fire
// during this test.
const BATCH_SIZE_NEVER_HIT = 1000;
// Comfortably longer than this test's own runtime — the interval trigger
// must never fire either.
const BATCH_INTERVAL_MS_NEVER_HIT = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function buildCaptureEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
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

async function countEventsRows(pg: PgContainerHandle): Promise<number> {
  const result = await pg.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM events');
  return Number(result.rows[0]?.count ?? '0');
}

describe('ShutdownService — graceful shutdown flushes the in-memory batch (T3.1.6, real Redis + real Postgres)', () => {
  let redis: RedisContainerHandle;
  let pg: PgContainerHandle;
  let app: INestApplicationContext;
  let queue: Queue<CaptureEvent>;
  let accumulator: BatchAccumulator<CaptureEvent>;
  let pushedEvents: CaptureEvent[];
  let rowCountBeforeShutdown: number;
  let rowCountAfterShutdown: number;
  let persistedEventIds: string[];

  beforeAll(async () => {
    [redis, pg] = await Promise.all([startRedisContainer(), startPgContainer()]);
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

    app = await NestFactory.createApplicationContext(
      AppModule.forRoot({
        redisUrl: redis.url,
        databaseUrl: pg.url,
        dbPoolMax: TEST_DB_POOL_MAX,
        batchSize: BATCH_SIZE_NEVER_HIT,
        batchIntervalMs: BATCH_INTERVAL_MS_NEVER_HIT,
        shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        r2Endpoint: REAL_R2_ENDPOINT,
        r2AccessKeyId: REAL_R2_ACCESS_KEY_ID,
        r2SecretAccessKey: REAL_R2_SECRET_ACCESS_KEY,
        r2Bucket: REAL_R2_BUCKET,
      }),
    );

    queue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    // [T3.5.4] See this file's own header, "GETTING 30 SIMULTANEOUSLY
    // IN-FLIGHT" — the default WORKER_CONCURRENCY (8) cannot hold all 30
    // pushed events blocked in add() at once.
    accumulator = app.get<BatchAccumulator<CaptureEvent>>(BATCH_ACCUMULATOR);
    app.get(EventsConsumer).worker.concurrency = PARTIAL_BATCH_SIZE;

    pushedEvents = Array.from({ length: PARTIAL_BATCH_SIZE }, (_unused, index) =>
      buildCaptureEvent({ slug: `promo-${index}` }),
    );
    await Promise.all(pushedEvents.map((event) => queue.add('capture', event)));

    // [T3.5.4] Waits for the accumulator's own open-batch size to reach
    // 30 — see this file's own header, "PARTIAL BATCH MEANS ACCUMULATED,
    // NOT MERELY ENQUEUED", for why this replaced waiting on BullMQ's
    // `'completed'` job state.
    await vi.waitFor(
      () => {
        expect(accumulator.size()).toBe(PARTIAL_BATCH_SIZE);
      },
      { timeout: 30_000, interval: 100 },
    );

    rowCountBeforeShutdown = await countEventsRows(pg);

    await app.close();

    rowCountAfterShutdown = await countEventsRows(pg);
    const idsResult = await pg.pool.query<{ event_id: string }>('SELECT event_id FROM events');
    persistedEventIds = idsResult.rows.map((row) => row.event_id);
  }, 120_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await pg.stop();
    await redis.stop();
  }, 120_000);

  it('has NOT flushed the partial batch before shutdown — the 30 events are genuinely still in-memory, not auto-flushed by either trigger', () => {
    expect(rowCountBeforeShutdown).toBe(0);
  });

  it('flushes all 30 buffered events to Postgres by the time onModuleDestroy (app.close()) resolves', () => {
    expect(rowCountAfterShutdown).toBe(PARTIAL_BATCH_SIZE);
  });

  it('persists exactly the 30 event_id values that were pushed — no fewer, no extras', () => {
    const expectedIds = pushedEvents.map((event) => event.event_id).sort();
    expect(persistedEventIds.sort()).toEqual(expectedIds);
  });
});
