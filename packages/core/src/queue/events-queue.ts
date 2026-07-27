import type { JobsOptions } from 'bullmq';
import { CaptureEventSchema } from '@posta/contracts';

// T3.1.1 [E3, S3.1] — the shared queue contract packages/core exists to
// hold. Before this file, the queue name (`EVENTS_QUEUE_NAME = 'events'`)
// was a literal known only to apps/api/src/redirect/enqueue.ts (T2.4.2) —
// there was nowhere else that needed it yet, since the worker's BullMQ
// consumer (T3.1.3+) hadn't been built. That was fine as long as exactly
// one side existed; it stops being fine the moment a second side
// (apps/worker) needs to agree on the same name. A name mismatch between
// producer and consumer is silent by construction — the producer
// enqueues happily, the consumer waits on an empty queue forever, and
// nothing errors — so `core` (the one package both `api` and `worker`
// import, per CLAUDE.md's dependency arrows) is where that agreement has
// to live: importing the wrong name becomes impossible to express, not
// merely a thing tests have to remember to check.

/** The queue apps/api enqueues onto (createEventsQueue,
 * apps/api/src/redirect/enqueue.ts) and apps/worker's consumer
 * (T3.1.3) drains. */
export const EVENTS_QUEUE = 'events';

/** The dead-letter queue a job is moved to once it either exhausts
 * EVENTS_JOB_OPTIONS.attempts (T3.1.5's DlqService, off the consumer's
 * `failed` handler) or fails eventJobSchema validation outright (T3.1.4
 * — a payload that can't parse will never parse on a retry, so it skips
 * straight here instead of burning all 5 attempts first). No producer or
 * consumer wires to this queue yet — this task only reserves the name so
 * both of those later tasks build against the same literal from day
 * one, the same way EVENTS_QUEUE already worked for the producer alone. */
export const EVENTS_DLQ_QUEUE = 'events-dlq';

// attempts/backoff are producer-side in BullMQ: they travel with the job
// (either from `defaultJobOptions` on the Queue, or passed explicitly to
// `.add()`, which overrides the queue's defaults per-call) and are read
// back out by the WORKER's own retry machinery whenever a job's processor
// throws — nothing about "5 attempts, exponential from 1000ms" needs to
// be configured a second time on the consumer side. Five attempts,
// exponential backoff starting at 1000ms works out to roughly 1s, 2s,
// 4s, 8s, 16s between attempts — long enough to ride out a brief
// Postgres/R2 blip (the retry stories in S3.3/S3.4) without the tight,
// constant-interval churn a flat backoff would produce under sustained
// failure.
//
// removeOnComplete: 1000 carries T2.4.2's own REMOVE_ON_COMPLETE forward
// unchanged: a completed job has already done its job (the worker wrote
// it to Postgres and R2, invariant 7) and carries little forensic value,
// so bounding the completed set is just "don't let it grow unbounded",
// not a retention policy anyone will lean on.
//
// removeOnFail: false supersedes T2.4.2's own bounded `REMOVE_ON_FAIL =
// 500` (apps/api/src/redirect/enqueue.ts's own history) — worth being
// explicit about WHY that flip is not a regression of the concern that
// bounded it in the first place. T2.4.2's own comment is correct that an
// un-TTL'd BullMQ job hash is never an eviction candidate under
// `volatile-lru` (spec §9), so leaving `removeOnFail` unbounded is a real
// memory hazard for the whole Redis instance IF nothing else ever drains
// the failed set. Under T2.4.2 alone, that was true — a failed job had
// nowhere else to go, so bounding it to 500 was the only available
// defense. From T3.1.4/T3.1.5 onward it stops being true: a job that
// exhausts its attempts is moved by DlqService's `failed`-event handler
// into EVENTS_DLQ_QUEUE — event-driven off BullMQ's own per-job `failed`
// event, not a periodic scan of the failed set — so in the healthy case
// the window a failed job actually sits in `EVENTS_QUEUE`'s own failed
// set is bounded by "how fast the worker's DLQ handler runs" (typically
// milliseconds), independent of this setting. Setting a small bound HERE
// instead would race that move against BullMQ's own best-effort eviction
// (which BullMQ's own docs describe as evaluated "every time a job
// fails", not on a timer) and risks losing a job's data before
// DlqService ever reads it — the opposite of what a dead-letter queue is
// for. The one case this genuinely leaves unbounded is the worker being
// down long enough for failures to pile up with nothing draining them —
// but in that scenario `EVENTS_QUEUE`'s WAITING set grows unbounded too,
// independent of this setting entirely; S3.1's own acceptance criteria
// ("DLQ depth is alertable and inspectable", a health endpoint reporting
// queue depth) is the intended defense for that scenario, not a
// retention bound on this queue.
export const EVENTS_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: 1000,
  removeOnFail: false,
};

/**
 * The BullMQ job payload schema. Identical to CaptureEventSchema
 * (packages/contracts/src/capture.ts, T2.3.1) — re-exported under a name
 * that describes its role in THIS context rather than its origin,
 * because there is no envelope: a job's `data` IS the CaptureEvent
 * (apps/api/src/redirect/enqueue.ts's own `Queue<CaptureEvent>` and
 * `queue.add(CAPTURE_JOB_NAME, payload)`, where `payload` is already the
 * whole captured event), so a wrapper object here would have nothing to
 * add and one more shape for the worker's consumer (T3.1.3) to unwrap
 * for no benefit.
 *
 * `.strict()` is inherited straight from CaptureEventSchema, which means
 * invariant 6 (the raw IP is never stored OR QUEUED) is enforced here
 * too, for free: a payload carrying an `ip` key fails this schema
 * exactly like it fails CaptureEventSchema, because it IS that schema,
 * not a copy of it that could drift.
 */
export const eventJobSchema: typeof CaptureEventSchema = CaptureEventSchema;
