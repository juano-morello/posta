import { DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../ulid';
import { createR2Client, type R2ClientConfig } from './client';
import { eventBatchKey, eventPrefixes } from './keys';
import { serializeBatch, streamEventLog, type LoggedEvent } from './ndjson';

/**
 * Forces a V8 major GC without requiring the process to be launched with
 * `--expose-gc` (this repo's own `pnpm test` never passes that flag, and
 * this test has no reason to demand every future test run add it). Node's
 * RSS metric is OS-level resident memory, which V8 does not eagerly return
 * to the OS the instant an object becomes unreachable — normal heap growth
 * from 50,000 transient JSON.parse()/string allocations produces a much
 * higher RSS reading than the reader's actual LIVE memory footprint at any
 * given instant, for ANY implementation, buffered or not. Forcing a
 * collection before each sample is what turns "peak RSS" into a signal
 * about retained references (a real leak/buffer) rather than noise about
 * when V8 happens to feel like collecting — the standard technique for
 * this class of test.
 */
function forceGc(): void {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  setFlagsFromString('--no-expose-gc');
  gc();
}

// --- On the 128 MB budget: measured as GROWTH, not an absolute ceiling ---
//
// Empirically verified (against this real MinIO, in this Vitest worker,
// with the exact @aws-sdk/client-s3 version this repo pins): loading
// @aws-sdk/client-s3 and issuing ~1,000 real HTTP round trips (500 PUTs to
// seed the fixture, 1 LIST, 500 GETs to read it back) grows V8's own heap
// (`heapTotal`) from a ~20 MB baseline to 80-150 MB, and process RSS
// alongside it to 150-280 MB — even with forceGc() called before every
// sample, and even for a DELIBERATELY BAD reader rewritten to buffer every
// object whole via `.transformToString()` into one big array. That
// absolute floor is V8's heap-growth response to sustained allocation
// pressure from the SDK's own middleware stack (retry logic, XML
// (de)serialization, ...) — a property of the SDK and this Node/V8
// version, not of streamEventLog. V8 only fully re-tightens heap sizing
// via startup flags (`--max-old-space-size`), which cannot be applied to
// an already-running process, so a same-process absolute-RSS assertion
// cannot isolate the reader's own behavior from that fixed cost.
//
// What DOES isolate it, confirmed against the same bad-reader comparison:
// heapUsed (LIVE bytes, not allocated capacity) stayed flat at ~13-15 MB
// across THREE full 50,000-record passes (150,000 records total) for the
// real streamEventLog, and grew to ~38 MB for the buffering rewrite reading
// the SAME 50,000 records once — a ~24 MB difference entirely explained by
// "held 50,000 parsed records at once" vs. "held one line at a time". RSS
// measured as GROWTH from an immediately-pre-drain (forced-GC'd) baseline
// tracks that same signal, just in absolute bytes: growth stayed within
// ~10 MB per additional 50,000-record pass for the real reader. Both
// assertions below keep the plan's own "128 MB" figure as the literal
// budget, applied to GROWTH DURING THE DRAIN rather than the process's
// already-elevated absolute RSS — the number that is actually well-formed
// to assert on in a shared test-runner process, and the one that would
// genuinely trip for a reader that scales with the range instead of
// holding one record at a time.
const RSS_GROWTH_BUDGET_BYTES = 128 * 1024 * 1024;
const HEAP_USED_GROWTH_BUDGET_BYTES = 16 * 1024 * 1024;

// T3.6.2 (E3, S3.6) [INV-7] — a REAL integration test against the compose
// MinIO (T0.4.4), never a mock: this task's own verify text is "writes 500
// objects...to MinIO", and a mocked S3Client cannot prove the memory
// behavior this test exists to check (see the RSS assertion below).
//
// This is also the one place in the suite that proves streamEventLog(),
// eventPrefixes() (T3.6.1) and eventBatchKey()/serializeBatch() (T3.4.2/.3)
// compose correctly end to end — the exact composition T3.6.3's replay
// driver will reuse.
const REAL_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

const OBJECT_COUNT = 500;
const LINES_PER_OBJECT = 100;
const TOTAL_RECORDS = OBJECT_COUNT * LINES_PER_OBJECT;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// A fixture UTC instant, not "today" — picked at random from a ~8-year
// window far in the future so two concurrent runs of this file (this repo
// is worked from several worktrees against the SAME shared MinIO bucket)
// land on different `events/dt=.../hour=.../` partitions and never collide
// on the SAME keys. Confined to a single hour bucket on purpose: all 500
// objects share one `eventPrefixes` prefix, which both exercises pagination
// (500 keys is still one ListObjectsV2 page under the 1000-key max) and
// keeps eventPrefixes' OTHER 23 hour-prefixes for the day genuinely empty,
// proving the reader tolerates an empty prefix rather than erroring on one.
const FIXTURE_OCCURRED_AT = new Date(
  Date.UTC(2033, 0, 1) + Math.floor(Math.random() * 3000) * ONE_DAY_MS + 3 * 60 * 60 * 1000,
).toISOString();

const FIXTURE_TENANT_ID = newId();
const FIXTURE_LINK_ID = newId();

/** A realistic, fully-populated LoggedEvent. `event_id` is deliberately the
 * ONLY varying field across the 50,000 built below — everything else is
 * fixed, since this test's assertions care about count and ORDER, not
 * per-field content (that's ndjson.test.ts's job for serializeBatch itself,
 * already covered there). */
function buildTestEvent(): LoggedEvent {
  return {
    event_id: newId(),
    occurred_at: FIXTURE_OCCURRED_AT,
    tenant_id: FIXTURE_TENANT_ID,
    link_id: FIXTURE_LINK_ID,
    slug: 'promo',
    visitor_hash: null,
    http_method: 'GET',
    user_agent: 'Mozilla/5.0 (stream-read.test.ts fixture)',
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
    country: 'AR',
    asn: null,
    browser: 'Chrome',
    browser_version: '125.0.0.0',
    os: 'Windows',
    device_type: 'desktop',
    source_platform: 'directo',
    is_in_app: false,
    dest_host: 'example.com',
  };
}

interface FixtureObject {
  readonly key: string;
  readonly body: string;
}

/**
 * Builds all 500 objects' NDJSON bodies. `event_id` (and each object's own
 * `batchId`) come from `newId()` — a SINGLE process-wide monotonic
 * generator (packages/core/src/ulid.ts) — called strictly in the exact
 * nested order this function iterates: batchId for object 0, then its 100
 * event_ids, then batchId for object 1, ... This guarantees the ENTIRE
 * 50,000-value sequence of ids strictly increases in generation order, and
 * since eventBatchKey()'s key is a direct function of batchId, object KEY
 * order matches that same sequence too. The test's own ordering assertion
 * below relies on exactly this: object keys sort (ListObjectsV2's own
 * lexicographic guarantee) in the same order the events inside them were
 * generated, so a strictly-increasing event_id across the whole streamed
 * output is proof the reader preserved both cross-object (key) order and
 * within-object (line) order — "ordering by key" from a caller who only
 * sees the yielded records, never the source key itself (streamEventLog
 * yields the bare LoggedEvent, unreshaped, so there is no other ordering
 * signal a caller could check).
 */
function buildFixtureObjects(): FixtureObject[] {
  const objects: FixtureObject[] = [];

  for (let objectIndex = 0; objectIndex < OBJECT_COUNT; objectIndex++) {
    const batchId = newId();
    const events: LoggedEvent[] = [];

    for (let line = 0; line < LINES_PER_OBJECT; line++) {
      events.push(buildTestEvent());
    }

    objects.push({
      key: eventBatchKey(batchId, FIXTURE_OCCURRED_AT),
      body: serializeBatch(events),
    });
  }

  return objects;
}

/** Minimal fixed-concurrency map — 500 sequential round trips to local
 * MinIO would needlessly slow this test down, and 500 fully-concurrent PUTs
 * would open more sockets than the S3Client's default agent pool. Test-only
 * complexity; not exported. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await fn(items[currentIndex]!);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

let fixtureKeys: string[] = [];

afterAll(async () => {
  if (fixtureKeys.length === 0) return;
  const client = createR2Client(REAL_CONFIG);
  await client.send(
    new DeleteObjectsCommand({
      Bucket: REAL_CONFIG.bucket,
      Delete: { Objects: fixtureKeys.map((key) => ({ Key: key })) },
    }),
  );
  client.destroy();
});

describe('streamEventLog (T3.6.2)', () => {
  it(
    'streams all 50,000 records across 500 objects, in key order, within a 128 MB growth budget',
    async () => {
      const client = createR2Client(REAL_CONFIG);
      const objects = buildFixtureObjects();
      fixtureKeys = objects.map((object) => object.key);

      await mapWithConcurrency(objects, 25, (object) =>
        client.send(
          new PutObjectCommand({
            Bucket: REAL_CONFIG.bucket,
            Key: object.key,
            Body: object.body,
            ContentType: 'application/x-ndjson',
          }),
        ),
      );

      const prefixes = eventPrefixes(FIXTURE_OCCURRED_AT, FIXTURE_OCCURRED_AT);
      expect(prefixes).toHaveLength(24);

      // Memory is sampled ONLY across the drain below, deliberately
      // excluding the write phase above (500 concurrent PUTs, building
      // 50,000 in-memory fixture events) — that setup cost is this TEST's
      // own fixture-building overhead, not the reader's, and folding it
      // into the budget would make the assertion about this test's fixture
      // rather than about streamEventLog()'s own memory behavior. Both
      // budgets below are GROWTH from this pre-drain, forced-GC'd baseline
      // — see this file's own header comment on RSS_GROWTH_BUDGET_BYTES for
      // why growth, not the process's already-elevated absolute RSS, is
      // what's actually well-formed to assert here.
      forceGc();
      const baselineRss = process.memoryUsage().rss;
      const baselineHeapUsed = process.memoryUsage().heapUsed;
      let peakRssBytes = baselineRss;
      let peakHeapUsedBytes = baselineHeapUsed;
      const memorySampler = setInterval(() => {
        forceGc();
        const usage = process.memoryUsage();
        if (usage.rss > peakRssBytes) peakRssBytes = usage.rss;
        if (usage.heapUsed > peakHeapUsedBytes) peakHeapUsedBytes = usage.heapUsed;
      }, 20);

      let count = 0;
      let previousEventId: string | null = null;
      let outOfOrder = false;

      try {
        for await (const record of streamEventLog(client, REAL_CONFIG.bucket, prefixes)) {
          count += 1;
          if (previousEventId !== null && !(record.event_id > previousEventId)) {
            outOfOrder = true;
          }
          previousEventId = record.event_id;
        }
      } finally {
        clearInterval(memorySampler);
      }

      forceGc();
      const finalUsage = process.memoryUsage();
      if (finalUsage.rss > peakRssBytes) peakRssBytes = finalUsage.rss;
      if (finalUsage.heapUsed > peakHeapUsedBytes) peakHeapUsedBytes = finalUsage.heapUsed;

      client.destroy();

      expect(count).toBe(TOTAL_RECORDS);
      expect(outOfOrder).toBe(false);
      expect(peakRssBytes - baselineRss).toBeLessThan(RSS_GROWTH_BUDGET_BYTES);
      expect(peakHeapUsedBytes - baselineHeapUsed).toBeLessThan(HEAP_USED_GROWTH_BUDGET_BYTES);
    },
    120_000,
  );

  it('yields nothing, without throwing, for a prefix range with no matching objects', async () => {
    const client = createR2Client(REAL_CONFIG);
    const emptyDayInstant = new Date(
      Date.UTC(2034, 5, 15, 3, 0, 0),
    ).toISOString();

    const records: LoggedEvent[] = [];
    for await (const record of streamEventLog(
      client,
      REAL_CONFIG.bucket,
      eventPrefixes(emptyDayInstant, emptyDayInstant),
    )) {
      records.push(record);
    }

    client.destroy();
    expect(records).toHaveLength(0);
  });
});
