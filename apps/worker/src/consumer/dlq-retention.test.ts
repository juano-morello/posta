import 'reflect-metadata';
import { Queue } from 'bullmq';
import { EVENTS_DLQ_QUEUE } from '@posta/core';
import { startRedisContainer, type RedisContainerHandle } from '@posta/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DlqService, EVENTS_DLQ_JOB_NAME, type EventsDlqJobPayload } from './dlq.service';

// T3.7.10 [E3, S3.7][security][INV-6] — bounds EVENTS_DLQ_QUEUE's own
// retention. dlq.service.ts's own header records the "why": this
// project's Redis runs `volatile-lru` (CLAUDE.md's decision log), a
// deliberate choice specifically so a key with NO ttl — every BullMQ job
// key, including a DLQ entry's own — is NEVER evicted. Nothing drains
// EVENTS_DLQ_QUEUE (no `@Processor` is registered for it — dlq.service.ts's
// own `depth()` doc comment), so every entry sits in the 'wait' state
// forever, and without this task, Redis usage grows without bound.
//
// `removeOnComplete`/`removeOnFail` (BullMQ's usual per-job retention
// mechanism) only fire once a job reaches a TERMINAL state — 'completed'
// or 'failed' — which a DLQ entry, sitting in 'wait' forever, never
// reaches. `Queue.clean(grace, limit, 'wait')` is the mechanism that
// actually applies to the 'wait' state (verified against the installed
// bullmq@5.80.10 source, dist/esm/commands/includes/cleanList.lua: for
// the 'wait' set it compares each job's `timestamp` — its own submission
// time, absent any `finishedOn`/`processedOn`, which a never-processed
// DLQ entry never has — against `Date.now() - grace`), so that is what
// DlqService.send() now calls, opportunistically, after every successful
// `add()`, throttled so a burst of sends can't turn every write into its
// own Redis clean() scan.
//
// IDENTITY, NOT depth(): every "survives"/"is gone" assertion below checks
// specific job ids, never `service.depth()`. `Queue.clean`'s own grace
// window is computed as `Date.now() - grace` at call time (queue.js's own
// `clean()`) — at a sufficiently short grace, even the entry `send()` JUST
// wrote could itself be old enough to be swept (dlq.service.ts's own
// `cleanAgedEntriesThrottled` doc comment records this as accepted,
// expected behavior, not a bug). A `depth() === 1` check would be WRONG in
// that specific edge case (it would read 0), and is inherently less
// discriminating than checking which ids survived even when it happens to
// read the right number — this epic's own review history is why every
// test here checks ids.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A raw, hand-built DLQ entry — used to plant jobs directly via
 * `Queue.add()` (never through `DlqService.send()`) so this file controls
 * each planted job's own `timestamp` job option independently of
 * `Date.now()` at test-run time. Shape matches `EventsDlqJobPayload`
 * exactly; only `originalJobId` varies per call, which is enough for every
 * assertion below to identify a planted entry after the fact. */
function buildRawDlqEntry(originalJobId: string): EventsDlqJobPayload {
  return {
    reason: 'attempts-exhausted',
    rawPayload: { planted: originalJobId },
    redactedKeys: [],
    errorMessage: `planted aged entry for ${originalJobId}`,
    sqlstate: null,
    issues: [],
    attemptsMade: 1,
    originalJobId,
    failedAt: new Date().toISOString(),
  };
}

