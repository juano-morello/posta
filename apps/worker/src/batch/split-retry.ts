import type { CaptureEvent } from '@posta/contracts';
import { newId } from '@posta/core';
import { classifyFlushError, type FlushErrorClassification } from './classify-flush-error';
import type { FlushBatch } from './flush';

// T3.3.3 [E3, S3.3] — `retryWithSplit` is what makes flush.ts's own
// `flushBatch` (T3.3.2) safe to call against a REAL batch that might
// contain one bad row: on failure it retries the WHOLE sub-batch with
// exponential backoff, and only once THAT is exhausted does it binary-
// split into two halves and recurse — each half getting its own full
// retry-then-split treatment — until a single event, alone in a batch of
// one, still fails. That event is "poison": isolated and RETURNED,
// paired with the Error that caused its final rejection (T3.3.4, see
// {@link PoisonedEvent}), never dropped and never sent anywhere by
// `retryWithSplit` itself. Routing it to `DlqService` via
// `EVENTS_DLQ_QUEUE` is `sendPoisonEventsToDlq`'s job (T3.3.4, below) —
// built around a narrow `PoisonDlqSink` interface rather than an import
// of `DlqService` itself, so `retryWithSplit` proper stays exactly as
// testable and reusable without a DLQ dependency as T3.3.3 left it.
//
// WHY BINARY SPLIT AND NOT "drop the batch" OR "retry forever": a single
// bad row (an oversized field, a constraint violation, anything the
// database itself rejects) fails a multi-row `INSERT ... VALUES (...),
// (...), ...` in its ENTIRETY — Postgres does not partially commit some
// rows of one INSERT statement and reject others. Dropping the whole
// batch on any failure would silently lose every healthy event alongside
// the one bad one; retrying the whole batch forever would wedge the
// queue behind a row that will never succeed no matter how many times it
// is retried. Binary search over the batch is the middle path: at most
// O(log n) splits isolate the ONE (or few) bad rows while every healthy
// row still commits, in a sub-batch that eventually shrinks small enough
// to exclude the poison entirely.
//
// GENERIC OVER `flushBatch`, NOT COUPLED TO POSTGRES: this file takes a
// `FlushBatch`-shaped function (flush.ts's own exported type,
// `(events: readonly CaptureEvent[]) => Promise<void>`) as a parameter,
// never imports `@posta/core`'s db helpers itself, and `attemptBatch`
// itself still never parses a SQLSTATE or inspects any Postgres-specific
// error shape directly — that knowledge lives entirely behind the
// injected classification seam T3.7.2 added (see `SplitRetryOptions.
// classifyFlushError`'s own doc comment, below), the SAME "narrow,
// replaceable seam" discipline this file's own `Sleep`/`SplitRetryLogger`
// already follow. [T3.3.4] A poisoned sub-batch's final Error IS carried
// through onto its `PoisonedEvent` unchanged (never reduced to a string)
// — a real Postgres error's own `.code` IS the SQLSTATE, and a caller
// reads it off `PoisonedEvent.error`.
//
// [T3.7.2] "ANY REJECTION BELONGS TO A ROW" IS NO LONGER THE WHOLE
// CONTRACT — before this task, `attemptBatch` treated every `flushBatch`
// rejection identically: retry the whole sub-batch, then split it (or, at
// size one, declare it poison). That is exactly wrong for a Postgres
// OUTAGE, which fails every sub-batch equally and would otherwise binary-
// search all the way down and declare EVERY event in the batch poison —
// a recoverable outage converted into a mass dead-letter. `attemptBatch`
// now classifies a sub-batch's LAST error, once its own retry budget is
// exhausted (never per-attempt), via the injected `classify` predicate:
// a `'row-fault'` verdict proceeds exactly as before (split if size > 1,
// declare poison if size === 1); an `'infrastructure'` verdict makes
// `attemptBatch` REJECT instead — never splitting, never declaring
// poison. See `classify-flush-error.ts`'s own header for the closed
// SQLSTATE allowlist behind that verdict, and `sendPoisonEventsToDlq`'s
// section below for why `retryWithSplit`'s promise rejecting outright,
// rather than resolving with an empty result, is the correct signal for
// a caller: BullMQ redelivering the whole job is the recovery path for an
// outage, not a DLQ entry per event.
//
// SEQUENTIAL, NOT `Promise.all`, ACROSS THE TWO HALVES: a split's two
// halves are awaited one after another rather than concurrently. This
// path only ever runs after a sub-batch has already failed its retries —
// it is a recovery path, not the hot path (invariant 1/2 govern the
// REDIRECT, not this) — so there is no latency budget here worth
// racing Postgres connections for, and sequential execution keeps the
// recursion's actual call order (and therefore its round-trip count)
// simple to reason about and to assert on directly in tests. [T3.7.2] An
// infrastructure verdict on the LEFT half after the RIGHT half has
// already committed (or been split-and-poisoned) throws out of the
// recursive `attemptBatch` call awaiting it, discarding that already-done
// work — an accepted consequence, not a bug: BullMQ redelivers the whole
// job, and T3.3.3's `ON CONFLICT DO NOTHING` [INV-8] makes re-flushing
// the already-committed half free, so nothing is lost, only redone.

