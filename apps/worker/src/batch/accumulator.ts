import { newId } from '@posta/core';

// T3.3.1 [E3, S3.3] — BatchAccumulator opens a batch on the first item
// added to it, mints that batch's `batch_id` (a ULID, `newId()` —
// packages/core/src/ulid.ts, T1.1.3, the ONE place a Posta id is
// generated) exactly once, and fires an injected flush callback whenever
// EITHER of two triggers trips first: the batch reaches `batchSize`
// items, or `batchIntervalMs` has elapsed since the batch OPENED (not a
// debounce that resets on every add — the countdown starts once, at the
// first item, and runs regardless of how many more items arrive before
// it elapses). Both numbers are meant to be sourced from
// `env.EVENT_BATCH_SIZE` / `env.EVENT_BATCH_INTERVAL_MS`
// (apps/worker/src/env.ts, T0.3.6) by whatever wires this up — that
// wiring (likely T3.3.2, wherever `flushBatch` actually lands) is
// deliberately NOT this file's job, so this class takes plain
// already-validated numbers rather than reading `process.env` itself.
//
// GENERIC OVER T, NOT FIXED TO CaptureEvent: this class only ever counts
// and holds opaque items — it inspects nothing about their shape — so
// tying it to `@posta/contracts`'s `CaptureEvent` would be an import this
// file has no real use for. A future `EventSink` implementation (see
// apps/worker/src/consumer/events.consumer.ts's `EventSink`/`EVENT_SINK`
// — the seam this class is built to plug into, though that wiring is
// also a later task) simply instantiates `BatchAccumulator<CaptureEvent>`
// and forwards `sink.handle(event)` to `add(event)`.
//
// FLUSH CALLBACK SIGNATURE — `(events, batchId) => Promise<void>`: the
// batch id travels as a second argument rather than being stamped onto
// each event, because minting it is this class's job (T3.3.1), not
// something every future flush implementation should have to strip back
// out of the array it's handed. A later task (T3.4.3) keys the R2 object
// off this same id.
//
// NO DATABASE, NO I/O HERE: the injected `flush` callback is the entire
// seam to the outside world. That is what keeps the count/interval race
// logic below fully unit-testable with vitest's fake timers
// (accumulator.test.ts) instead of needing a Postgres/R2 testcontainers
// harness the way partition-maintenance.job.ts's own
// processPartitionMaintenanceJob() needed real Postgres. [INV-4] is
// untouched either way — this class counts and times, it never inspects
// an event's contents, so no human/bot verdict is computed here.
//
// SWAP-BEFORE-INVOKE, THE CORE SAFETY PROPERTY: whichever trigger fires
// (count, interval, or a manual flushNow()), `triggerFlush()` detaches
// the current batch (clears its timer, sets `this.currentBatch` to
// `null`) SYNCHRONOUSLY, before ever calling the injected `flush`
// callback — which may itself be slow (a future Postgres/R2 write) and
// is never awaited by the trigger that caused it. Any event added while
// that callback is still in flight therefore always finds
// `this.currentBatch === null` (or a newer batch already open from a
// later add()) and opens/joins a FRESH batch with its own new id and
// timer — it can never be silently appended to (or race against) the
// array already handed to the in-flight callback. accumulator.test.ts's
// "in-flight flush" scenario exercises exactly this by holding a flush
// callback's promise open with a manually-resolved deferred and adding
// more events while it's pending.

/** Minimal logger shape this class needs — the SAME `{ error(message,
 * meta?): void }` shape apps/worker/src/consumer/events.consumer.ts's own
 * `EventsConsumerLogger` and apps/worker/src/partitions/
 * partition-maintenance.job.ts's own `PartitionMaintenanceLogger` already
 * use, deliberately not a third shape — a test can pass a plain spy
 * object, and there is still no real pino instance wired up anywhere in
 * this codebase to depend on. */
export interface BatchAccumulatorLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — writes to stdout via `console.error`, mirroring
 * the identical `consoleErrorLogger` both files named above already
 * export, as a separate instance rather than a shared import since none
 * of the three have any other reason to depend on each other. */
export const consoleErrorLogger: BatchAccumulatorLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** Invoked once per flush, with every item accumulated since the batch
 * opened (or since the last flush, whichever is more recent) and that
 * batch's own stable `batch_id`. May reject — see `runFlush()` below for
 * what happens to that rejection depending on which trigger caused the
 * flush. */
export type BatchFlushCallback<T> = (events: readonly T[], batchId: string) => Promise<void>;

export interface BatchAccumulatorOptions<T> {
  /** Item count that trips the count trigger. Source: `env.EVENT_BATCH_SIZE`. */
  readonly batchSize: number;
  /** Milliseconds since batch-open that trip the interval trigger. Source: `env.EVENT_BATCH_INTERVAL_MS`. */
  readonly batchIntervalMs: number;
  readonly flush: BatchFlushCallback<T>;
  /** Defaults to {@link consoleErrorLogger} when omitted. */
  readonly logger?: BatchAccumulatorLogger;
}

/** A batch's own snapshot: minted once when it opens (see `startBatch()`)
 * and never mutated in place afterward — `add()` always replaces
 * `this.currentBatch` with a new object carrying a new `events` array,
 * per this codebase's own immutability convention (CLAUDE.md), rather
 * than pushing onto the existing array. */
