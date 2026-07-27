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
// THE SEQUENCE, IN ORDER, AND WHY:
//   1. `this.eventsConsumer.worker.pause()` — stops the BullMQ Worker
//      from claiming any NEW job, and waits for whatever job is already
//      in flight to finish. Verified against the installed
//      bullmq@5.80.10 source (node_modules/bullmq/dist/cjs/classes/
//      worker.js, `Worker.pause()`), not assumed: called with no
//      argument, `doNotWaitActive` is falsy, so the method sets
//      `this.paused = true` SYNCHRONOUSLY — this is what stops it
//      claiming new jobs from this exact point forward — and THEN awaits
//      `this.whenCurrentJobsFinished()` before resolving. One call
//      therefore satisfies both halves of this task's own brief
//      ("pauses the worker so no new job is claimed, awaits in-flight
//      handlers"), not two separate steps.
//   2. `this.accumulator.flushNow()` — only runs once every in-flight
//      `EventsConsumer.process()` call has already returned (step 1
//      awaited that), so nothing already inside `accumulator.add()` can
//      race a call this step is about to make. `flushNow()`'s own
//      contract (accumulator.ts) is "await the callback, propagate its
//      rejection to ME" — the direct caller here, unlike the two
//      automatic (count/interval) triggers, which swallow a flush
//      failure after logging it.
// Both steps are awaited inside `drain()`, which this provider races
// against `shutdownTimeoutMs` (SHUTDOWN_TIMEOUT_MS, env.ts) — see
// `withTimeout()` below.
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
// Some events accumulated since the last flush ARE lost when this
// timeout fires — that loss is real and this comment does not pretend
// otherwise. It is bounded (at most one batch's worth,
// `EVENT_BATCH_SIZE`) and loud (the log line below), which is the
// contract this task exists to deliver: safe-by-default batching with a
// named, observable failure mode, not silent data loss on every deploy.
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
 * `BatchAccumulator<CaptureEvent>` — `flushNow()` only, not that class's
 * full `add()`/`size()` surface, which shutdown has no use for. Kept as
 * its own narrow interface (rather than importing the concrete
 * `BatchAccumulator<CaptureEvent>` type directly) so this class stays
 * testable against a plain object double, the same "minimal injected
 * shape" discipline every logger interface in this epic already follows
 * — `BatchAccumulator`'s constructor parameters are all `private`, so a
 * literal object can never structurally satisfy the concrete class type
 * itself (TypeScript's nominal typing for private members), only an
 * interface like this one. */
export interface FlushableAccumulator {
  flushNow(): Promise<void>;
}

/** Distinguishes "the bounded race itself timed out" from "`drain()`
 * rejected for some other reason" (e.g. `flushNow()` propagating a real
 * flush error, or `worker.pause()` itself throwing) — `onModuleDestroy()`
 * logs a different, more specific message for each, rather than
 * flattening both into one generic "shutdown failed" line. */
class ShutdownTimeoutError extends Error {}

/**
 * `onModuleDestroy` for the worker's BullMQ consumer + in-memory batch:
 * pauses the consumer (awaiting its in-flight job), flushes whatever the
 * accumulator is still holding, and bounds that whole sequence by
 * `SHUTDOWN_TIMEOUT_MS` so a wedged flush cannot block a rollout forever.
 * See this file's own header for the full design rationale, including
 * the deliberate choice to swallow (never rethrow) a timeout after
 * logging it.
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
          `${error.message}; proceeding with process exit — events accumulated since the ` +
            'last flush may be lost. See apps/worker/src/consumer/shutdown.ts for why this ' +
            'is swallowed rather than rethrown.',
          { shutdownTimeoutMs: this.shutdownTimeoutMs },
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.safeLog(
        `Graceful shutdown's pause+flush sequence failed (not a timeout): ${message}; ` +
          'proceeding with process exit regardless.',
      );
    }
  }

  /** The bounded sequence itself — see this file's own header for why
   * pausing first, unconditionally, is what makes the later
   * `flushNow()` race-free against `EventsConsumer.process()`'s own
   * in-flight `accumulator.add()` calls. */
  private async drain(): Promise<void> {
    await this.eventsConsumer.worker.pause();
    await this.accumulator.flushNow();
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