describe('DlqService — retention sweep (real BullMQ queue, testcontainers Redis)', () => {
  let redis: RedisContainerHandle;
  let queue: Queue<EventsDlqJobPayload> | undefined;

  beforeAll(async () => {
    redis = await startRedisContainer();
  });

  afterAll(async () => {
    await redis.stop();
  });

  afterEach(async () => {
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
      queue = undefined;
    }
  });

  function openQueue(): Queue<EventsDlqJobPayload> {
    const q = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    queue = q;
    return q;
  }

  it('send() cleans DLQ entries older than the retention window while the fresh entry survives — identity-checked by job id, never depth()', async () => {
    const q = openQueue();
    const retentionWindowMs = 60_000;
    const service = new DlqService(q, {
      retentionWindowMs,
      retentionCleanLimit: 100,
      cleanThrottleMs: 0,
    });

    // Comfortably past the retention window's own cutoff (grace 60s), not
    // a near-zero edge case — this test's own fresh entry MUST survive,
    // which a near-zero grace would not guarantee (see this file's own
    // header).
    const agedTimestamp = Date.now() - retentionWindowMs - 60_000;
    const agedJobs = await Promise.all(
      [0, 1, 2].map((i) =>
        q.add(EVENTS_DLQ_JOB_NAME, buildRawDlqEntry(`aged-${i}`), { timestamp: agedTimestamp }),
      ),
    );
    const agedIds = agedJobs.map((job) => job.id as string);
    expect(agedIds).toHaveLength(3);
    expect(agedIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);

    const beforeIds = new Set((await q.getJobs(['waiting'])).map((job) => job.id));

    await service.send('attempts-exhausted', {}, new Error('trigger clean'), {
      originalJobId: 'fresh-entry',
      attemptsMade: 1,
    });

    const afterJobs = await q.getJobs(['waiting']);
    const freshJob = afterJobs.find((job) => !beforeIds.has(job.id));
    expect(freshJob).toBeDefined();
    expect(freshJob?.data.originalJobId).toBe('fresh-entry');

    // The three aged entries are GONE — checked by id, not by depth().
    for (const agedId of agedIds) {
      expect(await q.getJob(agedId)).toBeUndefined();
    }
    // The fresh entry SURVIVES — checked by id, not by depth().
    expect(await q.getJob(freshJob?.id as string)).toBeDefined();
  });

  it('a retention window LONGER than every entry age cleans nothing — all four ids survive', async () => {
    const q = openQueue();
    const retentionWindowMs = 10 * 60_000;
    const service = new DlqService(q, {
      retentionWindowMs,
      retentionCleanLimit: 100,
      cleanThrottleMs: 0,
    });

    // 1 minute old — younger than the 10-minute retention window, so
    // `clean()`'s own cutoff (now - retentionWindowMs) never reaches them.
    const entryTimestamp = Date.now() - 60_000;
    const plantedJobs = await Promise.all(
      [0, 1, 2].map((i) =>
        q.add(EVENTS_DLQ_JOB_NAME, buildRawDlqEntry(`young-${i}`), { timestamp: entryTimestamp }),
      ),
    );
    const plantedIds = plantedJobs.map((job) => job.id as string);
    expect(plantedIds).toHaveLength(3);

    await service.send('attempts-exhausted', {}, new Error('trigger clean'), {
      originalJobId: 'fresh-entry-long-window',
      attemptsMade: 1,
    });

    const afterJobs = await q.getJobs(['waiting']);
    const freshJob = afterJobs.find((job) => job.data.originalJobId === 'fresh-entry-long-window');
    expect(freshJob).toBeDefined();

    // All FOUR ids survive — checked by id, not by depth().
    for (const id of plantedIds) {
      expect(await q.getJob(id)).toBeDefined();
    }
    expect(await q.getJob(freshJob?.id as string)).toBeDefined();
  });

  it('a burst of ten send() calls issues at most one clean() call', async () => {
    const q = openQueue();
    const cleanSpy = vi.spyOn(q, 'clean');
    const service = new DlqService(q, {
      retentionWindowMs: 60_000,
      retentionCleanLimit: 100,
      cleanThrottleMs: 60_000,
    });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        service.send('attempts-exhausted', {}, new Error(`burst-${i}`), {
          originalJobId: `burst-${i}`,
          attemptsMade: 1,
        }),
      ),
    );

    // Exactly one, not merely "at most one" left unproven at zero — zero
    // calls would ALSO satisfy a bare "at most one" assertion and would
    // silently mean the mechanism never engaged at all.
    expect(cleanSpy).toHaveBeenCalledTimes(1);
  });

  it('a clean() rejection is caught, logged exactly once, and never stops the entry from landing', async () => {
    const q = openQueue();
    const errorSpy = vi.fn();
    const service = new DlqService(q, {
      retentionWindowMs: 60_000,
      retentionCleanLimit: 100,
      cleanThrottleMs: 0,
      logger: { error: errorSpy },
    });

    // A narrow, single-method failure injection on the REAL testcontainers
    // Queue — mirrors r2-put.test.ts's own `vi.spyOn(r2Client, 'send')`
    // precedent for overriding one method's outcome on a real client
    // rather than hand-building a full fake. `add()` is left untouched, so
    // the entry's actual landing is proven against real BullMQ/Redis
    // behavior, not a stub.
    vi.spyOn(q, 'clean').mockRejectedValueOnce(new Error('ECONNRESET talking to redis mid-clean'));

    const beforeIds = new Set((await q.getJobs(['waiting'])).map((job) => job.id));

    await expect(
      service.send('attempts-exhausted', {}, new Error('trigger'), {
        originalJobId: 'survives-clean-rejection',
        attemptsMade: 1,
      }),
    ).resolves.toBeUndefined();

    const afterJobs = await q.getJobs(['waiting']);
    const landed = afterJobs.find((job) => !beforeIds.has(job.id));
    expect(landed).toBeDefined();
    expect(landed?.data.originalJobId).toBe('survives-clean-rejection');
    expect(await q.getJob(landed?.id as string)).toBeDefined();

    // Exactly once — never a silent catch, and never a retry storm either.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string, Record<string, unknown>?];
    expect(message).toContain('clean');
  });
});
