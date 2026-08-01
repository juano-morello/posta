import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { BATCH_ACCUMULATOR, EventsConsumer } from './events.consumer';

// T3.1.6 [E3, S3.1] — the task that makes in-memory batching SAFE rather
// than merely fast (this file's own plan entry, docs/plan/
// 03-event-pipeline.md). `BatchAccumulator` (T3.3.1) buffers events in
// memory between flushes; without this provider, a rolling deploy's
// SIGTERM would kill the process mid-batch and silently drop every event
// accumulated since the last flush. `ShutdownService.onModuleDestroy()`
// is Nest's own destroy hook (`app.enableShutdownHooks(['SIGTERM'], ...)`,
// main.ts, T3.1.2 — `callDestroyHook()` walks every provider
// automatically, exactly as that file's own header already anticipated).
//
// [T3.5.4 — REDESIGNED, THE ORIGINAL SEQUENCE DEADLOCKS UNDER THE NEW
// accumulator.add() CONTRACT] The original sequence here was two awaited
// steps: `worker.pause()` (no argument — waits for every in-flight
// `process()` call to return before resolving), THEN
// `accumulator.flushNow()`. That was correct back when `add()` was
// `void`-returning and fire-and-forget: every in-flight `process()` call
// returned almost immediately regardless of whether its batch had
// flushed, so by the time `pause()`'s own wait resolved, every active
// job had already called `add()`, and `flushNow()` afterward was both
// safe and sufficient. Once `add()` started returning a `Promise<void>`
// that only settles when ITS batch flushes (accumulator.ts's own T3.5.4
// header), that ordering DEADLOCKS: `pause()` (no argument) internally
// awaits BullMQ's own `Worker.whenCurrentJobsFinished()`, which does not
// resolve until every in-flight `process()` call has returned — but those
// calls are now blocked awaiting their own `add()`, which won't resolve
// until a flush happens — and the flush that would unblock them is the
// NEXT line, never reached. Verified by reading the installed
// bullmq@5.80.10 source directly (`Worker.pause`/`whenCurrentJobsFinished`,
// node_modules/bullmq/dist/cjs/classes/worker.js), not assumed.
//
// THE NEW SEQUENCE, IN drain() BELOW:
//   1. `this.eventsConsumer.worker.pause(true)` — `doNotWaitActive: true`
//      sets `this.paused = true` SYNCHRONOUSLY and returns WITHOUT
//      waiting for any in-flight job, which is exactly what avoids the
//      deadlock above: no NEW job is dispatched to `process()` after this
//      resolves (BullMQ's own main-loop fetch guard checks `!this.paused`
//      before ever issuing another Redis fetch), but whatever is already
//      in flight (or already fetched, mid-dispatch) stays exactly that —
//      in flight — until this class unblocks it.
//   2. A poll loop: while `this.eventsConsumer.pendingJobCount > 0` (this
//      class's OWN counter of in-flight `process()` calls — see
//      events.consumer.ts's own header for why it exists instead of
//      calling BullMQ's `whenCurrentJobsFinished()` directly) OR
//      `this.accumulator.size() > 0` (something accumulated that no
//      trigger has flushed yet), call `flushNow()` to unblock whatever is
//      currently waiting, then wait a short, fixed interval
//      (`DRAIN_POLL_INTERVAL_MS`) before checking again. This closes a
//      narrower race than the deadlock above: a job BullMQ already pulled
//      off Redis before `pause(true)` ran, but had not yet reached
//      `process()`/`add()` at the moment of THIS loop's most recent
//      `flushNow()` call, would otherwise open a fresh batch that nothing
//      ever flushes. Repeating the flush on every poll tick, rather than
//      once, is what catches that straggler on the NEXT tick instead of
//      never.
// Bounded either way: `drain()` (both steps together) is raced against
// `shutdownTimeoutMs` (SHUTDOWN_TIMEOUT_MS, env.ts) — see `withTimeout()`
// below. `flushNow()`'s own contract (accumulator.ts) is unchanged:
// "await the callback, propagate its rejection to ME" — a genuine flush
// failure (Postgres/R2 down) inside this loop propagates out of `drain()`
// immediately, exactly as the single-shot call it replaces already did;
// this loop does not retry a rejected flush on its own.
//
// WHY THIS CANNOT LOSE EVENTS EVEN IF IT DOESN'T CATCH EVERY STRAGGLER —
// this is the deeper reason T3.5.4 exists, and it makes the loop above a
// best-effort GRACEFULNESS optimization, not the thing standing between
// an event and permanent loss: under the OLD `void`-returning `add()`, a
// job that missed this file's own flush window was ALREADY marked
// BullMQ-`'completed'` (acked, no lock, nothing left to redeliver) the
// instant it was accumulated — losing that race lost the event, full
// stop. Under the NEW contract, a straggler job that this loop genuinely
// can't catch before `SHUTDOWN_TIMEOUT_MS` elapses is still sitting
// inside an ACTIVE, un-acked `process()` call when `main.ts`'s
// `useProcessExit: true` calls `process.exit(0)` — its BullMQ job was
// NEVER marked completed, so it has no lock left renewing once this
// process is gone, and BullMQ's own stalled-job mechanism redelivers it
// to the next worker exactly the way T3.5.4's own e2e-kill-recovery test
// proves for a real SIGKILL. A slow/imperfect graceful drain therefore
// degrades to "redelivered and reprocessed on next boot" instead of
// "gone" — the property this whole task exists to guarantee.
//
// WHAT HAPPENS WHEN THE TIMEOUT FIRES — the task brief's own explicit
// open question, decided and documented here: `onModuleDestroy()`
// SWALLOWS the timeout (and any other `drain()` rejection) after logging
// it loudly, and resolves normally. It does NOT rethrow. Two reasons:
//   - `useProcessExit: true` (main.ts) exits 0 if the destroy chain
//     completes without throwing, 1 if any hook throws (Nest's own
//     `listenToShutdownSignals`). A timeout here is an ANTICIPATED,
//     designed-for outcome — the entire reason `SHUTDOWN_TIMEOUT_MS`
//     exists — not a crash. Exiting 1 would make Kubernetes treat a slow
//     Postgres/R2 blip as a container crash (crash-loop backoff,
//     crash-alerting), which is a worse operational signal than a clean,
//     loudly-logged, exit-0 shutdown that already reported exactly what
//     happened.
//   - This mirrors `BatchAccumulator`'s OWN established precedent
//     (accumulator.ts, T3.3.1): a flush failure on either automatic
//     trigger is logged and swallowed, never left to become an unhandled
//     rejection. `ShutdownService` is `flushNow()`'s direct caller, and
//     its whole job is "make a best effort, bounded, then let the
//     process go" — swallowing after logging is the same philosophy
//     applied one level up, not a new one.
// [T3.5.4 — REVISED] Events accumulated since the last flush are NO
// LONGER silently lost when this timeout fires, per the "WHY THIS CANNOT
// LOSE EVENTS" section above — they are, at worst, redelivered to the
// next worker instead of landing during THIS process's own graceful
// shutdown. What the timeout genuinely costs is gracefulness (a batch
// that could have flushed cleanly here instead round-trips through
// BullMQ's stalled-job detection first, adding latency before it lands),
// not durability — which is exactly the contract this task exists to
// deliver: safe-by-default batching with a named, observable, but no
// longer data-losing failure mode.
//
// OUT OF SCOPE, DELIBERATELY: this provider does not close the worker's
// Postgres connection pool. `main.ts`'s `useProcessExit: true` calls
// `process.exit(0)` immediately after this destroy chain resolves, which
// tears down every open socket (including an un-`.end()`'d `pg.Pool`) at
// the OS level regardless — the only thing an explicit `pool.end()` here
// would buy is a marginally cleaner TCP close from Postgres's own
// perspective, not any additional durability or resource-leak
// protection, and adding it would reintroduce exactly the kind of
// unbounded-await risk `SHUTDOWN_TIMEOUT_MS` exists to eliminate (a
// wedged flush's own checked-out client would make `pool.end()` hang
// too). `app.module.ts` instead guards the worker's pool with a
// `pool.on('error', ...)` listener — a live-process safety net against an
// idle connection's backend error becoming an uncaught exception, a
// different concern from shutdown entirely.

