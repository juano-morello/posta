import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { eventPrefixes } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPipelineHarness, type PipelineHarness } from './pipeline-harness';

// T3.5.3 [E3, S3.5][INV-8] — the plan's own literal scenario: "Re-enqueues
// 500 of the 10k jobs with their original event_id values after the first
// drain, across a batch boundary so the duplicates land in different
// batches than the originals. BullMQ is at-least-once by design, so this
// is the normal steady state, not a fault injection." This is the sibling
// e2e-exactly-once.test.ts (T3.5.2) names by contrast within this same
// story: that file proves a SINGLE delivery lands exactly once; this file
// proves a SECOND, genuinely redundant delivery of the SAME jobs changes
// nothing — the property `ON CONFLICT (event_id, occurred_at) DO NOTHING`
// (packages/core/src/db/events.ts) exists to guarantee end-to-end, through
// the real queue and the real spawned worker process, not merely at the
// `flushBatch()`-direct level idempotency.test.ts (T3.3.5) already covers.
//
// --- HOW REDELIVERY OF IDENTICAL EVENTS IS IMPLEMENTED -----------------
//
// pipeline-harness.ts's own `push(n)` always MINTS a fresh `event_id` per
// call (buildCaptureEventFromCorpus, pipeline-harness-fixtures.ts) — by
// design, since every OTHER S3.5 test wants NEW events. Proving THIS task's
// own property needs the opposite: enqueueing the exact same CaptureEvent
// objects — byte-identical `event_id`/`occurred_at`/every field — a SECOND
// time, which is what a real BullMQ at-least-once redelivery actually looks
// like (the consumer never re-derives or regenerates anything about a job
// it is asked to process again). `push()` itself has no way to express
// "these exact events, again" — its whole contract is building NEW ones —
// so the harness gained one small, additive, backward-compatible method:
// `redeliver(events)`, which reuses the exact same internal `enqueue()`
// helper `push()` now also calls (a pure extraction, no behavior change for
// existing callers), stamping the SAME "last enqueue started at" marker
// `drain()` already reads. `e2e-exactly-once.test.ts` and
// `pipeline-harness.test.ts` exercise none of this new surface and are
// asserted unmodified in this task's own regression sweep.
//
// --- WHY THE REDELIVERED EVENTS LAND IN A DIFFERENT BATCH BY
// CONSTRUCTION, NOT BY ANY EXTRA EFFORT IN THIS FILE -----------------------
//
// `harness.drain()` is called once after the initial `push(10_000)` and
// does not return until the accumulator's currently-open batch is empty
// (this file's own header on pipeline-harness.ts: "batch_size === 0 ...
// can only be true because a trigger already swapped it out via a
// completed flush"). With the default `EVENT_BATCH_SIZE` of 500 and 10,000
// events pushed, the count trigger fires exactly 20 times, and by the time
// `drain()` returns every one of those 20 batches has already flushed and
// the accumulator's open batch is genuinely empty. The 500 redelivered
// events enqueued afterward therefore cannot land in any of those 20
// batches — there is nothing left open for them to join — they necessarily
// open (and, at exactly 500, fill) a 21st, brand-new batch. This is exactly
// the plan's own "across a batch boundary" requirement, satisfied as a
// direct consequence of calling `drain()` before redelivering, not through
// any timing this file has to engineer itself.
//
// --- WHAT "no row's occurred_at was rewritten" ACTUALLY PROVES ----------
//
// Every event this harness's `push()` builds shares the ONE `occurredAt`
// instant fixed for the whole harness instance (pipeline-harness.ts's own
// header, "ONE BATCH, ONE OBJECT"). Since `occurred_at` is HALF of the
// `ON CONFLICT` target `(event_id, occurred_at)`, a redelivery genuinely
// carrying the same `occurred_at` can only ever match-and-skip under
// `DO NOTHING` — there is no way for a correct `DO NOTHING` conflict to
// change a column that is itself part of the match. The failure mode this
// guards against is a DIFFERENT bug shape entirely: an `ON CONFLICT DO
// UPDATE` that stamps some OTHER value (a "last redelivered at", `now()`)
// onto `occurred_at` on the way past — silently rewriting the very column
// analytics partitions and queries by. This file proves that never happens
// by capturing a full per-`event_id` fingerprint (`occurred_at`, as epoch
// milliseconds off the driver's own parsed `Date`) after the FIRST drain,
// then again after the redelivery's drain, and asserting the two maps are
// exactly equal — not merely that the 500 redelivered ids are unchanged
// (a bug touching unrelated rows would slip past a narrower check), every
// one of the 10,000 is checked.
//
// --- RED-PHASE PROOF ACTUALLY PERFORMED (not merely planned) -----------
//
// Mirrors e2e-exactly-once.test.ts's and idempotency.test.ts's own
// documented process. With this file otherwise unchanged,
// packages/core/src/db/events.ts's `insertEventsBatch` was temporarily
// rewritten from
//   .onConflictDoNothing({ target: [events.eventId, events.occurredAt] })
// to
//   .onConflictDoUpdate({
//     target: [events.eventId, events.occurredAt],
//     set: { occurredAt: sql`now()` },
//   })
// (importing `sql` from `drizzle-orm`) — a real `ON CONFLICT DO UPDATE`
// that stamps every conflicting row's `occurred_at` with the wall-clock
// instant of the REDELIVERY, exactly the "silent timestamp rewrite" bug
// shape this file's own header describes. `@posta/core` was rebuilt
// (`pnpm --filter @posta/core run build`) so the worker's compiled dist
// actually picked up the change, then `pnpm test e2e-duplicate-delivery.test.ts`
// was run against that sabotage. Result: a REAL assertion-level failure —
// "no row's occurred_at changed between the first drain and the
// redelivery's drain" failed with the fingerprint map for exactly the 500
// redelivered event_ids showing a NEW, much-later `occurred_at` than the
// harness's own fixed instant, while the other 9,500 untouched rows'
// fingerprints matched exactly — not a timeout and not an import/module
// error, and the failure was scoped to precisely the 500 rows the
// sabotage's `ON CONFLICT` clause actually touched, proving the
// per-`event_id` fingerprint comparison genuinely discriminates a partial
// rewrite rather than only ever noticing a wholesale one. The row-count
// assertions were unaffected by this particular sabotage (`DO UPDATE`
// still touches exactly one existing row per conflict, never adds one),
// which is expected — TABLE `events`' own `PRIMARY KEY (event_id,
// occurred_at)` constraint makes a genuine EXTRA duplicate row physically
// impossible to produce through this insert path without dropping that
// constraint outright, an out-of-scope schema change this task has no
// reason to make; the `ON CONFLICT` clause is the one place idempotency
// could plausibly be silently wrong, and that is exactly what this
// sabotage targeted. The sabotage was then reverted and
// `packages/core/src/db/events.ts` restored to what is committed today
// (`onConflictDoNothing`), `@posta/core` rebuilt again, after which every
// assertion below passes.
//
// --- ISOLATION STRATEGY -------------------------------------------------
//
// Same discipline as every sibling in this story: one `startPipelineHarness()`
// call seeds exactly one tenant, every Postgres query scopes by
// `harness.tenantId`, and the R2 cleanup lists only the hour prefix(es)
// `harness.occurredAt` actually falls in — this worktree's Postgres and
// MinIO are shared with concurrent sibling agents, so both scopings are
// load-bearing, not decorative.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const EVENT_COUNT = 10_000;
// The plan's own literal number (T3.5.3: "Re-enqueues 500 of the 10k jobs").
const DUPLICATE_COUNT = 500;
const SETUP_TIMEOUT_MS = 300_000;
const TEARDOWN_TIMEOUT_MS = 120_000;

