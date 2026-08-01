import 'reflect-metadata';
import path from 'node:path';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
  createR2Client,
  eventPrefixes,
  EVENTS_DLQ_QUEUE,
  newId,
  runSqlMigrations,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, startRedisContainer, type PgContainerHandle, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { BATCH_ACCUMULATOR } from '../consumer/events.consumer';
import type { EventsDlqJobPayload } from '../consumer/dlq.service';
import type { BatchAccumulator } from './accumulator';

// T3.7.3 [E3, S3.7][INV-7][INV-8] — proves `buildProductionFlush`
// (app.module.ts) actually wires `retryWithSplit`/`sendPoisonEventsToDlq`
// (split-retry.ts, T3.3.3/T3.3.4) into the REAL production flush path.
// Before this task, `retryWithSplit`/`sendPoisonEventsToDlq` were built,
// reviewed and unit/integration-tested (split-retry.test.ts,
// poison-dlq.test.ts) but never called from anywhere `BatchAccumulator`
// (T3.3.1) could reach — `buildProductionFlush` returned `createFlushBatch`'s
// own closure DIRECTLY, so a single poison row failed the WHOLE batch and
// dead-lettered all 100 events through the consumer's own
// 'attempts-exhausted' path, exactly the outcome S3.3's acceptance criteria
// reject. This file boots the REAL `AppModule.forRoot()` (never a parallel
// test-only module — the same discipline shutdown.test.ts/
// events.consumer.test.ts already establish) against real testcontainers
// Postgres/Redis and the real compose-managed MinIO, drives its own real
// `BatchAccumulator<CaptureEvent>` (fetched via the same `BATCH_ACCUMULATOR`
// DI token `ShutdownService`/`AccumulatingEventSink` inject, per
// shutdown.test.ts's own established precedent) directly with `.add()` —
// bypassing BullMQ/`EventsConsumer` entirely, since `WORKER_CONCURRENCY` is
// fixed at module-load time (events.consumer.ts's own header) and this
// test has no reason to fight that when `BATCH_ACCUMULATOR` is reachable
// directly, the same shortcut shutdown.test.ts's own header already
// documents taking for a different reason.
//
// WHY 100 EVENTS, EXACTLY ONE POISON, AND WHY `asn: Number.MAX_SAFE_INTEGER`
// — mirrors poison-dlq.test.ts's own technique verbatim: `events.asn` is a
// plain Postgres `integer` column with no application-level upper bound
// check, so a value outside int4's own range reproduces a genuine,
// reproducible SQLSTATE 22003 ("numeric_value_out_of_range") on every real
// Postgres 16, no mock and no manufactured error object needed. `batchSize:
// 100` makes the accumulator's own COUNT trigger fire the instant the
// 100th `add()` call lands — no interval wait, no race with the interval
// trigger (`batchIntervalMs` is set far larger than this test's own
// runtime, so it can never fire first).
//
// THE R2 KEY-SET ASSERTION — WHY A UNION-OF-IDS CHECK WOULD PASS TRIVIALLY,
// EVEN WITH A REAL COLLISION BUG: `flushBatch` (flush.ts) PUTs to R2 BEFORE
// it INSERTs to Postgres, so the ROOT attempt's PUT of all 100 events
// (poison row included) has already succeeded before the poison row's
// INSERT ever fails and any split happens — a check that only unions
// `event_id`s across every object under the hour prefix would already
// contain all 100 ids from that ONE root PUT alone, regardless of whether
// every later sub-batch PUT landed at its own distinct key or silently
// overwrote a sibling's object at a colliding one. `computeExpectedR2Nodes`
// below independently re-derives, from the same 100 event ids and the same
// `Math.ceil`-split rule `retryWithSplit`'s own `attemptBatch` uses
// (split-retry.ts), the exact multiset of "one sub-batch's own full event
// set" every real R2 PUT should have produced — including every internal
// split node, not just the leaves, since EVERY `attemptBatch` invocation
// (whether it eventually succeeds outright, splits further, or is declared
// poison) issues its own R2 PUT on its very first attempt, before it ever
// knows whether it will need to retry. The test then reads every object
// actually sitting under the hour prefix, by KEY, and compares the
// resulting per-key CONTENT signature multiset against that independently
// computed expectation — a colliding key would either reduce the number of
// distinct objects below the expected node count, or leave one expected
// node's own content signature entirely absent (overwritten by a sibling's
// PUT), either of which this comparison catches and a union check cannot.
//
// REPLAY IS NOT THE RECOVERY PATH FOR THE POISON ROW — recorded here so
// nobody mistakes this file's own R2-key assertions as implying otherwise.
// The poisoned event's R2 object (whichever sub-batch object ends up
// holding just that one event) exists because its PUT succeeded before its
// INSERT failed, not because it is replayable: a replay of that same row
// would re-attempt the identical INSERT and fail identically (SQLSTATE
// 22003 doesn't change no matter how many times the same out-of-range
// value is retried). The DLQ entry this file also asserts on is the actual
// recovery path for a poison row (poison-dlq.test.ts's own "resubmit after
// fixing the field" test already proves that path); this file does not
// re-prove it and does not assert anything that would imply replay "fixes"
// a poisoned row.

