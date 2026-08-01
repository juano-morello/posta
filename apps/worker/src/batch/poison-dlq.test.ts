import path from 'node:path';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createR2Client, eventBatchKey, EVENTS_DLQ_QUEUE, newId, runSqlMigrations, type R2ClientConfig } from '@posta/core';
import { startPgContainer, startRedisContainer, type PgContainerHandle, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { DlqService, type EventsDlqJobPayload } from '../consumer/dlq.service';
import { createFlushBatch, type FlushBatch } from './flush';
import {
  retryWithSplit,
  sendPoisonEventsToDlq,
  type PoisonDlqSink,
  type PoisonedEvent,
  type Sleep,
} from './split-retry';

// T3.3.4 [E3, S3.3] — proves the bridge from a REAL Postgres rejection,
// through `retryWithSplit` (T3.3.3), to a REAL DLQ entry
// (`sendPoisonEventsToDlq`, this task, split-retry.ts). Postgres, Redis
// AND R2/MinIO are all real here (never mocked), deliberately unlike
// split-retry.test.ts's own fake-`flushBatch` choice: THAT file proves
// the retry/split ALGORITHM generically, decoupled from any specific
// rejection cause (its own header explains why a fake was the honest
// choice there — `events.slug` has no real length constraint to
// violate). THIS file needs a GENUINE SQLSTATE, which only a genuine
// Postgres rejection can produce.
//
// A REAL, REPRODUCIBLE POSTGRES REJECTION — not a manufactured one:
// `events.asn` is a plain `integer` column (packages/core/migrations/sql/
// 001_events.sql), and CaptureEventSchema's own `asn` field
// (packages/contracts/src/capture.ts) is `z.number().nullable()` with no
// upper bound. A value outside int4's own range (-2147483648..2147483647)
// is perfectly valid at the Zod/TypeScript level but genuinely
// unrepresentable in the column Postgres actually has — passing
// `Number.MAX_SAFE_INTEGER` reproduces "integer out of range"
// (SQLSTATE 22003) on every real Postgres 16, deterministically, with no
// mock and no manufactured error object.
//
// R2/MinIO IS ALSO REQUIRED NOW, NOT THIS TASK'S OWN CHOICE: flush.ts's
// `createFlushBatch` (T3.4.4, landed concurrently with this task) now
// requires `r2Client`/`r2Bucket` and PUTs to R2 on every flush attempt —
// so every call this file makes through `flushBatch`, including failed
// ones, needs a real R2 target or it would reject before ever reaching
// the Postgres INSERT this test actually cares about. `REAL_R2_CONFIG`
// mirrors flush.test.ts's/r2-put.test.ts's own identical constant (same
// local-dev-only MinIO root credentials, already in .env.example).
//
// R2 CLEANUP IS PARTIAL, DELIBERATELY: `retryWithSplit` calls
// `flushBatch(events)` with NO explicit `batchId` (flush.ts's own header
// names this a known, accepted gap — a retried/split sub-batch mints a
// fresh R2 key per attempt via `flushBatch`'s own internal `newId()`
// default, rather than this test being able to predict or track it).
// This file only tracks-and-deletes the R2 objects from calls where IT
// explicitly supplies a `batchId` (the "resubmit" test's own final
// `flushBatch` call, below) — the same "explicit batchId so the exact
// key is predictable" discipline flush.test.ts/r2-put.test.ts already
// use for their own tracked keys.
//
// TEST-LEVEL "re-submitted through flushBatch" (per this task's own
// scoping note): this does not build a new auto-replay feature (that is
// S3.6's job) — it takes the DLQ entry's own `rawPayload` back out,
// fixes the ONE field that made the original insert fail, and calls the
// REAL `flushBatch` (from ./flush, the same function `retryWithSplit`
// itself was calling) again, proving `rawPayload` is a faithful, complete
// `CaptureEvent` and not a lossy or redacted copy.

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

/** Instant, no-real-wait `sleep` double — same "narrow, replaceable seam"
 * split-retry.ts's own header describes, and the identical shape
 * split-retry.test.ts's own `createRecordingSleep` uses. Real Postgres
 * and R2 round trips are the only actual latency this test waits on. */
const instantSleep: Sleep = async () => undefined;

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

interface RecordingRejectingSink extends PoisonDlqSink {
  calls: number;
}

/** A recording {@link PoisonDlqSink} double, used only by the two
 * dedicated seam tests below (empty-array no-op, rejection propagation)
 * — every other test in this file uses a REAL `DlqService` against a
 * real testcontainers Redis queue, per this file's own header. */
function createRejectingDlqSink(): RecordingRejectingSink {
  const sink: RecordingRejectingSink = {
    calls: 0,
    async send() {
      sink.calls += 1;
      throw new Error('dlq write failed');
    },
  };
  return sink;
}

// [T3.3.4] SQLSTATE 22003 is PostgreSQL's own stable, documented code for
// "numeric_value_out_of_range" (class 22 — Data Exception), unchanged
// across versions: https://www.postgresql.org/docs/current/errcodes-appendix.html
const OUT_OF_RANGE_INT_SQLSTATE = '22003';

describe('sendPoisonEventsToDlq (T3.3.4) — real Postgres rejection routed to a real DLQ', () => {
  let pg: PgContainerHandle;
  let redis: RedisContainerHandle;
  let dlqQueue: Queue<EventsDlqJobPayload>;
  let dlqService: DlqService;
  let flushBatch: FlushBatch;
  const r2Client = createR2Client(REAL_R2_CONFIG);
  const r2CreatedKeys: string[] = [];

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    redis = await startRedisContainer();

    dlqQueue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    dlqService = new DlqService(dlqQueue);
    flushBatch = createFlushBatch({ db: pg.db, r2Client, r2Bucket: REAL_R2_CONFIG.bucket });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await Promise.all(
        r2CreatedKeys.splice(0).map((key) =>
          r2Client.send(new DeleteObjectCommand({ Bucket: REAL_R2_CONFIG.bucket, Key: key })),
        ),
      );
    }
    await dlqQueue.obliterate({ force: true });
    await dlqQueue.close();
    await redis.stop();
    await pg.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('routes each of TWO poisoned events (out of six) to its own DLQ entry, carrying the full payload and a real SQLSTATE, while every healthy event still commits', async () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      buildCaptureEvent(
        index === 0 || index === 4 ? { asn: Number.MAX_SAFE_INTEGER } : { asn: 64512 },
      ),
    );
    const poisonEventIds = [events[0]!.event_id, events[4]!.event_id].sort();

    const result = await retryWithSplit(events, flushBatch, {
      maxAttemptsPerBatch: 2,
      initialDelayMs: 0,
      sleep: instantSleep,
    });

    // Nothing lost, nothing duplicated: every original event is either
    // committed or poisoned, exactly once.
    expect(result.committedEvents).toHaveLength(4);
    expect(result.poisonEvents).toHaveLength(2);
    const poisonedIds = result.poisonEvents.map((p) => p.event.event_id).sort();
    expect(poisonedIds).toEqual(poisonEventIds);

    const batchId = newId();
    await sendPoisonEventsToDlq(result.poisonEvents, dlqService, {
      batchId,
      maxAttemptsPerBatch: 2,
    });

    const dlqJobs = await dlqQueue.getJobs(['waiting']);
    expect(dlqJobs).toHaveLength(2);

    const entriesByEventId = new Map(
      dlqJobs.map((job) => [(job.data.rawPayload as CaptureEvent).event_id, job.data]),
    );
    expect([...entriesByEventId.keys()].sort()).toEqual(poisonEventIds);

    for (const poisoned of result.poisonEvents) {
      const entry = entriesByEventId.get(poisoned.event.event_id);
      expect(entry).toBeDefined();
      expect(entry?.reason).toBe('flush-poison');
      // The full original payload, byte-for-byte — not a summary, not a
      // redacted subset.
      expect(entry?.rawPayload).toEqual(poisoned.event);
      expect(entry?.sqlstate).toBe(OUT_OF_RANGE_INT_SQLSTATE);
      expect(entry?.errorMessage.length).toBeGreaterThan(0);
      expect(entry?.attemptsMade).toBe(2);
      expect(entry?.originalJobId).toBe(batchId);
      expect(entry?.issues).toEqual([]);
      expect(new Date(entry!.failedAt).toISOString()).toBe(entry?.failedAt);
    }

    // The 4 healthy events actually landed in Postgres...
    const countResult = await pg.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM events');
    expect(Number(countResult.rows[0]?.count ?? '0')).toBe(4);

    // ...and NEITHER poisoned event did — the DLQ entry is the only place
    // either currently exists, which is exactly why losing it would be
    // an unrecoverable silent drop.
    const poisonedRows = await pg.pool.query<{ event_id: string }>(
      'SELECT event_id FROM events WHERE event_id = ANY($1::text[])',
      [poisonEventIds],
    );
    expect(poisonedRows.rows).toHaveLength(0);
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('the stored rawPayload, once the fault is fixed, flushes successfully through the REAL flushBatch and lands a row in Postgres', async () => {
    const poisonEvent = buildCaptureEvent({ asn: Number.MAX_SAFE_INTEGER });

    const result = await retryWithSplit([poisonEvent], flushBatch, {
      maxAttemptsPerBatch: 2,
      initialDelayMs: 0,
      sleep: instantSleep,
    });
    expect(result.poisonEvents).toHaveLength(1);

    await sendPoisonEventsToDlq(result.poisonEvents, dlqService, {
      batchId: newId(),
      maxAttemptsPerBatch: 2,
    });

    const dlqJobs = await dlqQueue.getJobs(['waiting']);
    const entry = dlqJobs.find((job) => (job.data.rawPayload as CaptureEvent).event_id === poisonEvent.event_id);
    expect(entry).toBeDefined();

    // Before the fix: no row exists yet (the original flush genuinely
    // never committed it).
    const beforeFix = await pg.pool.query('SELECT 1 FROM events WHERE event_id = $1', [poisonEvent.event_id]);
    expect(beforeFix.rowCount).toBe(0);

    // The fidelity proof: take the payload straight OUT of the DLQ entry
    // and fix the ONE field that made the real INSERT fail — nothing
    // else about the row is touched.
    const storedPayload = entry!.data.rawPayload as CaptureEvent;
    const fixedEvent: CaptureEvent = { ...storedPayload, asn: 64512 };

    // An explicit batchId (unlike retryWithSplit's own internal calls,
    // see this file's own header) so the R2 object this resolves to is
    // predictable and gets cleaned up in afterAll.
    const resubmitBatchId = newId();
    r2CreatedKeys.push(eventBatchKey(resubmitBatchId, fixedEvent.occurred_at));

    await expect(flushBatch([fixedEvent], resubmitBatchId)).resolves.toBeUndefined();

    const afterFix = await pg.pool.query<{ asn: number | null }>(
      'SELECT asn FROM events WHERE event_id = $1',
      [poisonEvent.event_id],
    );
    expect(afterFix.rowCount).toBe(1);
    expect(afterFix.rows[0]?.asn).toBe(64512);
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('an empty poisonEvents array is a no-op: dlqSink.send is never called', async () => {
    const sink = createRejectingDlqSink();

    await sendPoisonEventsToDlq([], sink, { batchId: newId(), maxAttemptsPerBatch: 2 });

    expect(sink.calls).toBe(0);
  });

  it('does NOT swallow a dlqSink.send() rejection — a poison event that fails to even reach the DLQ propagates, rather than vanishing silently', async () => {
    const poisoned: PoisonedEvent = { event: buildCaptureEvent(), error: new Error('simulated rejection') };
    const sink = createRejectingDlqSink();

    await expect(
      sendPoisonEventsToDlq([poisoned], sink, { batchId: newId(), maxAttemptsPerBatch: 2 }),
    ).rejects.toThrow(/dlq write failed/);
    expect(sink.calls).toBe(1);
  });
});
