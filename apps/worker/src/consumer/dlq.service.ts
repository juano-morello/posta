import { Injectable, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EVENTS_DLQ_QUEUE } from '@posta/core';
import { redactCredentialsFromMessage, redactForbiddenKeys } from '@posta/contracts';
import { extractSqlState } from '../batch/classify-flush-error';

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
// [T3.3.4] `sqlstate` follows the SAME flat-shape reasoning: it is
// `null` for 'schema-validation-failed' (a ZodError has no SQLSTATE) and
// for 'attempts-exhausted' (a sink error is not necessarily a database
// error at all), non-null for 'flush-poison' whenever the underlying
// Error came from `pg`/`node-postgres` (whose `DatabaseError` sets
// `.code` to the real SQLSTATE) — `send()` derives it structurally from
// `error`'s own `.code` property, never by importing `pg`'s error class
// (this file has no `pg` dependency, and doesn't need one to read one
// property off a duck-typed shape).
//
// [T3.4.5] A FOURTH reason, 'r2-put-failed' (see below), was added by
// apps/worker/src/batch/r2-retry.ts's own
// `sendR2PutFailureToDlq`, via the SAME `PoisonDlqSink`-shaped narrow
// interface (`R2BatchDlqSink`) split-retry.ts's own header already
// established the precedent for, so this file gained no new dependency
// from it. THE JUDGMENT CALL this task's own brief asked to be recorded
// here: neither existing reason fits. 'attempts-exhausted' names a
// BullMQ job's own per-job `sink.handle()` retry budget running out
// (events.consumer.ts's `onFailed()`) — a completely different retry
// domain (per-job, BullMQ-driven) from r2-retry.ts's own per-batch,
// custom-backoff R2 PUT retry, and conflating the two would make an
// operator's runbook ambiguous ("is this a stuck sink or an R2 outage?")
// for no benefit. 'flush-poison' names ONE event isolated by
// split-retry.ts's binary search because a specific row, and only that
// row, would not commit to Postgres — it always carries a real SQLSTATE
// and always has exactly one event as `rawPayload`. An R2 PUT failure is
// the opposite shape: the WHOLE batch's single object write failed
// (nothing about WHICH event, if any, was at fault), there is no
// SQLSTATE (`sqlstate` stays `null` for this reason, same as the first
// two), and `rawPayload` holds the ENTIRE batch as an array, not one
// event — "payload intact", per this task's own brief. A fourth,
// distinct `DlqReason` keeps that shape difference visible to any reader
// of a DLQ entry, rather than forcing them to infer it from `rawPayload`
// being an array instead of an object. Named 'r2-put-failed', not
// 'r2-put-exhausted': unlike 'attempts-exhausted' (which only ever fires
// after the full BullMQ attempt budget is spent), an R2 PUT can ALSO
// reach the DLQ after a SINGLE attempt — a non-retryable 403/404 never
// spends any retry budget at all (r2-retry.ts's own
// `classifyR2Error`) — so "exhausted" would misdescribe that case.
// 'r2-put-failed' covers both terminal outcomes honestly.
//
// [security, invariant 6][T3.7.9 — AMENDS the decision this section used
// to record] `rawPayload` is NO LONGER stored exactly as received.
// T3.1.4's original decision (quoted here until this task, verbatim:
// "rawPayload is stored EXACTLY as received, unredacted... including
// whatever made it fail eventJobSchema (e.g. an invariant-6-violating ip
// key)") reasoned that the DLQ is the quarantine invariant 6's "never
// stored or queued" is not about, since it holds byte-for-byte evidence
// of a payload that violated an invariant, for diagnosis and replay. That
// reasoning still holds for a DLQ entry itself — but "byte-for-byte
// evidence" and "the raw IP sitting unredacted in Redis" turn out not to
// be the same requirement, and this task closes the gap between them.
//
// Every entry now runs through `redactForbiddenKeys` (packages/contracts,
// T3.7.8) before it is written: `send()`, below, stores
// `redactForbiddenKeys(payload).value` as `rawPayload`, and its own
// `redactedKeys` as the new `EventsDlqJobPayload.redactedKeys` field, so a
// DLQ operator can still SEE that a forbidden key was present, and at
// exactly which path, without the invariant-6-violating value itself
// sitting in Redis. This is unconditional, for every `reason` — `send()`
// still never branches on `reason` to decide HOW to write an entry (this
// file's own "flat shape" reasoning, above). For a 'schema-validation-
// failed' entry (pre-validation `job.data`, the ONLY payload shape that
// can structurally carry a forbidden key — `CaptureEventSchema` is
// `.strict()`, so nothing that passed it ever could) this is a real
// redaction; for every other reason, whose payload already IS (or is
// built from) a valid `CaptureEvent`, `redactForbiddenKeys` naturally
// returns `redactedKeys: []` and an unchanged value — no per-reason
// special-casing needed, this falls out of calling the same function on
// every entry regardless of `reason`. See events.consumer.ts's own header
// for why 'attempts-exhausted' can, in one narrow edge case, ALSO end up
// storing a payload that never actually passed eventJobSchema — and why
// that case reports `reason: 'schema-validation-failed'` instead of
// inventing a separate redaction policy for it: it goes through this
// exact same unconditional redaction pass, via the exact same reason.

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
 * recognizes.
 *
 * [T3.3.4] `'flush-poison'` is the THIRD reason, added by that task:
 * `apps/worker/src/batch/split-retry.ts`'s `retryWithSplit` (T3.3.3)
 * isolates a single event that still fails after binary-splitting a
 * batch down to size one — that event never came from a single BullMQ
 * job the way the other two reasons' payloads did, it came from a
 * Postgres-rejected sub-batch. `sendPoisonEventsToDlq`
 * (split-retry.ts) is the one caller that produces this reason, via the
 * `PoisonDlqSink` interface that file defines to avoid importing this
 * class directly — see that file's own header for why.
 *
 * [T3.4.5] `'r2-put-failed'` is the FOURTH reason: `apps/worker/src/
 * batch/r2-retry.ts`'s `putR2BatchWithRetry` routes an ENTIRE batch here
 * (as one entry, `rawPayload` an ARRAY of events — not one entry per
 * event, unlike 'flush-poison') once its R2 PUT either exhausts every
 * retry attempt or hits a non-retryable error (403/404/...) on the very
 * first one. See this file's own header, above, for why this needed a
 * new reason rather than reusing 'attempts-exhausted' or 'flush-poison',
 * and why it is named '...-failed' rather than '...-exhausted'. */
