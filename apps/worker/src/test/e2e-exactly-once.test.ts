import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { eventPrefixes, streamEventLog } from '@posta/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPipelineHarness, type PipelineHarness } from './pipeline-harness';

// T3.5.2 [E3, S3.5][INV-7][INV-8] — the epic's own "done when" condition,
// through the REAL queue rather than by calling flushBatch() directly:
// "10k events pushed, drained, then asserted at exactly 10k distinct rows
// and a matching event_id set across every R2 object." T3.4.7
// (reconciliation.test.ts) already proved this same bidirectional
// set-equality property by calling flushBatch() directly, in
// EVENT_BATCH_SIZE-capped chunks; that file's own header explains why that
// was the correct scope for THAT task. This file is the sibling the plan
// text names by contrast ("T3.4.7 tested the flush path; this tests the
// whole pipe including the consumer and the queue") — it goes through
// startPipelineHarness()'s real BullMQ producer, the real spawned worker
// child process, its real @Processor consumer, and its real accumulator,
// exactly the surface T3.5.1 built for this story to reuse.
//
// --- What this file reuses vs. re-derives ------------------------------
//
// The bidirectional event_id diff (`diffEventIdSets`) and the
// tenant-filtered R2 collection (`collectR2EventIds`, mirroring
// reconciliation.test.ts's own `collectR2State`) are duplicated here
// rather than imported: neither reconciliation.test.ts nor
// pipeline-harness.test.ts exports either helper, matching this epic's own
// established "small per-file test helpers, not a shared test utility
// module" convention (buildCaptureEvent, REAL_R2_CONFIG, ... are each
// already duplicated the same way across flush.test.ts, r2-put.test.ts,
// reconciliation.test.ts, throughput.bench.test.ts). `listR2ObjectKeys`
// mirrors pipeline-harness.test.ts's own identically-named helper, needed
// here (and not in reconciliation.test.ts) for the same reason
// pipeline-harness.test.ts needed it: going through the real queue/consumer
// means the accumulator mints its own `batchId` per flush, invisible to
// this test, so there is no `r2CreatedKeys` list to build incrementally the
// way flushBatch()-calling tests can — cleanup instead lists every key
// under this run's own hour prefixes, same as pipeline-harness.test.ts.
//
// --- Isolation strategy for this run's own fixture data ----------------
//
// One `startPipelineHarness()` call seeds exactly one tenant (and one
// link), and every assertion below scopes its Postgres query by
// `harness.tenantId` — the same discipline reconciliation.test.ts and
// throughput.bench.test.ts already use to stay correct even though this
// worktree's Postgres and MinIO are shared with concurrent sibling agents.
// On the R2 side, `harness.occurredAt` is a random instant inside
// pipeline-harness.ts's own claimed 2080-2087 window (picked fresh per
// harness instance), so `eventPrefixes(occurredAt, occurredAt)` lists only
// this run's own UTC day; `collectR2EventIds` additionally filters every
// streamed record by `tenant_id`, so even the vanishingly unlikely case of
// two concurrent runs picking the exact same day could not corrupt this
// file's own event_id sets.
//
// --- RED-PHASE PROOF ACTUALLY PERFORMED (not merely planned) -----------
//
// Mirrors reconciliation.test.ts's own documented process for the
// real-pipeline case (that file's header: "the real-path RED proof ...
// was performed manually during development ... It left no trace in this
// committed file, since the file's job is to assert the CORRECT behavior,
// not to carry a permanently-broken scenario"). Concretely, with this file
// otherwise unchanged: after `harness.drain()` and before collecting
// state, one extra line was temporarily added to `beforeAll` —
//   await harness.pg.pool.query(
//     'INSERT INTO events (event_id, occurred_at, tenant_id, link_id, slug) VALUES ($1, $2, $3, $4, $5)',
//     [newId(), harness.occurredAt, harness.tenantId, harness.linkId, harness.slug],
//   );
// — planting a genuine Postgres-only row with no R2 counterpart, the exact
// divergence invariant 7 exists to make impossible. `pnpm test
// e2e-exactly-once.test.ts` was run against that sabotage. Result: a REAL
// assertion-level failure, in two places at once — "lands exactly 10000
// rows in Postgres" failed with `expected 10001 to be 10000`, AND the
// bidirectional set-equality assertion failed with `idDiff.onlyInFirst`
// holding exactly the one planted event_id (`expected [ 'plantedId' ] to
// equal []`) — not a timeout and not an import/module error, and the
// failure landed in BOTH the count assertion and the direction-specific
// diff assertion, proving the diff genuinely discriminates a Postgres-only
// row the way a one-directional "is every R2 id in Postgres?" check would
// have missed entirely (`onlyInSecond` stayed empty throughout — R2 lost
// nothing). The planted line was then removed and the file restored to
// what is committed here, after which every assertion below passes.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const EVENT_COUNT = 10_000;
const SETUP_TIMEOUT_MS = 300_000;
const TEARDOWN_TIMEOUT_MS = 120_000;

