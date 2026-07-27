import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EVENTS_DLQ_QUEUE } from '@posta/core';

// T3.1.5 [E3, S3.1] — the ONE writer EVENTS_DLQ_QUEUE has. Before this
// task, T3.1.4's EventsConsumer.routeToDlq() built a DLQ entry and wrote
// it straight to the queue, entirely inside events.consumer.ts, because
// T3.1.4 was the only reason a job could ever land in the DLQ. T3.1.5
// adds a SECOND reason (a job that decodes fine but exhausts every
// EVENTS_JOB_OPTIONS.attempts at sink.handle(), see
// events.consumer.ts's `onFailed()`), and with two producers of the same
// queue, "how to write a DLQ entry" stops being something
// events.consumer.ts alone should own — a second, independently
// maintained copy of that logic is exactly the kind of drift the global
// coding-style guidance warns about. DlqService is the consolidation:
// EventsConsumer.routeToDlq() (T3.1.4's path) and
// EventsConsumer.onFailed() (this task's path) both call THIS class's
// send(), and neither writes to EVENTS_DLQ_QUEUE any other way. See
// events.consumer.ts's own header for the full parallel-vs-consolidated
// design discussion this decision came out of.
//
// FLAT SHAPE, NOT A DISCRIMINATED UNION: EventsDlqJobPayload carries
// every field either reason might need (`issues`, `errorMessage`,
// `attemptsMade`) rather than two field sets that vary by `reason`. A
// discriminated union would be marginally more precise per reason, but
// every reader of a DLQ entry — an operator inspecting Redis by hand, or
// future replay tooling — would then have to branch on `reason` before
// knowing which fields even exist. A flat shape costs a few
// reason-irrelevant fields (`issues` is always `[]` for
// 'attempts-exhausted'; `errorMessage` restates, in prose, information
// 'schema-validation-failed' already carries structured in `issues`) in
// exchange for one shape every consumer of this queue can rely on
// unconditionally, regardless of `reason`.
//
// [security, invariant 6] `rawPayload` is stored EXACTLY as received,
// unredacted, for BOTH reasons — this is T3.1.4's own established
// decision (its own EventsDlqJobPayload doc comment, preserved here:
// "including whatever made it fail eventJobSchema (e.g. an
// invariant-6-violating ip key)"), carried forward unchanged rather than
// relitigated by this task. The DLQ is the quarantine invariant 6's
// "never stored or queued" is not about — it exists specifically to hold
// byte-for-byte evidence of a payload that violated an invariant, for
// diagnosis and replay. See events.consumer.ts's own header for why
// 'attempts-exhausted' can, in one narrow edge case, ALSO end up storing
// a payload that never actually passed eventJobSchema — and why that
// case reuses this exact same already-accepted behavior (by reporting
// `reason: 'schema-validation-failed'` instead) rather than inventing a
// new, un-reviewed redaction policy.

/** The job name every DLQ-routing `add()` call uses, regardless of
 * `reason` — mirrors apps/api/src/redirect/enqueue.ts's own
 * `CAPTURE_JOB_NAME` precedent (a named export rather than a literal
 * duplicated at every call site, including tests). */
export const EVENTS_DLQ_JOB_NAME = 'dead-letter';

/** One Zod validation issue, reduced to a JSON-serializable shape.
 * BullMQ persists job `data` as JSON in Redis, and a raw
 * `z.core.$ZodIssue` is not guaranteed to survive that round-trip
 * intact — some issue variants (e.g. `invalid_format`'s `pattern`) embed
 * a `RegExp`, which `JSON.stringify` silently collapses to `{}`. `path`
 * is stringified with `String()` per segment, never
 * `Array.prototype.join` directly (`PropertyKey[]` can contain a
 * `symbol`, and `[sym].join('.')` throws — `String(sym)` does not). */
export interface EventsDlqIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/** Reduces a Zod error's own `.issues` array to {@link EventsDlqIssue}'s
 * JSON-safe shape. Exported (not private) so events.consumer.ts's own
 * callers — both `routeToDlq()`'s primary path and `onFailed()`'s narrow
 * re-validation edge case — build the SAME shape from a `z.ZodError`
 * without a second copy of this reduction. */
export function toDlqIssues(
  issues: ReadonlyArray<{ readonly path: readonly PropertyKey[]; readonly message: string; readonly code: string }>,
): EventsDlqIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/** Why a job ended up here. A bare string union (not open-ended
 * `string`) so a typo in a future third reason fails to compile rather
 * than silently landing on the DLQ under a reason nothing else
 * recognizes. */