export type DlqReason = 'schema-validation-failed' | 'attempts-exhausted' | 'flush-poison' | 'r2-put-failed';

/**
 * `EVENTS_DLQ_QUEUE`'s own job payload — the record `DlqService.send()`
 * writes for every reason a job can land here. `rawPayload` is
 * deliberately `unknown`, never `CaptureEvent`: for
 * 'schema-validation-failed' this is exactly the payload that did NOT
 * decode as one; for 'attempts-exhausted' it IS decoded (a real
 * `CaptureEvent`, see events.consumer.ts's `onFailed()`) but is typed
 * `unknown` here anyway rather than narrowed per-reason, per this file's
 * own "flat shape" reasoning above. [T3.4.5] For 'r2-put-failed' it is a
 * `readonly CaptureEvent[]` — the WHOLE failed batch, not a single event
 * — see this file's own header for why that reason's payload shape is
 * deliberately different from every other reason's.
 *
 * [T3.7.9][security][INV-6] `rawPayload` is `redactForbiddenKeys`'s own
 * `.value`, not the raw `payload` argument `send()` received — see this
 * file's own header, above, for why that changed. For any payload that
 * cannot structurally carry a forbidden key (every reason except
 * 'schema-validation-failed'), this is unconditionally byte-for-byte
 * identical to what was passed in.
 */
