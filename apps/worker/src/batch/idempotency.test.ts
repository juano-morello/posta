import path from 'node:path';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  links,
  newId,
  runSqlMigrations,
  user,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from './flush';

// T3.3.5 [E3, S3.3][INV-8] — three concurrency/overlap scenarios BEYOND
// flush.test.ts's own T3.3.2 coverage ("the SAME batch, flushed twice,
// produces the SAME rows"). BullMQ is at-least-once, so overlap between
// batches — not exact duplication of one batch — is the ordinary case a
// real deployment hits on every redelivery, crash-recovery, or worker
// restart. This file exists to prove `ON CONFLICT (event_id, occurred_at)
// DO NOTHING` (packages/core/src/db/events.ts's `insertEventsBatch`, the
// one place that clause is declared) holds under three shapes flush.test.ts
// never exercises:
//
//   (a) partially overlapping batches — batch A carries events [0..9],
//       batch B carries events [5..14]; five events are common to both.
//   (b) the SAME event_id split across two separately-constructed batches
//       — read literally: this is what "split across two batches" most
//       sensibly means once you notice a batch is a set of DISTINCT
//       events (BatchAccumulator, T3.3.1, never inserts the same
//       event_id twice into ONE accumulator window) — so the only way
//       for one event_id to appear "split" across two batches is for
//       BullMQ's at-least-once redelivery to land the identical captured
//       event in two DIFFERENT accumulator windows, each flushed on its
//       own. In real operation those two windows carry byte-identical
//       CaptureEvent bodies (the same ULID is minted once, at capture —
//       invariant 8's own text). This suite's `visitor_hash` field
//       differs between the two versions ANYWAY, on purpose: with
//       otherwise-identical data there would be nothing to inspect in the
//       surviving row to prove WHICH write actually won, only that A row
//       exists. The differing field is a fixture-only device to make
//       "first write wins" independently verifiable, not a claim that
//       real redeliveries ever legitimately disagree about one event_id's
//       contents.
//   (c) concurrent flushes of overlapping sets, via `Promise.all` rather
//       than two sequential `await`s — `ON CONFLICT DO NOTHING` is a
//       property of a single Postgres statement, but two SEPARATE
//       multi-row INSERT statements racing for the same primary key is a
//       genuinely different code path (lock contention / commit
//       ordering) than the same two statements run one after the other.
//
// TEST LEVEL — real testcontainers Postgres (startPgContainer, the same
// harness flush.test.ts uses) and a real MinIO-backed R2 client, not
// mocks: this task is about proving actual `ON CONFLICT` behavior under
// actual concurrent INSERT statements, which a mock cannot demonstrate.
// `createFlushBatch`'s R2 PUT is incidental plumbing this file has no
// choice but to carry (flushBatch does both writes in one `Promise.all`,
// T3.4.4) — every batch below still gets a real, unique `batchId` so its
// R2 object doesn't collide with another scenario's, and every created
// key is deleted in `afterAll`, mirroring flush.test.ts's own cleanup.
//
// NOT going through BullMQ/the real queue at all — every scenario below
// calls `flushBatch` directly against fixture batches, bypassing
// EVENTS_QUEUE entirely. The known job-id-collision hazard from
// `queue.obliterate({ force: true })` resetting BullMQ's auto-increment
// counter (which bit T3.1.5) does not apply to this file for exactly that
// reason — recorded here so a future reader doesn't have to re-derive it.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

/** A fully-signalled CaptureEvent, every field defaulted to `null` except
 * the required identity/context frame — mirrors flush.test.ts's own
 * `buildCaptureEvent` (kept as a separate copy here, not imported: this
 * file's fixtures need `visitor_hash` to vary per-call in a way that file's
 * doesn't, and duplicating a ten-line builder is cheaper than adding a
 * cross-file dependency between two sibling test suites). */
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

interface EventRowSnapshot {
  readonly event_id: string;
  readonly visitor_hash: string | null;
}

/** Reads back every row (of the given `eventIds`) that actually exists in
 * `events`, via the raw pool — never drizzle's query builder, matching
 * flush.ts's own "apps/worker never imports drizzle-orm directly"
 * boundary (see that file's header) and flush.test.ts's identical
 * precedent. `event_id = ANY($1::text[])` rather than `IN (...)`: the
 * event_id list's length varies per scenario, and `ANY` over one array
 * parameter avoids building a variadic placeholder string by hand. */