const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

// Mirrors packages/core/src/test/pg-container.ts's own CONTAINER_POOL_MAX —
// a single test file, sequential queries, no horizontal-scaling concern.
const TEST_DB_POOL_MAX = 5;

const BATCH_EVENT_COUNT = 100;
// Comfortably longer than this test's own runtime (including the real
// split-retry backoff delays app.module.ts's own new module constants
// introduce) — the interval trigger must never fire; only the count
// trigger (at exactly BATCH_EVENT_COUNT) may.
const BATCH_INTERVAL_MS_NEVER_HIT = 120_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

// [T3.3.4] SQLSTATE 22003 is PostgreSQL's own stable, documented code for
// "numeric_value_out_of_range" (class 22 — Data Exception), unchanged
// across versions, confirmed against a real Postgres 16 while developing
// this file (RED phase) — see this task's own implementation notes.
const OUT_OF_RANGE_INT_SQLSTATE = '22003';

// A private, fixed instant far outside every other fixture window already
// claimed in this codebase (pipeline-harness.ts's 2080-2087,
// reconciliation.test.ts's 2050-2057, replay.test.ts's 2090-2127,
// stream-read.test.ts's 2033/2034, e2e-pg-outage.test.ts's 2130-2137) — a
// SINGLE fixed timestamp, not a randomized range, since every event in
// this file's own batch needs to land in the exact same R2 hour partition
// for the key-set assertion below to be meaningful.
const OCCURRED_AT = '2150-06-15T10:00:00.000Z';

function buildCaptureEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: OCCURRED_AT,
    tenant_id: 'tenant-1',
    link_id: 'link-1',
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

/**
 * Independently re-derives the exact multiset of "one sub-batch's own full
 * event_id set" that a correct `retryWithSplit` run over `eventIds` (with
 * exactly one poison id present) should produce one R2 object for — see
 * this file's own header, "THE R2 KEY-SET ASSERTION", for why this needs
 * to exist at all rather than a weaker union check. Mirrors
 * `attemptBatch`'s own branching (split-retry.ts) at the level that
 * matters for R2 object production: EVERY node (whether it succeeds
 * outright, splits further, or ends up declared poison) contributes
 * exactly one node — retries of the SAME node reuse the SAME `batchId` and
 * therefore overwrite the SAME key, never producing a second object — and
 * a node containing no poison id never needs to split (it succeeds on its
 * first, only attempt).
 */
function computeExpectedR2Nodes(eventIds: readonly string[], poisonEventId: string): string[][] {
  const nodes: string[][] = [[...eventIds]];

  if (eventIds.length > 1 && eventIds.includes(poisonEventId)) {
    const mid = Math.ceil(eventIds.length / 2);
    nodes.push(...computeExpectedR2Nodes(eventIds.slice(0, mid), poisonEventId));
    nodes.push(...computeExpectedR2Nodes(eventIds.slice(mid), poisonEventId));
  }

  return nodes;
}

/** A canonical, order-independent signature for a set of event ids — lets
 * this file compare "which events ended up together in one R2 object"
 * without caring about NDJSON line order. */
function signature(eventIds: readonly string[]): string {
  return [...eventIds].sort().join(',');
}