export interface EventsDlqJobPayload {
  readonly reason: DlqReason;
  readonly rawPayload: unknown;
  /** [T3.7.9][security][INV-6] The `redactedKeys` half of
   * `redactForbiddenKeys(payload)` — the property-access-style path (see
   * that function's own JSDoc, packages/contracts/src/redact.ts) of every
   * key in `rawPayload` whose value was replaced by
   * `SECRET_REDACTION_PLACEHOLDER`. `[]` for every reason whose payload
   * cannot structurally carry a forbidden key (a real `CaptureEvent`
   * already passed `CaptureEventSchema`'s `.strict()` check) — non-empty
   * only when a 'schema-validation-failed' entry's pre-validation payload
   * actually smuggled one. Lets a DLQ operator see THAT a forbidden key
   * was present, and where, without the forbidden value itself sitting in
   * Redis. */
  readonly redactedKeys: readonly string[];
  /** The underlying error's own `.message`, REDACTED via
   * `redactCredentialsFromMessage` before storage (`send()`, below) — the
   * sink's rejection reason for 'attempts-exhausted' (once a real sink
   * lands in T3.3.1, that error can originate from a Postgres/R2 client
   * whose own `.message` embeds a connection-string credential, exactly
   * the case `enqueue.ts`'s header describes), or a ZodError's own
   * (JSON-ish) `.message` for 'schema-validation-failed' (the structured,
   * human-readable equivalent lives in `issues` for that reason). */
  readonly errorMessage: string;
  /** [T3.3.4] The SQLSTATE off the underlying Postgres error, when there
   * is one — `error.code` when `error` carries a string `.code` property
   * (`pg`'s own `DatabaseError` shape), `null` otherwise. Always `null`
   * for 'schema-validation-failed' and 'attempts-exhausted' today (see
   * this file's own "flat shape" reasoning, above) — only 'flush-poison'
   * entries populate this from a real Postgres rejection. [T3.4.5] Also
   * always `null` for 'r2-put-failed': an R2/S3 rejection is never a
   * Postgres error and carries no SQLSTATE. */
  readonly sqlstate: string | null;
  /** Non-empty only for 'schema-validation-failed' — `[]` otherwise. See
   * this file's own "flat shape" reasoning for why this field exists
   * unconditionally rather than only on a narrower type. */
  readonly issues: readonly EventsDlqIssue[];
  /** BullMQ's own per-job attempt counter at the moment this entry was
   * written — 1 for 'schema-validation-failed' (that path never retries,
   * see events.consumer.ts's `routeToDlq()`), and
   * `EVENTS_JOB_OPTIONS.attempts` (5) for a normally-exhausted
   * 'attempts-exhausted' entry. [T3.4.5] For 'r2-put-failed' this is NOT
   * a BullMQ counter at all — it is `r2-retry.ts`'s own
   * `R2PutOutcome.attempts`: 1 for a non-retryable error that never
   * retried, or `options.maxAttempts` for a genuinely exhausted
   * retryable one. */
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

/** Minimal logger shape this file needs — the SAME `{ error(message,
 * meta?): void }` shape split-retry.ts's own `SplitRetryLogger` and
 * r2-retry.ts's own `R2RetryLogger` already use, deliberately not a
 * fourth shape. */
export interface DlqRetentionLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — writes to stderr via `console.error`, mirroring
 * the identical `consoleErrorLogger` split-retry.ts/r2-retry.ts already
 * export, as a separate instance rather than a shared import since none
 * of these files have any other reason to depend on each other. */
export const consoleErrorLogger: DlqRetentionLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * [T3.7.10][security][INV-6] `send()`'s own retention sweep — see this
 * file's own header, above, for the full "why a DLQ needs this at all"
 * reasoning: this project's Redis runs `volatile-lru` (CLAUDE.md's
 * decision log), a deliberate choice specifically so a key with NO ttl —
 * every BullMQ job's own Redis keys, a DLQ entry's included — is NEVER
 * evicted. Nothing drains `EVENTS_DLQ_QUEUE` (no `@Processor` is
 * registered for it — `depth()`'s own doc comment, below), so without
 * this sweep an entry sits in the `'wait'` state forever and Redis usage
 * grows without bound.
 *
 * Three module constants, deliberately NOT env vars and NOT threaded
 * through a second injected DI provider — mirrors split-retry.ts's own
 * `SPLIT_RETRY_MAX_ATTEMPTS_PER_BATCH`/`SPLIT_RETRY_INITIAL_DELAY_MS`
 * precedent exactly, for the identical reason: nobody outside this file
 * has a reason to tune these per-deployment, and a new env var per
 * tunable is exactly the kind of surface area S3.1's "config from env
 * only, read in exactly one place" discipline (CLAUDE.md) is meant to
 * bound, not expand for its own sake. The ONLY seam is `DlqService`'s own
 * second, optional constructor parameter, below — production DI
 * (`app.module.ts`'s `BullModule.registerQueue({ name: EVENTS_DLQ_QUEUE
 * })`) only ever supplies the one `@InjectQueue`-decorated `Queue`, so
 * Nest's own constructor call never passes a second argument and these
 * defaults apply unconditionally in production.
 *
 * `DLQ_RETENTION_WINDOW_MS` — 7 days. Sized against S3.1's own "DLQ depth
 * is alertable" acceptance criterion: the window has to outlast the
 * realistic gap between an alert firing and an operator actually looking,
 * not just "long enough to feel generous". A week covers a full weekend
 * an alert might land on unattended — this project has no on-call
 * rotation yet (v1, one operator) — while staying short enough that Redis
 * usage genuinely stays bounded, rather than this becoming a slow-motion
 * version of the unbounded growth this task exists to close.
 *
 * `DLQ_RETENTION_CLEAN_LIMIT` — 1000. The `limit` BullMQ's own
 * `Queue.clean()` takes: caps how many jobs a SINGLE sweep can remove, so
 * a large aged backlog can't turn one opportunistic clean — running
 * inline, after `send()`'s own `add()`, on the same call a real DLQ write
 * depends on — into a slow, unbounded Redis operation. 1000 clears a
 * realistic backlog in one pass while staying cheap; anything left over
 * is picked up by the NEXT throttled sweep, since a job older than the
 * retention window only ages further past it, never back under it.
 *
 * `DLQ_CLEAN_THROTTLE_MS` — 1 hour. Bounds how often `clean()` itself
 * actually runs, independent of how often `send()` is called — a failing
 * sink or a Redis blip can make `send()` fire in a tight burst
 * (events.consumer.ts's `onFailed()`/`routeToDlq()`, each routing one
 * job), and without a throttle EVERY one of those sends would also pay
 * for its own `clean()` scan. An hour is a small fraction of the 7-day
 * retention window (168 opportunities to sweep over the window's own
 * lifetime), so retention is still enforced promptly relative to how long
 * entries are kept, while a burst of sends pays for `clean()` at most
 * once no matter how tight the burst — see dlq-retention.test.ts's own
 * burst assertion.
 */
const DLQ_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DLQ_RETENTION_CLEAN_LIMIT = 1000;
const DLQ_CLEAN_THROTTLE_MS = 60 * 60 * 1000;

/** Test-only override for `send()`'s own retention sweep — see the
 * module constants above (`DLQ_RETENTION_WINDOW_MS` et al.) for the
 * production defaults every field here falls back to when omitted. NOT a
 * second injected DI provider — see this file's own
 * `cleanAgedEntriesThrottled` doc comment for why. */
export interface DlqRetentionOptions {
  readonly retentionWindowMs?: number;
  readonly retentionCleanLimit?: number;
  readonly cleanThrottleMs?: number;
  readonly logger?: DlqRetentionLogger;
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
  private readonly retentionWindowMs: number;
  private readonly retentionCleanLimit: number;
  private readonly cleanThrottleMs: number;
  private readonly retentionLogger: DlqRetentionLogger;
  /** [T3.7.10] Timestamp of the last `clean()` ATTEMPT (not the last
   * SUCCESSFUL one) — see `cleanAgedEntriesThrottled`'s own doc comment
   * for why a failure still counts toward the throttle. `0` initially, so
   * the very first `send()` on a freshly constructed instance always
   * attempts a sweep. */
  private lastCleanAttemptAtMs = 0;

  constructor(
    @InjectQueue(EVENTS_DLQ_QUEUE) private readonly dlqQueue: Queue<EventsDlqJobPayload>,
    // [T3.7.10] `@Optional()` — NOT just an unadorned `?` — is load-bearing
    // here: `DlqService` is `@Injectable()` under this project's
    // `emitDecoratorMetadata: true`, so Nest's own injector inspects
    // `design:paramtypes` and attempts to resolve EVERY constructor
    // parameter, not only the ones carrying an explicit `@Inject*()`
    // decorator (confirmed the hard way — omitting `@Optional()` here
    // throws Nest's own `UnknownDependenciesException` for "the argument
    // at index [1]" during real DI construction, which
    // `NestFactory.createApplicationContext()`'s default `abortOnError:
    // true` turns into a hard `process.abort()`, exactly the crash
    // dlq.service.test.ts's own header already documents for a missing
    // `dbPoolMax`/`flush` config — see that file's comment for the same
    // failure shape). `@Optional()` tells Nest to inject `undefined`
    // instead of throwing when nothing in the module can supply this
    // parameter, which is exactly what SHOULD happen: no provider for
    // `DlqRetentionOptions` is ever registered (this task deliberately
    // does not touch app.module.ts — see this file's own
    // `DlqRetentionOptions` doc comment), so production DI always lands
    // here with `undefined` and every field below falls back to its
    // module-constant default. A plain `new DlqService(queue, options)`
    // call — every test in this file and dlq-retention.test.ts — never
    // goes through Nest's injector at all, so `@Optional()` has no effect
    // on that path; it only prevents Nest's OWN automatic construction
    // from throwing.
    @Optional() retentionOptions?: DlqRetentionOptions,
  ) {
    this.retentionWindowMs = retentionOptions?.retentionWindowMs ?? DLQ_RETENTION_WINDOW_MS;
    this.retentionCleanLimit = retentionOptions?.retentionCleanLimit ?? DLQ_RETENTION_CLEAN_LIMIT;
    this.cleanThrottleMs = retentionOptions?.cleanThrottleMs ?? DLQ_CLEAN_THROTTLE_MS;
    this.retentionLogger = retentionOptions?.logger ?? consoleErrorLogger;
  }

  async send(reason: DlqReason, payload: unknown, error: Error, meta: DlqSendMeta): Promise<void> {
    // [T3.7.9][security][INV-6] Run UNCONDITIONALLY, for every `reason` —
    // this file's own header (above) records why: a payload that already
    // passed `CaptureEventSchema`'s `.strict()` check cannot structurally
    // carry a forbidden key, so this is a true no-op for every reason
    // except 'schema-validation-failed', with no per-reason branch needed.
    const { value: redactedPayload, redactedKeys } = redactForbiddenKeys(payload);

    const entry: EventsDlqJobPayload = {
      reason,
      rawPayload: redactedPayload,
      redactedKeys,
      // [security fix, review round 1] `error.message` is redacted here,
      // in this ONE shared writer, rather than trusting each of
      // routeToDlq()/onFailed() (events.consumer.ts) to remember to do it
      // at their own call sites — a single guard point protects both
      // today's callers and any future one, the same reasoning
      // `redactCredentialsFromMessage`'s own header gives for living in
      // packages/contracts instead of being copied per call site.
      errorMessage: redactCredentialsFromMessage(error.message),
      sqlstate: extractSqlState(error),
      issues: meta.issues ?? [],
      attemptsMade: meta.attemptsMade,
      originalJobId: meta.originalJobId,
      failedAt: new Date().toISOString(),
    };

    await this.dlqQueue.add(EVENTS_DLQ_JOB_NAME, entry);

    // [T3.7.10][security][INV-6] AFTER `add()` above resolves, never
    // before — see `cleanAgedEntriesThrottled`'s own doc comment for why
    // that ordering matters and what it costs.
    await this.cleanAgedEntriesThrottled();
  }

  /**
   * [T3.7.10][security][INV-6] Opportunistic, throttled retention sweep —
   * see the module constants above (`DLQ_RETENTION_WINDOW_MS` et al.) for
   * the full "why" and the exact production defaults. Called from `send()`
   * ONLY after its own `add()` has already resolved: `add()` is the DLQ
   * write this whole mechanism exists to bound the RETENTION of, not the
   * durability of — a clean that ran first, or whose failure was allowed
   * to propagate, must never be able to stop a DLQ entry from landing.
   *
   * Throttled via `lastCleanAttemptAtMs`, checked and updated
   * SYNCHRONOUSLY — no `await` between the check and the write — so a
   * burst of concurrent `send()` calls can only ever have ONE of them
   * observe the throttle window as elapsed, no matter how many `add()`
   * calls resolve at once (dlq-retention.test.ts's own burst assertion).
   * The timestamp is updated whether or not `clean()` itself SUCCEEDS: a
   * Redis that is currently failing `clean()` deserves the same backoff
   * as a healthy one that just swept, not a retry attempt on every single
   * subsequent `send()`.
   *
   * A `clean()` rejection is caught, logged, and NEVER rethrown — the DLQ
   * write `send()` already committed matters more than this sweep ever
   * could (this method's own second paragraph). `errorMessage`/
   * `redactCredentialsFromMessage` mirror `send()`'s own handling of
   * `error.message` above: a Redis client's connection error can embed
   * the connection URL, credential included, in `.message` the exact same
   * way a Postgres/R2 client's can.
   *
   * [cost, recorded per this task's own brief] A cleaned entry is gone
   * for good. For `'flush-poison'`, the underlying event still exists in
   * R2 (its PUT succeeded before the Postgres INSERT that made it poison
   * failed) — though nothing today can land it from there: replay
   * re-attempts the identical failing INSERT (split-retry.ts's own
   * header). For `'schema-validation-failed'`, the payload never reached
   * R2 at all, and the DLQ entry was its ONLY existing record — the same
   * fact poison-dlq.test.ts already asserts, for the `'flush-poison'`
   * half, at its own "NEITHER poisoned event did" assertion. Losing an
   * aged entry to this sweep is an accepted, deliberate trade against the
   * alternative — Redis growing without bound — not a gap nobody noticed.
   *
   * [rejected alternative, recorded per this task's own brief] A
   * count-based cap (drop oldest entries beyond N) would preserve recent
   * evidence better under a sudden burst, but age is what BullMQ's own
   * `clean()` implements natively over the `'wait'` state a DLQ entry
   * actually sits in (no `@Processor` ever drains one into a terminal
   * state — `depth()`'s own doc comment, below). Reimplementing
   * eviction-by-count by hand over `'wait'` would be real, unreviewed
   * complexity for a mechanism BullMQ already provides for the age-based
   * case — age wins here because it is the native mechanism, not because
   * it is definitively the better policy in the abstract.
   */
  private async cleanAgedEntriesThrottled(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanAttemptAtMs < this.cleanThrottleMs) {
      return;
    }
    this.lastCleanAttemptAtMs = now;

    try {
      await this.dlqQueue.clean(this.retentionWindowMs, this.retentionCleanLimit, 'wait');
    } catch (cleanError) {
      this.retentionLogger.error(
        `DlqService retention clean() failed; DLQ entries older than ${this.retentionWindowMs}ms may persist ` +
          `past their intended retention window until the next successful sweep: ` +
          `${redactCredentialsFromMessage(errorMessage(cleanError))}`,
        { retentionWindowMs: this.retentionWindowMs, retentionCleanLimit: this.retentionCleanLimit },
      );
    }
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