async function fetchEventRows(
  handle: PgContainerHandle,
  eventIds: readonly string[],
): Promise<EventRowSnapshot[]> {
  const result = await handle.pool.query<EventRowSnapshot>(
    'SELECT event_id, visitor_hash FROM events WHERE event_id = ANY($1::text[])',
    [eventIds],
  );
  return result.rows;
}

describe('flushBatch idempotency under overlapping and interleaved batches (T3.3.5) [INV-8]', () => {
  let handle: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  let flushBatch: FlushBatch;
  let tenantId: string;
  let linkId: string;
  const r2CreatedKeys: string[] = [];

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantId = await seedTenant(handle);
    linkId = await seedLink(handle, tenantId, 'promo', 'https://example.com/promo');

    flushBatch = createFlushBatch({ db: handle.db, r2Client, r2Bucket: REAL_R2_CONFIG.bucket });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await Promise.all(
        r2CreatedKeys.splice(0).map((key) =>
          r2Client.send(new DeleteObjectCommand({ Bucket: REAL_R2_CONFIG.bucket, Key: key })),
        ),
      );
    }
    r2Client.destroy();
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  /** Records a batch's R2 key for `afterAll` cleanup — every scenario
   * below flushes with its own explicit, unique `batchId`, so every
   * flush produces exactly one object to track (never shared, unlike
   * flush.test.ts's "same batchId twice" case). */
  function trackBatch(batchId: string, firstOccurredAt: string): void {
    r2CreatedKeys.push(eventBatchKey(batchId, firstOccurredAt));
  }

  describe('scenario (a): partially overlapping batches', () => {
    it('final row count equals the distinct event_id count across both batches, not the sum of their sizes', async () => {
      // 15 distinct events; batch A = [0..9], batch B = [5..14] — events
      // 5-9 are the LITERAL SAME CaptureEvent objects in both arrays
      // (same event_id AND same occurred_at, exactly what a genuine
      // redelivery of the same captured event looks like).
      const events = Array.from({ length: 15 }, () =>
        buildCaptureEvent({ tenant_id: tenantId, link_id: linkId }),
      );
      const batchA = events.slice(0, 10);
      const batchB = events.slice(5, 15);
      const eventIds = events.map((event) => event.event_id);

      const batchIdA = newId();
      const batchIdB = newId();
      trackBatch(batchIdA, batchA[0]!.occurred_at);
      trackBatch(batchIdB, batchB[0]!.occurred_at);

      await flushBatch(batchA, batchIdA);
      await flushBatch(batchB, batchIdB);

      const rows = await fetchEventRows(handle, eventIds);
      expect(rows).toHaveLength(15);
      expect(new Set(rows.map((row) => row.event_id)).size).toBe(15);
    });
  });

  describe('scenario (b): the same event_id split across two separately-constructed batches', () => {
    it('the surviving row for the duplicated event_id is the FIRST-written version, not the second', async () => {
      // Same event_id AND occurred_at (the actual ON CONFLICT target) in
      // both versions — visitor_hash is the ONLY field that differs, a
      // fixture-only marker (see this file's own header) letting the test
      // tell the two candidate rows apart after the fact.
      const sharedEventId = newId();
      const sharedOccurredAt = new Date().toISOString();

      const firstVersion = buildCaptureEvent({
        event_id: sharedEventId,
        occurred_at: sharedOccurredAt,
        tenant_id: tenantId,
        link_id: linkId,
        visitor_hash: 'first-batch-version',
      });
      const secondVersion = buildCaptureEvent({
        event_id: sharedEventId,
        occurred_at: sharedOccurredAt,
        tenant_id: tenantId,
        link_id: linkId,
        visitor_hash: 'second-batch-version',
      });

      const batch1 = [
        firstVersion,
        ...Array.from({ length: 4 }, () => buildCaptureEvent({ tenant_id: tenantId, link_id: linkId })),
      ];
      const batch2 = [
        secondVersion,
        ...Array.from({ length: 4 }, () => buildCaptureEvent({ tenant_id: tenantId, link_id: linkId })),
      ];
      const distinctEventIds = [...new Set([...batch1, ...batch2].map((event) => event.event_id))];

      const batchId1 = newId();
      const batchId2 = newId();
      trackBatch(batchId1, batch1[0]!.occurred_at);
      trackBatch(batchId2, batch2[0]!.occurred_at);

      // Sequential, deliberately — this is what makes "first-written"
      // unambiguous: batch1's INSERT fully commits before batch2's ever
      // starts, so there is exactly one correct answer for which version
      // ON CONFLICT DO NOTHING must keep.
      await flushBatch(batch1, batchId1);
      await flushBatch(batch2, batchId2);

      const rows = await fetchEventRows(handle, distinctEventIds);
      expect(rows).toHaveLength(9); // 5 + 5 batch members, minus 1 duplicate event_id

      const survivingRow = rows.find((row) => row.event_id === sharedEventId);
      expect(survivingRow?.visitor_hash).toBe('first-batch-version');
    });
  });

  describe('scenario (c): concurrent flushes of overlapping sets, via Promise.all', () => {
    it('resolves both flushes without error and leaves exactly one row per distinct event_id', async () => {
      const events = Array.from({ length: 15 }, () =>
        buildCaptureEvent({ tenant_id: tenantId, link_id: linkId }),
      );
      const batchC1 = events.slice(0, 10);
      const batchC2 = events.slice(5, 15);
      const eventIds = events.map((event) => event.event_id);

      const batchIdC1 = newId();
      const batchIdC2 = newId();
      trackBatch(batchIdC1, batchC1[0]!.occurred_at);
      trackBatch(batchIdC2, batchC2[0]!.occurred_at);

      // Genuinely concurrent: both flushBatch calls' Postgres INSERT (and
      // R2 PUT) are in flight at once, racing for the same primary key on
      // the five overlapping event_ids — not sequenced by two awaits the
      // way scenario (a) above is. This is the code path that actually
      // stresses ON CONFLICT DO NOTHING against real concurrent INSERT
      // statements, which is the plan's own stated reason this scenario
      // exists ("BullMQ is at-least-once, so overlap is the normal case").
      await Promise.all([flushBatch(batchC1, batchIdC1), flushBatch(batchC2, batchIdC2)]);

      const rows = await fetchEventRows(handle, eventIds);
      expect(rows).toHaveLength(15);
      expect(new Set(rows.map((row) => row.event_id)).size).toBe(15);
    });

    it('the surviving row for a concurrently-duplicated event_id is exactly one whole version, never a corrupted mix of both and never neither', async () => {
      // Unlike scenario (b), which sequential `await`s make deterministic,
      // WHICH of two genuinely concurrent commits wins a real primary-key
      // race is legitimately decided by Postgres, not by this test —
      // asserting a SPECIFIC winner here would be asserting something
      // Promise.all does not actually guarantee. What real concurrency
      // DOES guarantee, and what this asserts instead: exactly one row
      // exists, and its value is one complete, uncorrupted candidate —
      // never a mix of both inserts' columns, never absent.
      const sharedEventId = newId();
      const sharedOccurredAt = new Date().toISOString();

      const versionA = buildCaptureEvent({
        event_id: sharedEventId,
        occurred_at: sharedOccurredAt,
        tenant_id: tenantId,
        link_id: linkId,
        visitor_hash: 'concurrent-version-a',
      });
      const versionB = buildCaptureEvent({
        event_id: sharedEventId,
        occurred_at: sharedOccurredAt,
        tenant_id: tenantId,
        link_id: linkId,
        visitor_hash: 'concurrent-version-b',
      });

      const batchIdA = newId();
      const batchIdB = newId();
      trackBatch(batchIdA, versionA.occurred_at);
      trackBatch(batchIdB, versionB.occurred_at);

      await Promise.all([flushBatch([versionA], batchIdA), flushBatch([versionB], batchIdB)]);

      const rows = await fetchEventRows(handle, [sharedEventId]);
      expect(rows).toHaveLength(1);
      expect(['concurrent-version-a', 'concurrent-version-b']).toContain(rows[0]?.visitor_hash);
    });
  });
});