interface OpenBatch<T> {
  readonly batchId: string;
  readonly events: readonly T[];
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Accumulates items of type `T` into batches, flushing whichever of two
 * triggers fires first — see this file's own header for the full design
 * rationale. Construction validates `batchSize`/`batchIntervalMs` are
 * positive integers and throws immediately if not: both are meant to
 * arrive already Zod-validated (`env.ts`), so a bad value reaching this
 * constructor means the caller wired something up wrong, and that should
 * fail loud at construction time rather than misbehave silently later
 * (e.g. a `0` batchSize flushing every single item as its own "batch").
 */
export class BatchAccumulator<T> {
  private readonly batchSize: number;
  private readonly batchIntervalMs: number;
  private readonly flush: BatchFlushCallback<T>;
  private readonly logger: BatchAccumulatorLogger;
  private currentBatch: OpenBatch<T> | null = null;

  constructor(options: BatchAccumulatorOptions<T>) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new Error(
        `BatchAccumulator batchSize must be a positive integer; received ${options.batchSize}`,
      );
    }
    if (!Number.isInteger(options.batchIntervalMs) || options.batchIntervalMs <= 0) {
      throw new Error(
        `BatchAccumulator batchIntervalMs must be a positive integer; received ${options.batchIntervalMs}`,
      );
    }

    this.batchSize = options.batchSize;
    this.batchIntervalMs = options.batchIntervalMs;
    this.flush = options.flush;
    this.logger = options.logger ?? consoleErrorLogger;
  }

  /**
   * Adds one item to the current batch, opening a new batch first if none
   * is open. Synchronous: it never awaits the flush callback, even when
   * this call is the one that trips the count trigger — a flush the
   * callback itself makes take real time (a future Postgres/R2 write)
   * must never make `add()` itself slow, since a later real `EventSink`
   * wiring will call this once per decoded queue job. Any rejection from
   * a flush this call triggers is caught and logged (see `runFlush()`) —
   * never left to become an unhandled promise rejection, and never
   * thrown out of `add()` itself.
   */
  add(event: T): void {
    const openBatch = this.currentBatch ?? this.startBatch();
    const events = [...openBatch.events, event];
    this.currentBatch = { ...openBatch, events };

    if (events.length >= this.batchSize) {
      void this.triggerFlush().catch(() => {
        // Already logged inside runFlush() — swallowed here only to keep
        // this fire-and-forget trigger from becoming an unhandled
        // rejection. There is no caller of add() waiting on this
        // specific flush to report a failure back to.
      });
    }
  }

  /**
   * Manually flushes the current batch — the shutdown path (SIGTERM)
   * calls this so nothing accumulated-but-unflushed is lost on a
   * rollout (`terminationGracePeriodSeconds` must exceed this class's
   * own worst-case flush time — CLAUDE.md). A no-op that resolves
   * immediately when the batch is currently empty: nothing to flush is
   * not a failure. Unlike the two automatic triggers, the rejection
   * (if any) is NOT swallowed here — the caller gets it directly, in
   * addition to the same log line every flush failure produces (see
   * `runFlush()`), so shutdown code can decide how to react to a failed
   * final flush.
   */
  async flushNow(): Promise<void> {
    await this.triggerFlush();
  }

  /**
   * The current OPEN batch's item count only. Never reflects a batch
   * that has already been detached to an in-flight flush — `size()`
   * always reads `0` again immediately once a flush trigger fires, even
   * before that flush's callback has settled, since the swap to a fresh
   * (empty) batch is synchronous. Built for T3.1.7's health endpoint.
   */
  size(): number {
    return this.currentBatch?.events.length ?? 0;
  }

  private startBatch(): OpenBatch<T> {
    const batchId = newId();
    const timer = setTimeout(() => {
      void this.triggerFlush().catch(() => {
        // Same reasoning as add()'s own count-trigger catch above — this
        // firing is the interval trigger, not a caller waiting on a
        // promise, so the failure has already been reported via the log
        // line runFlush() writes before rethrowing.
      });
    }, this.batchIntervalMs);

    return { batchId, events: [], timer };
  }

  /**
   * The single choke point every trigger (count, interval, manual) goes
   * through. Detaches `this.currentBatch` to `null` and clears its timer
   * SYNCHRONOUSLY — before the injected `flush` callback is ever called
   * — so any item added afterward (however soon) opens a brand new batch
   * rather than joining the one just handed off. Resolves immediately,
   * without calling `flush` at all, when there is no open batch (a
   * manual `flushNow()` on an empty accumulator, or a stale interval
   * timer that already lost a race to the count trigger — its own timer
   * was cleared when that happened, but a timer already queued on the
   * event loop before the clear could in principle still land here; this
   * null check is what makes that landing a harmless no-op instead of an
   * empty flush).
   */
  private triggerFlush(): Promise<void> {
    const batch = this.currentBatch;
    if (batch === null) {
      return Promise.resolve();
    }

    clearTimeout(batch.timer);
    this.currentBatch = null;
    return this.runFlush(batch.events, batch.batchId);
  }

  /**
   * Calls the injected `flush` callback and, if it rejects, logs first —
   * batch id and item count only, never the items themselves (the same
   * "narrow, never the raw payload" discipline
   * apps/worker/src/consumer/events.consumer.ts's own sink-failure log
   * line follows) — then rethrows the SAME error unchanged. Every
   * trigger routes through this one method, so the log line is written
   * exactly once per failed flush regardless of which trigger caused it;
   * what differs per trigger is only whether the caller (`add()`'s
   * fire-and-forget catch vs. `flushNow()`'s bare `await`) additionally
   * propagates or swallows the rethrow.
   */
  private async runFlush(events: readonly T[], batchId: string): Promise<void> {
    try {
      await this.flush(events, batchId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `BatchAccumulator flush failed for batch ${batchId} (${events.length} event(s)): ${message}`,
        { batchId, eventCount: events.length },
      );
      throw error;
    }
  }
}
