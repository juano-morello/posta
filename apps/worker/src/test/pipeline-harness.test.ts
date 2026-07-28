import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { eventPrefixes } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPipelineHarness, type PipelineHarness } from './pipeline-harness';
import { fetchHealth } from './pipeline-harness-process';

// T3.5.1 [E3, S3.5] — the harness's own verify test, per this task's own
// dispatch brief verbatim: "pushes 10 events, drains, asserts 10 rows and
// one R2 object, and that stop() releases all three containers." This
// file is deliberately thin — almost everything it needs (boot, seed,
// spawn, push, drain, stop) already lives in pipeline-harness.ts and its
// three split-out modules; this file's own job is proving THAT surface
// actually does what it claims against the real stack, not re-deriving
// any of it.
//
// RED-PHASE PROOF ACTUALLY PERFORMED (not merely planned) — mirrors
// sigterm-flush.test.ts's own documented process: with this file
// otherwise unchanged, pipeline-harness.ts's own `push()` was temporarily
// edited to enqueue `n - 1` events instead of `n` (`Array.from({ length:
// n - 1 }, ...)`), and `pnpm test pipeline-harness.test.ts` was run
// against that sabotage. Result: a REAL assertion-level failure —
// "persists exactly 10 rows" failed with `expected 9 to be 10` (`toHaveLength`),
// not a timeout and not an import/module error; `drain()` itself still
// completed normally (9 events flush exactly as cleanly as 10 do), so the
// failure landed exactly where it should: the row-count assertion, not
// some unrelated hang. The sabotage was then reverted and
// pipeline-harness.ts restored to its real implementation, after which
// every assertion below passes. This confirms the assertions in this
// file actually detect the failure mode they exist to catch, not merely
// that the harness boots.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const EVENT_COUNT = 10;

/** Lists every object key under `prefixes` (one `ListObjectsV2Command`
 * per prefix — `eventPrefixes` returns all 24 hour-buckets for a UTC day,
 * only one of which this harness's own single, fixed `occurredAt`
 * actually writes into; the other 23 are expected to come back empty).
 * Mirrors reconciliation.test.ts's own `collectR2State`, narrowed to just
 * the key, since this file only needs a COUNT, not each object's parsed
 * NDJSON contents. */
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

describe('pipeline harness — push/drain/stop over real Redis, Postgres, and MinIO (T3.5.1)', () => {
  let harness: PipelineHarness;
  let pushedEvents: readonly CaptureEvent[];
  let persistedEventIds: string[];
  let r2Keys: string[];
  // Tracks whether the dedicated "stop() releases..." test already
  // called harness.stop() for real — afterAll's own call is a
  // best-effort safety net for whatever ran before it failed, mirroring
  // sigterm-flush.test.ts's own identical afterAll discipline, never a
  // second REQUIRED release.
  let stoppedByTest = false;

  beforeAll(async () => {
    harness = await startPipelineHarness();
    pushedEvents = await harness.push(EVENT_COUNT);
    await harness.drain();

    const rowsResult = await harness.pg.pool.query<{ event_id: string }>(
      'SELECT event_id FROM events WHERE tenant_id = $1',
      [harness.tenantId],
    );
    persistedEventIds = rowsResult.rows.map((row) => row.event_id);

    const prefixes = eventPrefixes(harness.occurredAt, harness.occurredAt);
    r2Keys = await listR2ObjectKeys(harness.r2Client, harness.r2Bucket, prefixes);
  });

  afterAll(async () => {
    if (r2Keys !== undefined && r2Keys.length > 0) {
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

    if (!stoppedByTest) {
      await harness.stop().catch(() => undefined);
    }
  });

  it(`persists exactly ${EVENT_COUNT} rows in Postgres, matching the pushed event_ids exactly`, () => {
    expect(persistedEventIds).toHaveLength(EVENT_COUNT);
    const expectedIds = pushedEvents.map((event) => event.event_id).sort();
    expect(persistedEventIds.sort()).toEqual(expectedIds);
  });

  it('writes exactly one R2 object for the single batch this push produced', () => {
    expect(r2Keys).toHaveLength(1);
  });

  it('stop() releases all three resources — the worker process, the Postgres testcontainer, and the Redis testcontainer', async () => {
    await harness.stop();
    stoppedByTest = true;

    // The worker process: nothing is listening on its port anymore, so a
    // further /health request rejects at the TCP level rather than
    // returning a stale 200/503.
    await expect(fetchHealth(harness.port)).rejects.toThrow();
    // Postgres: closeClientAndContainer already ended the pool, and pg's
    // own Pool rejects any further query with "Cannot use a pool after
    // calling end on it" — independent of whether the container itself
    // has finished being removed yet.
    await expect(harness.pg.pool.query('SELECT 1')).rejects.toThrow();
    // Redis: the ioredis client was quit(); any further command rejects
    // with "Connection is closed.", independent of container removal.
    await expect(harness.redis.client.ping()).rejects.toThrow();
  });
});