interface EventIdDiff {
  readonly onlyInFirst: readonly string[];
  readonly onlyInSecond: readonly string[];
}

/** Mirrors reconciliation.test.ts's own `diffEventIdSets` (T3.4.7): the
 * bidirectional symmetric-difference check this task's own dispatch brief
 * requires — a one-directional "is every R2 id in Postgres?" check passes
 * while Postgres silently holds extra rows, exactly the divergence
 * invariant 7 exists to prevent. */
function diffEventIdSets(first: ReadonlySet<string>, second: ReadonlySet<string>): EventIdDiff {
  const onlyInFirst = [...first].filter((id) => !second.has(id));
  const onlyInSecond = [...second].filter((id) => !first.has(id));
  return { onlyInFirst, onlyInSecond };
}

/** Streams every NDJSON record across `prefixes` (via `streamEventLog`,
 * T3.6.1/T3.6.2's own composition), keeping only records for `tenantId` —
 * mirrors reconciliation.test.ts's own `collectR2State`, narrowed to just
 * the event_id set since this file compares identity, not enrichment
 * field values (reconciliation.test.ts already owns that comparison). */
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

/** Lists every object key under `prefixes` — mirrors
 * pipeline-harness.test.ts's own identically-named helper. Needed only for
 * this test's own cleanup: going through the real queue/consumer means the
 * accumulator mints its own `batchId` per flush (accumulator.ts), never
 * exposed to this test, so there is no incrementally-built key list the
 * way flushBatch()-calling tests (reconciliation.test.ts) can maintain. */
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

describe('10k events through the real queue land exactly once in Postgres and once in R2 (T3.5.2) [INV-7][INV-8]', () => {
  let harness: PipelineHarness;
  let totalCount: number;
  let distinctCount: number;
  let pgEventIds: Set<string>;
  let r2EventIds: Set<string>;
  let idDiff: EventIdDiff;
  let r2Keys: string[];

  beforeAll(async () => {
    harness = await startPipelineHarness();
    await harness.push(EVENT_COUNT);
    await harness.drain();

    const countResult = await harness.pg.pool.query<{ total: string; distinct_count: string }>(
      'SELECT COUNT(*) AS total, COUNT(DISTINCT event_id) AS distinct_count FROM events WHERE tenant_id = $1',
      [harness.tenantId],
    );
    const countRow = countResult.rows[0]!;
    totalCount = Number(countRow.total);
    distinctCount = Number(countRow.distinct_count);

    const idsResult = await harness.pg.pool.query<{ event_id: string }>(
      'SELECT event_id FROM events WHERE tenant_id = $1',
      [harness.tenantId],
    );
    pgEventIds = new Set(idsResult.rows.map((row) => row.event_id));

    const prefixes = eventPrefixes(harness.occurredAt, harness.occurredAt);
    r2EventIds = await collectR2EventIds(harness.r2Client, harness.r2Bucket, prefixes, harness.tenantId);
    r2Keys = await listR2ObjectKeys(harness.r2Client, harness.r2Bucket, prefixes);

    idDiff = diffEventIdSets(pgEventIds, r2EventIds);
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

  it(`lands exactly ${EVENT_COUNT} rows in Postgres — count(*) = count(distinct event_id) = ${EVENT_COUNT}`, () => {
    expect(totalCount).toBe(EVENT_COUNT);
    expect(distinctCount).toBe(EVENT_COUNT);
    expect(totalCount).toBe(distinctCount);
  });

  it(`lands exactly ${EVENT_COUNT} distinct event_ids in the R2 NDJSON log across the covered hour prefixes`, () => {
    expect(r2EventIds.size).toBe(EVENT_COUNT);
  });

  it('[INV-7][INV-8] the Postgres event_id set and the R2 event_id set are exactly equal — no extras in either direction', () => {
    expect(idDiff.onlyInFirst).toEqual([]); // Postgres holds nothing R2 lacks
    expect(idDiff.onlyInSecond).toEqual([]); // R2 holds nothing Postgres lacks
    expect([...pgEventIds].sort()).toEqual([...r2EventIds].sort());
  });
});