describe('buildProductionFlush wires retryWithSplit + sendPoisonEventsToDlq into the real flush (T3.7.3, real Postgres/Redis/MinIO)', () => {
  let pg: PgContainerHandle;
  let redis: RedisContainerHandle;
  let app: INestApplicationContext;
  let dlqQueue: Queue<EventsDlqJobPayload>;
  const r2Client: S3Client = createR2Client(REAL_R2_CONFIG);
  let r2CreatedKeys: string[] = [];

  let events: CaptureEvent[];
  let poisonEvent: CaptureEvent;
  let committedRowCount: number;
  let dlqEntry: EventsDlqJobPayload | undefined;
  let actualObjectKeys: string[];
  let actualSignatures: string[];
  let expectedSignatures: string[];

  beforeAll(async () => {
    [redis, pg] = await Promise.all([startRedisContainer(), startPgContainer()]);
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

    dlqQueue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });

    app = await NestFactory.createApplicationContext(
      AppModule.forRoot({
        redisUrl: redis.url,
        databaseUrl: pg.url,
        dbPoolMax: TEST_DB_POOL_MAX,
        batchSize: BATCH_EVENT_COUNT,
        batchIntervalMs: BATCH_INTERVAL_MS_NEVER_HIT,
        shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        r2Endpoint: REAL_R2_CONFIG.endpoint,
        r2AccessKeyId: REAL_R2_CONFIG.accessKeyId,
        r2SecretAccessKey: REAL_R2_CONFIG.secretAccessKey,
        r2Bucket: REAL_R2_CONFIG.bucket,
      }),
    );

    const accumulator = app.get<BatchAccumulator<CaptureEvent>>(BATCH_ACCUMULATOR);

    events = Array.from({ length: BATCH_EVENT_COUNT }, (_unused, index) =>
      buildCaptureEvent(index === 0 ? { asn: Number.MAX_SAFE_INTEGER } : {}),
    );
    poisonEvent = events[0]!;

    // Synchronous loop (Array.prototype.map never awaits its callback), so
    // every add() call lands, in order, before this line finishes — the
    // 100th call is the one that trips the count trigger and fires the
    // real production flush. `allSettled`, not `all`: in the RED phase
    // (before this task's own app.module.ts change) every one of these
    // rejects together (the whole 100-row INSERT fails on the poison row,
    // with nothing isolated) — this file's own assertions below read the
    // resulting Postgres/DLQ/R2 state directly rather than depending on
    // whether the add() promises themselves resolved or rejected.
    const addPromises = events.map((event) => accumulator.add(event));
    await Promise.allSettled(addPromises);

    const countResult = await pg.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM events WHERE tenant_id = $1',
      ['tenant-1'],
    );
    committedRowCount = Number(countResult.rows[0]?.count ?? '0');

    const dlqJobs = await dlqQueue.getJobs(['waiting']);
    dlqEntry = dlqJobs
      .map((job) => job.data)
      .find((data) => (data.rawPayload as CaptureEvent | undefined)?.event_id === poisonEvent.event_id);

    const prefixes = eventPrefixes(OCCURRED_AT, OCCURRED_AT);
    const hourPrefix = prefixes[new Date(OCCURRED_AT).getUTCHours()]!;
    const listing = await r2Client.send(
      new ListObjectsV2Command({ Bucket: REAL_R2_CONFIG.bucket, Prefix: hourPrefix }),
    );
    actualObjectKeys = (listing.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => key !== undefined);
    r2CreatedKeys = actualObjectKeys;

    const actualSigs: string[] = [];
    for (const key of actualObjectKeys) {
      const getResult = await r2Client.send(
        new GetObjectCommand({ Bucket: REAL_R2_CONFIG.bucket, Key: key }),
      );
      const body = (await getResult.Body?.transformToString('utf-8')) ?? '';
      const ids = body
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { event_id: string }).event_id);
      actualSigs.push(signature(ids));
    }
    actualSignatures = actualSigs.sort();

    const expectedNodes = computeExpectedR2Nodes(
      events.map((event) => event.event_id),
      poisonEvent.event_id,
    );
    expectedSignatures = expectedNodes.map((node) => signature(node)).sort();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await r2Client
        .send(
          new DeleteObjectsCommand({
            Bucket: REAL_R2_CONFIG.bucket,
            Delete: { Objects: r2CreatedKeys.map((Key) => ({ Key })) },
          }),
        )
        .catch(() => undefined);
    }
    r2Client.destroy();

    await dlqQueue.obliterate({ force: true });
    await dlqQueue.close();
    await app.close();
    await pg.stop();
    await redis.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('commits the 99 healthy events to Postgres — the poison row is isolated, not lost with the rest of the batch', () => {
    expect(committedRowCount).toBe(BATCH_EVENT_COUNT - 1);
  });

  it('routes exactly one DLQ entry for the poisoned event, reason "flush-poison", carrying the real SQLSTATE', () => {
    expect(dlqEntry).toBeDefined();
    expect(dlqEntry?.reason).toBe('flush-poison');
    expect(dlqEntry?.sqlstate).toBe(OUT_OF_RANGE_INT_SQLSTATE);
  });

  it('the poisoned Postgres row genuinely does not exist — the DLQ entry is the only place it exists', async () => {
    const result = await pg.pool.query<{ event_id: string }>(
      'SELECT event_id FROM events WHERE event_id = $1',
      [poisonEvent.event_id],
    );
    expect(result.rowCount).toBe(0);
  });

  it('the R2 object KEY SET under the batch hour prefix holds one distinct object per sub-batch the split actually produced, each containing exactly its own events — not a weaker union-of-ids check', () => {
    expect(actualObjectKeys.length).toBe(expectedSignatures.length);
    expect(actualSignatures).toEqual(expectedSignatures);
  });

  it('the root object (all 100 events, poison row included) is among the objects actually written — its PUT succeeded before the poison row ever reached Postgres', () => {
    const rootSignature = signature(events.map((event) => event.event_id));
    expect(actualSignatures).toContain(rootSignature);
  });
});