export type DlqReason = 'schema-validation-failed' | 'attempts-exhausted';

/**
 * `EVENTS_DLQ_QUEUE`'s own job payload — the record `DlqService.send()`
 * writes for every reason a job can land here. `rawPayload` is
 * deliberately `unknown`, never `CaptureEvent`: for
 * 'schema-validation-failed' this is exactly the payload that did NOT
 * decode as one; for 'attempts-exhausted' it IS decoded (a real
 * `CaptureEvent`, see events.consumer.ts's `onFailed()`) but is typed
 * `unknown` here anyway rather than narrowed per-reason, per this file's
 * own "flat shape" reasoning above.
 */
export interface EventsDlqJobPayload {
  readonly reason: DlqReason;
  readonly rawPayload: unknown;
  /** The underlying error's own `.message` — the sink's rejection reason
   * for 'attempts-exhausted', or a ZodError's own (JSON-ish) `.message`
   * for 'schema-validation-failed' (the structured, human-readable
   * equivalent lives in `issues` for that reason). */
  readonly errorMessage: string;
  /** Non-empty only for 'schema-validation-failed' — `[]` otherwise. See
   * this file's own "flat shape" reasoning for why this field exists
   * unconditionally rather than only on a narrower type. */
  readonly issues: readonly EventsDlqIssue[];
  /** BullMQ's own per-job attempt counter at the moment this entry was
   * written — 1 for 'schema-validation-failed' (that path never retries,
   * see events.consumer.ts's `routeToDlq()`), and
   * `EVENTS_JOB_OPTIONS.attempts` (5) for a normally-exhausted
   * 'attempts-exhausted' entry. */
  readonly attemptsMade: number;
  readonly originalJobId: string;
  /** ISO 8601, `new Date().toISOString()` — same wire format
   * `CaptureEvent.occurred_at` (packages/contracts/src/capture.ts) uses,
   * for the same reason: a `Date` value would not survive this job's own
   * BullMQ round-trip through Redis intact. */
  readonly failedAt: string;
}

/** The per-call metadata `send()` needs beyond `reason`/`payload`/`error`
 * — the fields that vary by call site rather than by reason. `issues` is
 * optional (only 'schema-validation-failed' callers have one to pass;
 * `send()` defaults it to `[]` otherwise, per this file's own "flat
 * shape" reasoning). */
export interface DlqSendMeta {
  readonly originalJobId: string;
  readonly attemptsMade: number;
  readonly issues?: readonly EventsDlqIssue[];
}

/**
 * The single writer + depth-reader for `EVENTS_DLQ_QUEUE`. `send()`
 * never inspects `reason` to decide HOW to write — every entry is built
 * the same way (this file's own "flat shape" reasoning) — so adding a
 * third reason in the future never requires touching this method, only
 * `DlqReason` and whatever new caller produces it.
 */
@Injectable()
export class DlqService {
  constructor(
    @InjectQueue(EVENTS_DLQ_QUEUE) private readonly dlqQueue: Queue<EventsDlqJobPayload>,
  ) {}

  async send(reason: DlqReason, payload: unknown, error: Error, meta: DlqSendMeta): Promise<void> {
    const entry: EventsDlqJobPayload = {
      reason,
      rawPayload: payload,
      errorMessage: error.message,
      issues: meta.issues ?? [],
      attemptsMade: meta.attemptsMade,
      originalJobId: meta.originalJobId,
      failedAt: new Date().toISOString(),
    };

    await this.dlqQueue.add(EVENTS_DLQ_JOB_NAME, entry);
  }

  /**
   * How many entries are currently sitting in the DLQ, across every
   * state a job could plausibly be in. No `@Processor` drains
   * `EVENTS_DLQ_QUEUE` yet (T3.1.5's own brief reserves draining for
   * later), so in practice every entry sits in 'waiting' forever —
   * 'active'/'delayed'/'paused' are counted defensively, for whenever
   * inspection/replay tooling (a later task) starts moving entries
   * through those states, not because they are reachable today. S3.1's
   * own acceptance criteria ("DLQ depth is alertable and inspectable")
   * is what this method exists for — a health endpoint wiring it up is a
   * later task's job, not this one's.
   */
  async depth(): Promise<number> {
    return this.dlqQueue.getJobCountByTypes('waiting', 'active', 'delayed', 'paused');
  }
}