interface RowCounts {
  readonly total: number;
  readonly distinct: number;
}

/** `event_id -> occurred_at` (epoch milliseconds, off the pg driver's own
 * parsed `Date` for a `timestamptz` column) for every row under `tenantId`
 * — the per-row fingerprint this file's own header describes. */
async function fetchOccurredAtFingerprints(
  harness: PipelineHarness,
): Promise<Map<string, number>> {
  const result = await harness.pg.pool.query<{ event_id: string; occurred_at: Date }>(
    'SELECT event_id, occurred_at FROM events WHERE tenant_id = $1',
    [harness.tenantId],
  );
  return new Map(result.rows.map((row) => [row.event_id, row.occurred_at.getTime()]));
}

async function fetchRowCounts(harness: PipelineHarness): Promise<RowCounts> {
  const result = await harness.pg.pool.query<{ total: string; distinct_count: string }>(
    'SELECT COUNT(*) AS total, COUNT(DISTINCT event_id) AS distinct_count FROM events WHERE tenant_id = $1',
    [harness.tenantId],
  );
  const row = result.rows[0]!;
  return { total: Number(row.total), distinct: Number(row.distinct_count) };
}

/** Lists every object key under `prefixes` — mirrors
 * e2e-exactly-once.test.ts's own identically-named helper, needed for the
 * same reason: going through the real queue/consumer means the accumulator
 * mints its own `batchId` per flush, invisible to this test, so there is no
 * incrementally-built key list to maintain — cleanup instead lists every
 * key under this run's own hour prefix(es). */
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