/** Minimal logger shape this file needs — the SAME `{ error(message,
 * meta?): void }` shape every other file in this epic already uses
 * (accumulator.ts's `BatchAccumulatorLogger`, flush.ts's
 * `FlushBatchLogger`, events.consumer.ts's `EventsConsumerLogger`),
 * deliberately not a fifth shape. */
export interface ShutdownLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — writes to stderr via `console.error`, a SEPARATE
 * instance from the other three files' own identically-shaped constants
 * of the same name, for the same reason those already give: none of the
 * four have any other reason to depend on each other. */
export const consoleErrorLogger: ShutdownLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** The DI token `ShutdownService` injects its bounded-wait budget
 * through — already-validated `env.SHUTDOWN_TIMEOUT_MS` (env.ts, T3.1.6),
 * passed down from main.ts through `AppModuleConfig.shutdownTimeoutMs`
 * (app.module.ts), never re-read from `process.env` here. Same
 * Symbol-token discipline as `EVENT_SINK`/`EVENTS_CONSUMER_LOGGER`/
 * `BATCH_ACCUMULATOR`. */
export const SHUTDOWN_TIMEOUT_MS = Symbol('SHUTDOWN_TIMEOUT_MS');

/** The DI token `ShutdownService` injects its `ShutdownLogger` through —
 * same override shape as `EVENTS_CONSUMER_LOGGER`: production
 * (main.ts/app.module.ts) leaves `AppModuleConfig.shutdownLogger` unset
 * and gets `consoleErrorLogger`; shutdown.test.ts substitutes a spy to
 * assert the timeout path actually logs. */