/** Minimal logger shape this file needs — the SAME `{ error(message,
 * meta?): void }` shape flush.ts's own `FlushBatchLogger` and
 * accumulator.ts's own `BatchAccumulatorLogger` already use, deliberately
 * not a fourth shape. */
export interface SplitRetryLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — writes to stderr via `console.error`, mirroring
 * the identical `consoleErrorLogger` flush.ts and accumulator.ts already
 * export, as a separate instance rather than a shared import since none
 * of the three have any other reason to depend on each other. */
export const consoleErrorLogger: SplitRetryLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** Delays for `ms` milliseconds. Injectable so tests can skip real
 * waiting while still observing the exponential backoff SEQUENCE (see
 * split-retry.test.ts's dedicated backoff assertion, which records the
 * `ms` argument of every call) — the same "narrow, replaceable seam"
 * discipline this file's own `SplitRetryLogger` and flush.ts's/
 * accumulator.ts's injected callbacks already follow. */
export type Sleep = (ms: number) => Promise<void>;

/** Production default — a real `setTimeout`-based delay. */
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** [T3.7.2] Classifies a sub-batch's LAST error — the one `attemptBatch`
 * is left holding once that sub-batch's own retry loop exhausts
 * `maxAttemptsPerBatch` — as {@link FlushErrorClassification}. See
 * `SplitRetryOptions.classifyFlushError`'s own doc comment for how the
 * two possible verdicts change `attemptBatch`'s behavior, and
 * `classify-flush-error.ts`'s own header for the closed SQLSTATE
 * allowlist behind the real implementation. */
export type ClassifyFlushError = (error: unknown) => FlushErrorClassification;

