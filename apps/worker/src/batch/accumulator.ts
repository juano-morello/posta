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
// [T3.5.4 — DURABILITY, THE CONTRACT INVERTS] `add()` used to be
// genuinely fire-and-forget: it returned `void`, never awaited the flush
// callback even when its own call was the one that tripped the count
// trigger, and any rejection from a triggered flush was caught and
// logged INSIDE this class, never surfaced to `add()`'s own caller. That
// was deliberate at the time (S3.3's own framing: a flush the callback
// itself makes slow — a real Postgres/R2 write — must never make `add()`
// itself slow) but it had a consequence nobody traced through until
// T3.5.4: `apps/worker/src/consumer/events.consumer.ts`'s
// `AccumulatingEventSink.handle()` forwarded straight to `add()` and
// therefore resolved the INSTANT an event was handed to this class — long
// before that event's batch ever reached Postgres/R2. BullMQ's own
// `EventsConsumer.process()` awaits `sink.handle()` and marks the job
// `'completed'` the moment it resolves, so an event sitting in a partial,
// still-open batch looked "done" to BullMQ's own bookkeeping — no
// expiring lock, nothing left for a second worker to redeliver — while it
// was, in fact, only sitting in this class's memory. A SIGKILL between
// "accumulated" and "flushed" lost it permanently and silently; proven
// empirically before this class changed (see shutdown.ts's own header
// for the redesign this forced on the shutdown path too).
//
// `add()` now returns `Promise<void>` — resolving or rejecting once the
// batch THIS SPECIFIC event landed in actually settles, one way or the
// other (see the per-batch `waiters` list on `OpenBatch<T>` below).
// `add()`'s own BODY is exactly as synchronous as it ever was — the event
// is pushed, the batch is swapped, a promise is constructed and handed
// back — none of that blocks on I/O, and a triggered flush is still
// fire-and-forget from `add()`'s OWN perspective (`void
// this.triggerFlush().catch(...)`, unchanged below). What changed is that
// the RETURNED promise now carries the real outcome, so a caller who
// needs durability (`AccumulatingEventSink.handle()`) can `await` it, and
// BullMQ only acks the job once its event has genuinely reached the flush
// callback's own stores. A caller with no durability need remains free to
// call `void accumulator.add(x).catch(() => {})` — this class does not
// enforce that every caller awaits, it only makes the information
// available.
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
// the current batch — its `events`, and now also its `waiters` (T3.5.4:
// one per `add()` call still waiting on this batch's outcome) — clears
// its timer, and sets `this.currentBatch` to `null`, SYNCHRONOUSLY,
// before ever calling the injected `flush` callback — which may itself be
// slow (a real Postgres/R2 write) and is never awaited by the trigger
// that caused it. Any event added while that callback is still in flight
// therefore always finds `this.currentBatch === null` (or a newer batch
// already open from a later add()) and opens/joins a FRESH batch with its
// own new id, its own new (empty) waiter list, and its own timer — it can
// never be silently appended to (or race against) the array/waiters
// already handed to the in-flight callback. accumulator.test.ts's
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

/** Production default — writes to stderr via `console.error`, mirroring
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

/** [T3.5.4] One per `add()` call still waiting on ITS batch's outcome —
 * `resolve`/`reject` are the executor callbacks off the `Promise<void>`
 * that specific `add()` call returned. Never called directly by anything
 * outside `runFlush()` (below), and never rejects/resolves more than once
 * per batch (a batch settles exactly once, success or failure, per this
 * class's own "swap before invoke" design). */
interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** A batch's own snapshot: minted once when it opens (see `startBatch()`)
 * and never mutated in place afterward — `add()` always replaces
 * `this.currentBatch` with a new object carrying a new `events` array
 * (and, per [T3.5.4], a new `waiters` array), per this codebase's own
 * immutability convention (CLAUDE.md), rather than pushing onto the
 * existing arrays. `waiters[i]` corresponds to `events[i]` by construction
 * (both arrays only ever grow by exactly one element per `add()` call,
 * together) — nothing here needs a shared index to be read back out,
 * since every waiter in a batch settles identically, alongside every
 * other waiter in that SAME batch, the instant that batch's own flush
 * settles. */
