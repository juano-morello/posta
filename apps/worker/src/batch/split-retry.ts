import type { CaptureEvent } from '@posta/contracts';
import type { FlushBatch } from './flush';

// T3.3.3 [E3, S3.3] — `retryWithSplit` is what makes flush.ts's own
// `flushBatch` (T3.3.2) safe to call against a REAL batch that might
// contain one bad row: on failure it retries the WHOLE sub-batch with
// exponential backoff, and only once THAT is exhausted does it binary-
// split into two halves and recurse — each half getting its own full
// retry-then-split treatment — until a single event, alone in a batch of
// one, still fails. That event is "poison": isolated and RETURNED, never
// dropped and never sent anywhere by this file (T3.3.4, not this task,
// routes it to `DlqService` via `EVENTS_DLQ_QUEUE` — this module has no
// idea that queue exists, on purpose, so it stays testable and reusable
// without a DLQ dependency).
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
// never imports `@posta/core`'s db helpers itself, and inspects nothing
// about WHY a call rejected — no SQLSTATE parsing, no Postgres-specific
// error shape anywhere in this file. Any rejection at all is treated as
// "this sub-batch did not commit, try again / split it" — the SAME
// contract flush.test.ts's own `createFlushBatch` already promises,
// which is also why split-retry.test.ts can point this module at either
// a real testcontainer-backed `flushBatch` OR a plain injected function
// that fails on cue, and get identical behavior either way.
//
// SEQUENTIAL, NOT `Promise.all`, ACROSS THE TWO HALVES: a split's two
// halves are awaited one after another rather than concurrently. This
// path only ever runs after a sub-batch has already failed its retries —
// it is a recovery path, not the hot path (invariant 1/2 govern the
// REDIRECT, not this) — so there is no latency budget here worth
// racing Postgres connections for, and sequential execution keeps the
// recursion's actual call order (and therefore its round-trip count)
// simple to reason about and to assert on directly in tests.

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
}

export interface SplitRetryResult {
  /** Every event that ended up in a sub-batch whose `flushBatch` call
   * eventually resolved — i.e. actually committed. Order is not
   * meaningful (the two halves of a split are merged after both
   * resolve). */
  readonly committedEvents: readonly CaptureEvent[];
  /** Events isolated as poison: each one, alone in a sub-batch of one,
   * still failed after `maxAttemptsPerBatch` attempts. Never sent
   * anywhere by this function — routing these to a DLQ is T3.3.4's job,
   * not this file's. */
  readonly poisonEvents: readonly CaptureEvent[];
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

/** The single choke point every sub-batch (whole batch or a split half,
 * all the way down to size one) goes through — retries up to
 * `maxAttempts` times with exponential backoff between attempts, then
 * either splits (size > 1) or declares poison (size === 1). */
async function attemptBatch(
  events: readonly CaptureEvent[],
  flushBatch: FlushBatch,
  maxAttempts: number,
  initialDelayMs: number,
  sleep: Sleep,
  logger: SplitRetryLogger,
): Promise<SplitRetryResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await flushBatch(events);
      return { committedEvents: events, poisonEvents: [] };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(initialDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  const message = errorMessage(lastError);

  if (events.length === 1) {
    const poisonEvent = events[0]!;
    logger.error(
      `retryWithSplit: isolated poison event ${poisonEvent.event_id} after ${maxAttempts} failed ` +
        `attempt(s): ${message}`,
      { eventId: poisonEvent.event_id, attempts: maxAttempts },
    );
    return { committedEvents: [], poisonEvents: [poisonEvent] };
  }

  logger.error(
    `retryWithSplit: batch of ${events.length} event(s) failed ${maxAttempts} attempt(s), splitting ` +
      `to isolate the failure: ${message}`,
    { batchSize: events.length, attempts: maxAttempts },
  );

  const mid = Math.ceil(events.length / 2);
  const left = events.slice(0, mid);
  const right = events.slice(mid);

  const leftResult = await attemptBatch(left, flushBatch, maxAttempts, initialDelayMs, sleep, logger);
  const rightResult = await attemptBatch(right, flushBatch, maxAttempts, initialDelayMs, sleep, logger);

  return {
    committedEvents: [...leftResult.committedEvents, ...rightResult.committedEvents],
    poisonEvents: [...leftResult.poisonEvents, ...rightResult.poisonEvents],
  };
}

/**
 * Flushes `events` through `flushBatch`, retrying the whole batch with
 * exponential backoff on failure and, once those retries are exhausted,
 * binary-splitting it and recursing into each half — see this file's own
 * header for the full design rationale. Resolves with every event split
 * between `committedEvents` (actually written) and `poisonEvents`
 * (isolated because a sub-batch containing only that one event still
 * failed) — this function never throws for a partial failure, since a
 * poison row is an expected, handled outcome, not an exceptional one.
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

  return attemptBatch(events, flushBatch, options.maxAttemptsPerBatch, options.initialDelayMs, sleep, logger);
}