export interface SplitRetryOptions {
  /**
   * Attempts for ANY single sub-batch — the whole batch at the top, or
   * any half produced by a split, all the way down to a batch of one —
   * before giving up on it: splitting it (size > 1) or declaring its one
   * remaining event poison (size === 1). Must be a positive integer.
   */
  readonly maxAttemptsPerBatch: number;
  /**
   * Base delay before the SECOND attempt at any given sub-batch; each
   * further retry of that SAME sub-batch doubles it (attempt 1 -> 2 waits
   * `initialDelayMs`, attempt 2 -> 3 waits `initialDelayMs * 2`, ...).
   * Must be a non-negative integer.
   */
  readonly initialDelayMs: number;
  /** Defaults to {@link realSleep}. */
  readonly sleep?: Sleep;
  /** Defaults to {@link consoleErrorLogger}. */
  readonly logger?: SplitRetryLogger;
  /**
   * [T3.7.1][INV-7][INV-8] The id this WHOLE call's top-level batch is
   * keyed off — threaded down through every recursive `attemptBatch` call
   * as the SECOND argument to `flushBatch(events, batchId)`, so
   * `eventBatchKey` (flush.ts) resolves to the SAME R2 key across every
   * retry of a given sub-batch (invariant 8's idempotent-write property,
   * extended to R2). A split's two halves never inherit this whole id —
   * each gets a SUFFIX of it (`${batchId}.0` / `${batchId}.1`), so the
   * two halves' R2 objects never collide at the same key (see this
   * file's own header on why an independent id per half would recreate
   * invariant 7's forbidden asymmetry).
   *
   * Optional: defaults to a single `newId()` call, evaluated ONCE before
   * recursion starts, when omitted — a caller with a real batch id
   * (e.g. `BatchAccumulator`'s own per-flush id) supplies it explicitly;
   * one that does not (every existing caller, as of this task) still
   * gets a stable id for the lifetime of this one `retryWithSplit` call.
   */
  readonly batchId?: string;
  /**
   * [T3.7.2] Classifies a sub-batch's last error, once its own retry loop
   * exhausts `maxAttemptsPerBatch`, as {@link FlushErrorClassification} —
   * consulted ONCE per sub-batch (never per-attempt). A `'row-fault'`
   * verdict proceeds exactly as before this task: split the sub-batch if
   * it holds more than one event, or declare its one remaining event
   * poison. An `'infrastructure'` verdict makes `attemptBatch` REJECT
   * instead — never splitting, never declaring poison — because a
   * Postgres outage fails every sub-batch equally, and binary search
   * cannot isolate a failure that is not any one row's fault; see this
   * file's own header for the full [T3.7.2] rationale and
   * `classify-flush-error.ts`'s own header for the closed SQLSTATE
   * allowlist (classes 22/23 only) behind that verdict.
   *
   * Optional: defaults to the real `classifyFlushError` (classify-flush-
   * error.ts) — the SAME "narrow, replaceable seam" discipline this
   * file's own `Sleep`/`SplitRetryLogger`/`batchId` already follow. A
   * caller substitutes this to force a classification without needing to
   * construct an error carrying a genuine SQLSTATE-shaped `cause` chain.
   */
  readonly classifyFlushError?: ClassifyFlushError;
}

/** A poisoned event, paired with the Error that caused its final,
 * unrecoverable rejection — the SAME Error object `flushBatch` itself
 * rejected with on the LAST attempt of the sub-batch of one that isolated
 * it, never reduced to a string. A real Postgres error's own `.code` IS
 * the SQLSTATE (`pg`'s `DatabaseError` sets it directly) — carrying the
 * whole object through, rather than just `.message`, is what lets a
 * caller (T3.3.4's `sendPoisonEventsToDlq`, below) surface that code
 * without `attemptBatch` ever inspecting or depending on it itself. */
export interface PoisonedEvent {
  readonly event: CaptureEvent;
  readonly error: Error;
}

export interface SplitRetryResult {
  /** Every event that ended up in a sub-batch whose `flushBatch` call
   * eventually resolved — i.e. actually committed. Order is not
   * meaningful (the two halves of a split are merged after both
   * resolve). */
  readonly committedEvents: readonly CaptureEvent[];
  /** Events isolated as poison, each paired with the Error that caused
   * its final rejection (see {@link PoisonedEvent}) — every one, alone
   * in a sub-batch of one, still failed after `maxAttemptsPerBatch`
   * attempts. Never sent anywhere by `retryWithSplit` itself — routing
   * these to a DLQ is `sendPoisonEventsToDlq`'s job (T3.3.4, below), not
   * this function's. */
  readonly poisonEvents: readonly PoisonedEvent[];
}