describe('duplicate delivery of already-landed events produces no duplicate rows (T3.5.3) [INV-8]', () => {
  let harness: PipelineHarness;
  let pushedEvents: readonly CaptureEvent[];
  let duplicatedEvents: readonly CaptureEvent[];
  let firstCounts: RowCounts;
  let firstFingerprints: Map<string, number>;
  let secondCounts: RowCounts;
  let secondFingerprints: Map<string, number>;
  let r2Keys: string[];

  beforeAll(async () => {
    harness = await startPipelineHarness();

    pushedEvents = await harness.push(EVENT_COUNT);
    await harness.drain();

    firstCounts = await fetchRowCounts(harness);
    firstFingerprints = await fetchOccurredAtFingerprints(harness);

    // The first 500 of the 10k already-landed events, re-enqueued with
    // their ORIGINAL event_id and occurred_at — a real BullMQ redelivery
    // of an already-processed job, not a fresh capture. See this file's
    // own header for why these necessarily land in a new batch.
    duplicatedEvents = pushedEvents.slice(0, DUPLICATE_COUNT);
    await harness.redeliver(duplicatedEvents);
    await harness.drain();

    secondCounts = await fetchRowCounts(harness);
    secondFingerprints = await fetchOccurredAtFingerprints(harness);

    const prefixes = eventPrefixes(harness.occurredAt, harness.occurredAt);
    r2Keys = await listR2ObjectKeys(harness.r2Client, harness.r2Bucket, prefixes);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (r2Keys.length > 0) {
      await harness.r2Client
        .send(
          new DeleteObjectsCommand({
            Bucket: harness.r2Bucket,
            Delete: { Objects: r2Keys.map((Key) => ({ Key })) },
          }),
        )
        .catch(() => undefined);
    }
    harness.r2Client.destroy();
    await harness.stop();
  }, TEARDOWN_TIMEOUT_MS);

  it(`lands exactly ${EVENT_COUNT} rows after the FIRST delivery — count(*) = count(distinct event_id) = ${EVENT_COUNT}`, () => {
    expect(firstCounts.total).toBe(EVENT_COUNT);
    expect(firstCounts.distinct).toBe(EVENT_COUNT);
  });

  it(`[INV-8] the row count stays at ${EVENT_COUNT} after re-delivering ${DUPLICATE_COUNT} already-landed events — never doubles`, () => {
    expect(secondCounts.total).toBe(EVENT_COUNT);
    expect(secondCounts.distinct).toBe(EVENT_COUNT);
    expect(secondCounts.total).toBe(firstCounts.total);
  });

  it('every redelivered event_id was already present after the first drain (this is a genuine redelivery, not a fresh insert)', () => {
    const firstIds = new Set(firstFingerprints.keys());
    for (const event of duplicatedEvents) {
      expect(firstIds.has(event.event_id)).toBe(true);
    }
  });

  it("[INV-8] no row's occurred_at was rewritten by the redelivery — every event_id's fingerprint is unchanged", () => {
    expect(secondFingerprints.size).toBe(firstFingerprints.size);

    const firstEntries = [...firstFingerprints.entries()].sort(([a], [b]) => a.localeCompare(b));
    const secondEntries = [...secondFingerprints.entries()].sort(([a], [b]) => a.localeCompare(b));
    expect(secondEntries).toEqual(firstEntries);
  });
});