interface OpenBatch<T> {
  readonly batchId: string;
  readonly events: readonly T[];
  readonly waiters: readonly Waiter[];
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
  // [T3.1.7] Construction counts as an implicit "flush" for staleness
  // purposes — a freshly booted accumulator with nothing flushed yet must
  // report a small age, not look instantly stale to the health endpoint
  // this field exists for (see `lastFlushAgeMs()` below). Only ever
  // advanced from `runFlush()`, and only on a SUCCESSFUL flush — never on
  // construction again, never on a rejected one.
  private lastFlushAt: number = Date.now();

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
   * [T3.5.4] Adds one item to the current batch, opening a new batch
   * first if none is open, and returns a `Promise<void>` that settles
   * exactly when THIS item's batch settles — resolving on a successful
   * flush, rejecting (with the SAME error `runFlush()` logs) on a failed
   * one. This method's own BODY stays synchronous — the event is pushed,
   * the batch swapped, the promise constructed and handed back, none of
   * that awaits any I/O — so calling `add()` is still cheap and never
   * itself the slow part; a triggered flush remains fire-and-forget from
   * THIS call's own point of view (the `void this.triggerFlush().catch()`
   * below is unchanged). What the RETURNED promise now carries is
   * genuinely new: `AccumulatingEventSink.handle()`
   * (events.consumer.ts) awaits it so BullMQ never acks a job before its
   * event has actually reached the flush callback's own stores — see this
   * file's own header for the durability gap this closes. A caller with
   * no durability need is free to call
   * `void accumulator.add(x).catch(() => {})` instead.
   */
  add(event: T): Promise<void> {
    const openBatch = this.currentBatch ?? this.startBatch();
    const events = [...openBatch.events, event];

    let resolveWaiter!: () => void;
    let rejectWaiter!: (error: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const waiters = [...openBatch.waiters, { resolve: resolveWaiter, reject: rejectWaiter }];

    this.currentBatch = { ...openBatch, events, waiters };

    if (events.length >= this.batchSize) {
      void this.triggerFlush().catch(() => {
        // Already logged inside runFlush(), and every waiter for this
        // batch (including the one `settled` above resolves to) is
        // already rejected there too — swallowed here only to keep this
        // fire-and-forget TRIGGER from becoming an unhandled rejection at
        // the site that caused it. `settled` itself is a SEPARATE promise
        // object from `triggerFlush()`'s own return value, so catching
        // here has no effect on whether `settled` still rejects for this
        // call's own caller.
      });
    }

    return settled;
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

  /**
   * Milliseconds since the last flush that completed SUCCESSFULLY —
   * construction time counts as an implicit flush for this purpose (see
   * the `lastFlushAt` field's own comment above), so a freshly booted
   * accumulator with nothing flushed yet reports a small age rather than
   * looking instantly stale. A REJECTED flush does NOT advance this: the
   * batch is gone either way (this class's own "swap before invoke"
   * design, this file's own header), but a flush that keeps failing
   * (Postgres/R2 down) must keep making this number grow, since "the
   * accumulator keeps swapping in new batches that keep failing to write"
   * is exactly the kind of stuck-not-idle state T3.1.7's health endpoint
   * exists to surface. Built for T3.1.7's health endpoint, same as
   * `size()` immediately above.
   */
  lastFlushAgeMs(): number {
    return Date.now() - this.lastFlushAt;
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

    return { batchId, events: [], waiters: [], timer };
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
    return this.runFlush(batch.events, batch.batchId, batch.waiters);
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
   *
   * [T3.5.4] Also settles every `waiters` entry for this batch — resolved
   * on success, rejected (with the SAME `error` this method rethrows) on
   * failure. This is the ONE place a batch's outcome is ever decided, so
   * it is the one place every `add()` caller's own returned promise gets
   * resolved/rejected from, regardless of which of the three triggers
   * (count, interval, manual `flushNow()`) actually caused this flush.
   * `Promise`'s own `resolve`/`reject` executor callbacks never throw, so
   * no additional try/catch is needed around either loop below.
   *
   * [fix-forward, silent-failure review] The logger call itself is
   * wrapped in its own try/catch: a THROWING logger (unusual for the
   * default console.error-based consoleErrorLogger, but not impossible
   * for a future real logger integration or a misbehaving injected one)
   * must never replace the original flush error with its own — that
   * would propagate out of this method as the logger's exception, hit
   * add()'s/the interval timer's fire-and-forget `.catch(() => {})`
   * (which assumes the failure was already logged by the time it gets
   * there), and the batch's events would be gone with zero log line and
   * zero trace of why. The ORIGINAL `error` is always rethrown below
   * regardless of whether logging itself succeeded, and every waiter is
   * always rejected with that SAME original error, never the logger's.
   */
  private async runFlush(events: readonly T[], batchId: string, waiters: readonly Waiter[]): Promise<void> {
    try {
      await this.flush(events, batchId);
      // [T3.1.7] Only a SUCCESSFUL flush advances this — see
      // `lastFlushAgeMs()`'s own doc comment for why a rejecting flush
      // deliberately does NOT reach this line.
      this.lastFlushAt = Date.now();
      for (const waiter of waiters) {
        waiter.resolve();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.logger.error(
          `BatchAccumulator flush failed for batch ${batchId} (${events.length} event(s)): ${message}`,
          { batchId, eventCount: events.length },
        );
      } catch {
        // The logger itself failed — nothing further to do about that
        // here, but the ORIGINAL flush error below must still propagate
        // (and every waiter must still reject with it) regardless.
      }
      for (const waiter of waiters) {
        waiter.reject(error);
      }
      throw error;
    }
  }
}