export const SHUTDOWN_LOGGER = Symbol('SHUTDOWN_LOGGER');

/** Minimal shape `ShutdownService` needs from the shared
 * `BatchAccumulator<CaptureEvent>` — `flushNow()`, and, as of [T3.5.4],
 * `size()` too: `drain()`'s own poll loop below needs to know whether the
 * accumulator is still holding anything, not just how to flush it. Still
 * not that class's FULL surface (`add()` has no reason to be reachable
 * from here). Kept as its own narrow interface (rather than importing the
 * concrete `BatchAccumulator<CaptureEvent>` type directly) so this class
 * stays testable against a plain object double, the same "minimal
 * injected shape" discipline every logger interface in this epic already
 * follows — `BatchAccumulator`'s constructor parameters are all
 * `private`, so a literal object can never structurally satisfy the
 * concrete class type itself (TypeScript's nominal typing for private
 * members), only an interface like this one. */
export interface FlushableAccumulator {
  flushNow(): Promise<void>;
  size(): number;
}

/** Distinguishes "the bounded race itself timed out" from "`drain()`
 * rejected for some other reason" (e.g. `flushNow()` propagating a real
 * flush error, or `worker.pause()` itself throwing) — `onModuleDestroy()`
 * logs a different, more specific message for each, rather than
 * flattening both into one generic "shutdown failed" line. */
class ShutdownTimeoutError extends Error {}

/** [T3.5.4] `drain()`'s own poll interval — see this file's own header,
 * "THE NEW SEQUENCE", step 2. Short enough to catch a straggler job
 * (one already fetched off Redis before `pause(true)` ran, reaching
 * `process()`/`add()` for the first time only after this loop's most
 * recent flush) within a handful of ticks, without spinning tight enough
 * to burn CPU pointlessly while waiting — this only runs during shutdown,
 * a brief window, but every tick still does a real (if often no-op)
 * `flushNow()` call. */