function validateOptions(options: SplitRetryOptions): void {
  if (!Number.isInteger(options.maxAttemptsPerBatch) || options.maxAttemptsPerBatch <= 0) {
    throw new Error(
      `retryWithSplit maxAttemptsPerBatch must be a positive integer; received ${options.maxAttemptsPerBatch}`,
    );
  }
  if (!Number.isInteger(options.initialDelayMs) || options.initialDelayMs < 0) {
    throw new Error(
      `retryWithSplit initialDelayMs must be a non-negative integer; received ${options.initialDelayMs}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalises an unknown rejection into a real `Error` — the SAME value
 * when it already IS one (preserving any extra property a caller
 * attached, e.g. `pg`'s own `.code`/SQLSTATE), or a freshly constructed
 * `Error` wrapping its string form otherwise (mirrors `errorMessage`,
 * above, which this delegates to for that fallback case). */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

/** The single choke point every sub-batch (whole batch or a split half,
 * all the way down to size one) goes through — retries up to
 * `maxAttempts` times with exponential backoff between attempts, then
 * classifies the last error and either proceeds to split (size > 1) or
 * declare poison (size === 1) for a `'row-fault'` verdict, or REJECTS
 * outright for an `'infrastructure'` one — see this file's own [T3.7.2]
 * header section and `SplitRetryOptions.classifyFlushError`'s own doc
 * comment for the full rationale.
 *
 * `batchId` is this sub-batch's OWN stable id — the same value on every
 * attempt in the loop below (so a retry overwrites its own R2 object,
 * never mints a new key), and the base a split's two halves suffix
 * (`.0`/`.1`) rather than replace outright — see `SplitRetryOptions.
 * batchId`'s own doc comment for the full [T3.7.1] rationale. */
async function attemptBatch(
  events: readonly CaptureEvent[],
  flushBatch: FlushBatch,
  maxAttempts: number,
  initialDelayMs: number,
  sleep: Sleep,
  logger: SplitRetryLogger,
  batchId: string,
  classify: ClassifyFlushError,
): Promise<SplitRetryResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await flushBatch(events, batchId);
      return { committedEvents: events, poisonEvents: [] };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(initialDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  const message = errorMessage(lastError);

  // [T3.7.2] Classified ONCE here, off the LAST error only — never
  // per-attempt. An infrastructure verdict short-circuits BOTH branches
  // below: this sub-batch's failure is not attributable to any one row,
  // so neither splitting it nor declaring its (possibly sole) event
  // poison would be sound — see this file's own [T3.7.2] header section.
  if (classify(lastError) === 'infrastructure') {
    const error = toError(lastError);
    logger.error(
      `retryWithSplit: sub-batch of ${events.length} event(s) failed ${maxAttempts} attempt(s) with an ` +
        `infrastructure error, rejecting rather than splitting: ${message}`,
      { batchSize: events.length, attempts: maxAttempts },
    );
    throw error;
  }

  if (events.length === 1) {
    const poisonEvent = events[0]!;
    const error = toError(lastError);
    logger.error(
      `retryWithSplit: isolated poison event ${poisonEvent.event_id} after ${maxAttempts} failed ` +
        `attempt(s): ${message}`,
      { eventId: poisonEvent.event_id, attempts: maxAttempts },
    );
    return { committedEvents: [], poisonEvents: [{ event: poisonEvent, error }] };
  }

  logger.error(
    `retryWithSplit: batch of ${events.length} event(s) failed ${maxAttempts} attempt(s), splitting ` +
      `to isolate the failure: ${message}`,
    { batchSize: events.length, attempts: maxAttempts },
  );

  const mid = Math.ceil(events.length / 2);
  const left = events.slice(0, mid);
  const right = events.slice(mid);

  // A SUFFIX of this sub-batch's own id, never a fresh independent one —
  // see this function's own doc comment and `SplitRetryOptions.batchId`'s
  // for why an independently minted id per half would let the second
  // half's R2 PUT silently overwrite the first's at the SAME key.
  const leftBatchId = `${batchId}.0`;
  const rightBatchId = `${batchId}.1`;

  const leftResult = await attemptBatch(
    left,
    flushBatch,
    maxAttempts,
    initialDelayMs,
    sleep,
    logger,
    leftBatchId,
    classify,
  );
  const rightResult = await attemptBatch(
    right,
    flushBatch,
    maxAttempts,
    initialDelayMs,
    sleep,
    logger,
    rightBatchId,
    classify,
  );

  return {
    committedEvents: [...leftResult.committedEvents, ...rightResult.committedEvents],
    poisonEvents: [...leftResult.poisonEvents, ...rightResult.poisonEvents],
  };
}

/**
 * Flushes `events` through `flushBatch`, retrying the whole batch with
 * exponential backoff on failure and, once those retries are exhausted
 * and its last error classifies `'row-fault'`, binary-splitting it and
 * recursing into each half — see this file's own header for the full
 * design rationale. Resolves with every event split between
 * `committedEvents` (actually written) and `poisonEvents` (isolated
 * because a sub-batch containing only that one event still failed a
 * `'row-fault'`-classified rejection) — a poison row is an expected,
 * handled outcome, not an exceptional one.
 *
 * [T3.7.2] This function DOES now reject — a deliberate, amended contract
 * from before this task, when it never threw for a partial failure at
 * all: once any sub-batch's last error classifies `'infrastructure'`
 * (see `SplitRetryOptions.classifyFlushError`), that sub-batch's own
 * `attemptBatch` call throws instead of splitting or declaring poison,
 * and that throw propagates out of this function's returned promise. An
 * infrastructure failure is genuinely not a partial failure — it says
 * nothing about any individual row — so retrying it into oblivion via an
 * ever-finer binary search and dead-lettering the whole batch would be
 * the wrong outcome; see this file's own header for the full rationale,
 * including the accepted cost when this happens after a sibling half has
 * already committed or been split-and-poisoned.
 *
 * An empty `events` array is a no-op: `flushBatch` is never called, and
 * both result arrays are empty.
 */
export async function retryWithSplit(
  events: readonly CaptureEvent[],
  flushBatch: FlushBatch,
  options: SplitRetryOptions,
): Promise<SplitRetryResult> {
  validateOptions(options);

  if (events.length === 0) {
    return { committedEvents: [], poisonEvents: [] };
  }

  const sleep = options.sleep ?? realSleep;
  const logger = options.logger ?? consoleErrorLogger;
  // [T3.7.1] Minted ONCE, here, before recursion starts — never inside
  // `attemptBatch` itself, which only ever suffixes this value. See
  // `SplitRetryOptions.batchId`'s own doc comment for the full rationale.
  const batchId = options.batchId ?? newId();
  // [T3.7.2] Defaults to the real `classifyFlushError` — see
  // `SplitRetryOptions.classifyFlushError`'s own doc comment.
  const classify = options.classifyFlushError ?? classifyFlushError;

  return attemptBatch(
    events,
    flushBatch,
    options.maxAttemptsPerBatch,
    options.initialDelayMs,
    sleep,
    logger,
    batchId,
    classify,
  );
}

// T3.3.4 [E3, S3.3] — everything below is the bridge from a
// `retryWithSplit` result to `EVENTS_DLQ_QUEUE`, via `DlqService`
// (apps/worker/src/consumer/dlq.service.ts, T3.1.5). Deliberately its OWN
// section, after `retryWithSplit` itself: this file's own header explains
// why the retry/split algorithm stays unaware a DLQ exists — this is the
// caller-side composition that closes that loop WITHOUT importing
// `DlqService`, `@nestjs/bullmq`, or even `DlqReason` into this file.
//
// WHERE THIS IS ACTUALLY CALLED FROM — deliberately NOT this task's
// concern: neither `retryWithSplit` nor `flush.ts`'s own `flushBatch` is
// wired to call `sendPoisonEventsToDlq` yet, and this file does not wire
// a real `DlqService` into it either — that wiring belongs wherever the
// accumulator's flush callback is composed (`app.module.ts`), which is
// NOT in this task's file list. `sendPoisonEventsToDlq` is built and
// proven correct here (poison-dlq.test.ts) so that wiring is a pure
// composition step for whichever later task does it, not a design
// decision it has to make from scratch.

/** The per-poison-event metadata `sendPoisonEventsToDlq` needs beyond the
 * event and its error — see that function's own header for why
 * `DlqSendMeta`'s `originalJobId`/`attemptsMade` (dlq.service.ts) don't
 * map cleanly onto a flush-level poison event, and what stands in for
 * them here. */
export interface PoisonDlqMeta {
  /** Stands in for `DlqSendMeta.originalJobId` — a poison event has no
   * single originating BullMQ job id in that sense (it came from a
   * BATCH, not a single job). The flush's own `batch_id` (minted once
   * per batch by `BatchAccumulator`, T3.3.1) is the closest thing an
   * operator could actually search logs for, so it stands in here. */
  readonly batchId: string;
  /** Stands in for `DlqSendMeta.attemptsMade` — not a per-job BullMQ
   * counter (there isn't one at this level), but the SAME
   * `maxAttemptsPerBatch` value `retryWithSplit` was called with: every
   * poisoned event in a `retryWithSplit` result was retried exactly this
   * many times, alone, before being declared poison. */
  readonly maxAttemptsPerBatch: number;
}

/** The literal `DlqReason` value this file's own poison-routing seam
 * sends (dlq.service.ts's own `DlqReason` union, extended by this task
 * to include it). Exported as a named constant — the same
 * `EVENTS_DLQ_JOB_NAME` precedent dlq.service.ts itself sets, so a
 * caller wiring a real `DlqService` in later never has to hand-type the
 * string a second time. Deliberately NOT imported from dlq.service.ts,
 * even as a type-only import: this file's own header says
 * `retryWithSplit` stays unaware `DlqService`/`EVENTS_DLQ_QUEUE` exist on
 * purpose, and a type-only import would still wire this file into that
 * module's existence in the build graph. Keep this value in sync with
 * dlq.service.ts's `DlqReason` by hand — a mismatch fails to compile the
 * moment a real `DlqService` is passed as a {@link PoisonDlqSink}
 * (structural typing catches the drift there, not here). */
export const FLUSH_POISON_DLQ_REASON = 'flush-poison';

/** The narrow slice of `DlqService.send()`
 * (apps/worker/src/consumer/dlq.service.ts, T3.1.5) `sendPoisonEventsToDlq`
 * needs — matching that method's real signature closely enough that a
 * real `DlqService` instance satisfies this interface with zero adapter
 * code (TypeScript's structural typing, contravariant-checked parameters
 * included), while poison-dlq.test.ts can substitute a plain recording
 * double instead of booting a real BullMQ queue. The SAME "narrow,
 * replaceable seam" discipline this file's own `SplitRetryLogger`/`Sleep`
 * already follow. */
export interface PoisonDlqSink {
  send(
    reason: typeof FLUSH_POISON_DLQ_REASON,
    payload: unknown,
    error: Error,
    meta: { readonly originalJobId: string; readonly attemptsMade: number },
  ): Promise<void>;
}

/**
 * Routes every poisoned event from a `retryWithSplit` result to
 * `dlqSink.send()` — one DLQ entry per poisoned event, each carrying that
 * event's own full `CaptureEvent` as `rawPayload` and the ORIGINAL Error
 * `retryWithSplit` isolated it with (never just its `.message` — see
 * {@link PoisonedEvent}), so a real Postgres error's own `.code` (the
 * SQLSTATE) survives into the stored DLQ entry via `DlqService.send()`'s
 * own `sqlstate` field.
 *
 * Never called by `retryWithSplit` itself — see this file's own header
 * for why the retry/split algorithm stays entirely unaware a DLQ exists.
 * A caller composes this AFTER `retryWithSplit` resolves, typically once
 * per flush, passing a real `DlqService` as `dlqSink`.
 *
 * Sequential, not `Promise.all`, across poisoned events — the SAME
 * "recovery path, no latency budget worth racing for" reasoning this
 * file's own header gives for running a split's two halves sequentially.
 *
 * A `dlqSink.send()` rejection is NOT swallowed here: it propagates to
 * the caller. A poison event that fails to even reach the DLQ is exactly
 * the "vanishes silently" outcome this task exists to prevent — a loud
 * failure the caller must handle beats a quiet one this function hides.
 *
 * An empty `poisonEvents` array is a no-op: `dlqSink.send()` is never
 * called.
 */
export async function sendPoisonEventsToDlq(
  poisonEvents: readonly PoisonedEvent[],
  dlqSink: PoisonDlqSink,
  meta: PoisonDlqMeta,
): Promise<void> {
  for (const poisoned of poisonEvents) {
    await dlqSink.send(FLUSH_POISON_DLQ_REASON, poisoned.event, poisoned.error, {
      originalJobId: meta.batchId,
      attemptsMade: meta.maxAttemptsPerBatch,
    });
  }
}