const DRAIN_POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `onModuleDestroy` for the worker's BullMQ consumer + in-memory batch:
 * pauses the consumer (stops it claiming NEW jobs), drains whatever the
 * accumulator is still holding — including from jobs still finishing up
 * — and bounds that whole sequence by `SHUTDOWN_TIMEOUT_MS` so a wedged
 * flush cannot block a rollout forever. See this file's own header for
 * the full design rationale, including the deliberate choice to swallow
 * (never rethrow) a timeout after logging it, and why a timeout no longer
 * means data loss the way it used to before [T3.5.4].
 */
@Injectable()
export class ShutdownService implements OnModuleDestroy {
  constructor(
    private readonly eventsConsumer: EventsConsumer,
    @Inject(BATCH_ACCUMULATOR) private readonly accumulator: FlushableAccumulator,
    @Inject(SHUTDOWN_TIMEOUT_MS) private readonly shutdownTimeoutMs: number,
    @Inject(SHUTDOWN_LOGGER) private readonly logger: ShutdownLogger,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.withTimeout(this.drain(), this.shutdownTimeoutMs);
    } catch (error) {
      if (error instanceof ShutdownTimeoutError) {
        this.safeLog(
          `${error.message}; proceeding with process exit — any job still active at this ` +
            'point stays un-acked in BullMQ (its own lock will expire) and is redelivered to ' +
            'the next worker rather than lost. See apps/worker/src/consumer/shutdown.ts for ' +
            'why this is swallowed rather than rethrown, and why it is safe to.',
          { shutdownTimeoutMs: this.shutdownTimeoutMs },
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.safeLog(
        `Graceful shutdown's pause+drain sequence failed (not a timeout): ${message}; ` +
          'proceeding with process exit regardless.',
      );
    }
  }

  /** The bounded sequence itself — see this file's own header ("THE NEW
   * SEQUENCE") for the full rationale, including why the original
   * single-shot `pause()` (no argument) + one `flushNow()` call deadlocks
   * under [T3.5.4]'s own `accumulator.add()` contract change, and why a
   * poll loop — not a second single-shot pair — is what closes the
   * narrower straggler-job race that `pause(true)` alone leaves open. */
  private async drain(): Promise<void> {
    await this.eventsConsumer.worker.pause(true);

    while (this.eventsConsumer.pendingJobCount > 0 || this.accumulator.size() > 0) {
      await this.accumulator.flushNow();
      if (this.eventsConsumer.pendingJobCount > 0) {
        await sleep(DRAIN_POLL_INTERVAL_MS);
      }
    }
  }

  /** Races `promise` against a `timeoutMs` timer, rejecting with a
   * {@link ShutdownTimeoutError} if the timer wins — never leaves a
   * dangling timer behind either way (`clearTimeout` runs on both the
   * resolve and the reject path of `promise` itself). Deliberately does
   * NOT cancel `promise` when the timer wins: neither BullMQ's
   * `Worker.pause()` nor `BatchAccumulator.flushNow()` expose a
   * cancellation seam, so `promise` keeps running in the background
   * regardless — this only stops `onModuleDestroy()` from waiting on it
   * any longer, which is exactly what "bounded" means here.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ShutdownTimeoutError(
            `Shutdown sequence exceeded SHUTDOWN_TIMEOUT_MS=${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** [silent-failure fix, matching precedent] Same guard as
   * `EventsConsumer.safeLog()`/`BatchAccumulator.runFlush()`'s own logger
   * try/catch (T3.1.5/T3.3.1 review rounds, for the identical risk): a
   * THROWING logger must never replace `onModuleDestroy()`'s own control
   * flow (which, either way, is "there's nothing else to do — resolve
   * normally and let the process exit") with the logger's own exception.
   */
  private safeLog(message: string, meta?: Record<string, unknown>): void {
    try {
      this.logger.error(message, meta);
    } catch {
      // The logger itself failed — nothing further to do about that
      // here; onModuleDestroy() resolves regardless, same as if logging
      // had never been attempted.
    }
  }
}
