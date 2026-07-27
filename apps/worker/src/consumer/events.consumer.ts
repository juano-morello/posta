import { Inject, Injectable } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { EVENTS_DLQ_QUEUE, EVENTS_QUEUE, eventJobSchema } from '@posta/core';
import { redactCredentialsFromMessage, type CaptureEvent } from '@posta/contracts';
import { BatchAccumulator } from '../batch/accumulator';
import { DlqService, toDlqIssues } from './dlq.service';

// T3.1.3 [E3, S3.1] — the BullMQ CONSUMER half of the redirect hot
// path's producer/consumer split (T2.4.2 enqueues from apps/api,
// EventsConsumer drains here). `@Processor(EVENTS_QUEUE, ...)` +
// `extends WorkerHost` is `@nestjs/bullmq`'s own DI-discovered shape
// (verified against the installed v11.0.4 source, not guessed): a
// `BullExplorer` provider (registered globally by `BullModule.forRoot()`,
// app.module.ts) scans every provider in the whole application graph at
// `onModuleInit`, finds this class via its `@Processor` metadata, and
// constructs a real `bullmq.Worker` for it against whatever connection
// `BullModule.registerQueue({ name: EVENTS_QUEUE })` resolves (which
// falls back to `BullModule.forRoot()`'s shared config when the queue's
// own options don't set a connection — exactly how app.module.ts wires
// it). No hand-rolled `new Worker(...)` anywhere, matching app.module.ts
// (T3.1.2)'s own documented precedent-2 choice.
//
// SINK, NOT A DATABASE WRITE: this task lands before T3.3.1's real
// accumulator, so `process()` hands every decoded job to an injected
// `EventSink` rather than writing anywhere itself. `EventSink` is this
// consumer's entire contract with whatever happens next — a no-op today
// (`NoopEventSink`), the batching accumulator once T3.3.1 lands, and a
// substitute test double in events.consumer.test.ts, all through the
// same DI token (`EVENT_SINK`) and interface, so this file needs no
// changes when the real sink arrives.
//
// DECODE FAILURES ARE NEVER SILENT, AND NEVER RETRIED: `eventJobSchema`
// (packages/core, T3.1.1) is `.strict()` — a job whose data doesn't
// parse (a malformed payload, or one carrying a stray `ip` key,
// invariant 6) is never swallowed or handed to the sink half-validated.
// T3.1.3 originally had this branch THROW, which is BullMQ's own
// documented failure signal — the Worker would catch it and run its
// normal attempts/backoff machinery (EVENTS_JOB_OPTIONS, set
// producer-side in packages/core). T3.1.4 (this revision) replaces that:
// a payload that can't parse will never parse on a retry either
// (`eventJobSchema` doesn't change between attempts), so burning all 5
// attempts on it was pure waste. This branch now routes the job straight
// to `EVENTS_DLQ_QUEUE` (raw `job.data` plus the Zod issue list — see
// `EventsDlqJobPayload` below) and RETURNS NORMALLY instead of throwing.
// Returning normally from `process()` is what marks a BullMQ job
// 'completed' with no retry scheduled — verified against the installed
// bullmq@5.80.10 source, not assumed: `Worker.processJob`
// (node_modules/bullmq/dist/cjs/classes/worker.js) awaits
// `callProcessJob` (which invokes exactly this method, bound, as the
// Worker's `processFn` — @nestjs/bullmq's own
// dist/bull.explorer.js#handleProcessor does `instance['process'].bind
// (instance)` and passes THAT to `new Worker(...)`) and, on success (no
// throw), calls `handleCompleted` → `job.moveToCompleted(...)` directly
// — `handleFailed`/the retry path is only ever reached from
// `processJob`'s `catch` block. Never a human/bot verdict here either
// [INV-4] — this class only decodes and hands off.
//
// [T3.1.3 fix-forward, silent-failure review; superseded in part by
// T3.1.4] REACHING BULLMQ IS NOT THE SAME AS BEING VISIBLE: both failure
// paths in `process()` (a decode failure and a rejecting
// `sink.handle()`) always propagated correctly to BullMQ's own
// retry/attempts machinery via the thrown/rethrown error — neither was
// ever silently swallowed. But until that fix, the error only ever
// landed in BullMQ's Redis job hash (`job.failedReason`), invisible to
// stdout/kubectl logs unless someone thought to query job state by hand
// — not "full context in server logs" (CLAUDE.md). Both paths log
// (through an injected `EventsConsumerLogger`) with a deliberately
// narrow payload: job id / event_id / link_id / tenant_id, never the raw
// job payload or a caught error's full object graph (mirrors
// r2/client.ts (T3.4.1)'s own caution) — a payload that failed
// `.strict()` validation is exactly the shape invariant 6 exists to keep
// out of logs. [T3.1.4][security] The decode-failure branch specifically
// no longer logs `parsed.error.message` at all (T3.1.3's own version
// did) — a Zod issue message can echo back the actual invalid value
// (e.g. an enum/literal mismatch), so ANY text derived from it is
// unvalidated external input and belongs in the DLQ record only, never
// stdout. The sink-failure branch below is unaffected by this and still
// logs its error's `.message` — that string originates from OUR OWN
// sink implementation (Postgres/R2 clients, once T3.3.1 lands), not from
// unvalidated request input, and `redactCredentialsFromMessage` (the
// same redactor apps/api/src/redirect/enqueue.ts's header describes)
// still guards it against embedded connection-string credentials.
//
// [T3.1.5] A SECOND DLQ REASON, AND ONE SHARED WRITER: T3.1.4 only ever
// routed a job to `EVENTS_DLQ_QUEUE` for a decode failure
// ('schema-validation-failed', below `routeToDlq()`). T3.1.5 adds the
// OTHER failure path this class always had: a job that decodes fine but
// keeps rejecting at `sink.handle()` until it exhausts every
// `EVENTS_JOB_OPTIONS.attempts` (5). Two producers of the same DLQ shape
// is exactly the case `DlqService` (./dlq.service.ts) exists to
// consolidate — see that file's own header for the full
// parallel-vs-shared-writer discussion. `routeToDlq()` below now calls
// `DlqService.send()` instead of writing to the queue itself, and
// `onFailed()` (this task's new method) is the second caller.
//
// TELLING "WILL RETRY" FROM "TRULY DONE": BullMQ's own `'failed'` event
// fires on EVERY failed attempt, not just the final one — verified
// against the installed bullmq@5.80.10 source
// (node_modules/bullmq/dist/cjs/classes/worker.js,
// `Worker.handleFailed()`, ~line 653): it always calls `await
// job.moveToFailed(err, token, fetchNext)` and then unconditionally
// `this.emit('failed', job, err, 'active')` — the decision of whether
// THIS failure schedules a retry or ends the job happens INSIDE
// `moveToFailed`'s own `shouldRetryJob()` (job.js), before the event ever
// fires, not in a separate "is this the last one" event later.
// `moveToFailed` is also where `job.attemptsMade` gets incremented (the
// LAST thing it does, per job.js), so by the time `onFailed()` runs,
// `job.attemptsMade` already reflects the attempt that just failed: 1
// through 4 (< `job.opts.attempts`) on an attempt BullMQ has already
// silently rescheduled a retry for, and exactly `job.opts.attempts` (5,
// under `EVENTS_JOB_OPTIONS`) on the truly final one. `onFailed()`
// compares these two numbers itself — there is no separate "is this the
// last attempt" event BullMQ exposes to skip that comparison.
//
// [security, invariant 6 edge case] `onFailed()` re-validates `job.data`
// against `eventJobSchema` before deciding what to write, rather than
// trusting "it must still be valid, nothing changes between retries".
// That trust is correct in the overwhelmingly normal case — this method
// only ever runs for a job that reached `sink.handle()` at least once,
// which requires it decoded successfully on attempt 1, and `job.data`
// never changes across retries. It breaks in exactly one narrow edge
// case `routeToDlq()`'s own catch block documents below: if
// `DlqService.send()` itself throws (EVENTS_DLQ_QUEUE's own connection
// down, not a validation problem), `routeToDlq()` re-throws and the job
// retries EVENTS_QUEUE's own attempts/backoff — but the SAME schema
// failure recurs every attempt (the payload never becomes valid), so the
// job can exhaust its attempts and reach `onFailed()` with genuinely raw,
// unvalidated `job.data` — the exact case `.strict()` exists to keep an
// invariant-6-violating `ip` key out of. `onFailed()` re-checks for
// precisely this: when re-validation fails, it reports
// `reason: 'schema-validation-failed'` (with the freshly re-derived Zod
// issues) instead of `'attempts-exhausted'` — reusing `routeToDlq()`'s
// own already-reviewed "store the raw payload verbatim in the DLQ"
// decision for what is, underneath, the identical category of data,
// rather than this method inventing a second, un-reviewed redaction
// policy for the same problem.

/** The minimal contract `EventsConsumer` needs from whatever consumes a
 * decoded event next. `NoopEventSink` (below) is the only implementation
 * until T3.3.1's accumulator lands; tests substitute their own to observe
 * what the consumer actually decoded, without a database. */
export interface EventSink {
  handle(event: CaptureEvent): Promise<void>;
}

/** The DI token `EventsConsumer` injects `EventSink` through — a Symbol,
 * not a string, matching apps/api/src/redirect/resolve-redis.ts's
 * `REDIS_TIMEOUT_MARKER` precedent, so a token typo fails to resolve
 * rather than silently colliding with an unrelated string token. */
export const EVENT_SINK = Symbol('EVENT_SINK');

/** Minimal logger shape `EventsConsumer` needs — mirrors
 * apps/worker/src/partitions/partition-maintenance.job.ts's own
 * `PartitionMaintenanceLogger`/`consoleErrorLogger` (T1.3.5) and
 * apps/api/src/redirect/resolve-tenant.ts's `ResolveLogger` on the API
 * side: a `{ error(message, meta?): void }` shape, injectable, so a test
 * can pass a spy instead of a real logger (no pino instance wired up
 * anywhere in this codebase yet). Deliberately the SAME shape as those
 * two rather than a new one, per this file's own fix-forward note above. */
export interface EventsConsumerLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — `partition-maintenance.job.ts`'s own
 * `consoleErrorLogger` writes to stdout the same way; this is a separate
 * instance rather than an import because that file's `close()` and this
 * class have no other reason to depend on each other. */
export const consoleErrorLogger: EventsConsumerLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** The DI token `EventsConsumer` injects `EventsConsumerLogger` through
 * — same Symbol-token discipline as `EVENT_SINK` above. */
export const EVENTS_CONSUMER_LOGGER = Symbol('EVENTS_CONSUMER_LOGGER');

/**
 * `EventsDlqJobPayload` (and the reason/issue shapes it's built from) now
 * live in ./dlq.service.ts — DlqService is the one writer both
 * `routeToDlq()` (below) and `onFailed()` (below) call, per this file's
 * own T3.1.5 header note. Re-exported here, unchanged, purely so existing
 * callers that import the TYPE from this module (malformed-job.test.ts)
 * keep working without an import-path change — this file is no longer
 * where the shape is DEFINED.
 */
export type { EventsDlqJobPayload } from './dlq.service';

/** The default `EventSink` — does nothing. Used only as a fallback inside
 * `AppModuleConfig.eventSink`'s own default expression (app.module.ts) for
 * tests that want a sink with zero side effects; production wiring uses
 * `AccumulatingEventSink` (below) instead, now that T3.3.1's accumulator
 * and T3.3.2's flushBatch both exist for it to sit in front of. */
@Injectable()
export class NoopEventSink implements EventSink {
  async handle(_event: CaptureEvent): Promise<void> {
    // Intentionally empty — see this file's own header.
    void _event;
  }
}

/** The DI token `AppModule.forRoot()` (app.module.ts, T3.1.6) registers
 * the shared `BatchAccumulator<CaptureEvent>` instance under — a Symbol,
 * same discipline as `EVENT_SINK`/`EVENTS_CONSUMER_LOGGER` above. Exactly
 * ONE accumulator instance exists per booted app: this token is how BOTH
 * `AccumulatingEventSink` (below, feeds it via `add()`) and
 * `ShutdownService` (../consumer/shutdown.ts, drains it via `flushNow()`
 * on SIGTERM) inject the SAME instance rather than two independently
 * constructed ones that could silently drift apart. */
export const BATCH_ACCUMULATOR = Symbol('BATCH_ACCUMULATOR');

/** T3.1.6 [E3, S3.1] — the real production `EventSink`: forwards every
 * decoded `CaptureEvent` straight into the shared `BatchAccumulator`,
 * which itself flushes to Postgres (T3.3.2's `flushBatch`, via
 * `createFlushBatch`) on whichever of its own two triggers fires first,
 * or on a manual `flushNow()` at shutdown. `handle()` can never reject:
 * `BatchAccumulator.add()` is fully synchronous and, per that class's own
 * header, never throws and never propagates a flush failure back to its
 * caller — a triggered flush's own rejection is caught and logged
 * INSIDE the accumulator, never here. `EventsConsumer.process()`'s
 * try/catch around `sink.handle()` therefore exists for some OTHER
 * sink's future failure mode, not this one — this sink's own jobs always
 * reach BullMQ's 'completed' state, which is exactly what lets
 * shutdown.test.ts wait on `job.getState() === 'completed'` as its signal
 * that an event has genuinely been accumulated, not merely enqueued. */
@Injectable()
export class AccumulatingEventSink implements EventSink {
  constructor(
    @Inject(BATCH_ACCUMULATOR) private readonly accumulator: BatchAccumulator<CaptureEvent>,
  ) {}

  async handle(event: CaptureEvent): Promise<void> {
    this.accumulator.add(event);
  }
}

/** WORKER_CONCURRENCY's own default (the plan's own "default 8"). Not in
 * workerEnvSchema (env.ts, T0.3.6) yet — this task's own file list names
 * only this consumer, not env.ts, so the var is read and validated here
 * instead, at the one place it is actually consumed. */
export const DEFAULT_WORKER_CONCURRENCY = 8;

const workerConcurrencySchema = z.coerce.number().int().positive();

/**
 * Reads and validates `WORKER_CONCURRENCY`, defaulting to
 * {@link DEFAULT_WORKER_CONCURRENCY} when unset. A non-numeric,
 * non-integer, or non-positive value throws rather than silently falling
 * back to the default or coercing to some other number — an operator who
 * sets this var wrong should see a fast, loud failure at boot, not a
 * worker quietly running at the wrong concurrency. `env` defaults to
 * `process.env` but takes a parameter so this stays a pure function a
 * test can call directly, independent of the real process's environment.
 */
export function readWorkerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKER_CONCURRENCY;
  if (raw === undefined) {
    return DEFAULT_WORKER_CONCURRENCY;
  }

  const parsed = workerConcurrencySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `WORKER_CONCURRENCY must be a positive integer; received ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

/**
 * Drains EVENTS_QUEUE. Concurrency comes from `readWorkerConcurrency()`
 * at CLASS-DECORATION time (module load / boot) — the same "read once"
 * discipline env.ts's own header documents for DATABASE_URL_WORKER etc,
 * just sourced from this file instead of a schema field (see this file's
 * own header for why).
 */
@Processor(EVENTS_QUEUE, { concurrency: readWorkerConcurrency() })
@Injectable()
export class EventsConsumer extends WorkerHost {
  constructor(
    @Inject(EVENT_SINK) private readonly sink: EventSink,
    @Inject(EVENTS_CONSUMER_LOGGER) private readonly logger: EventsConsumerLogger,
    // Not `@Inject` + a Symbol token: `DlqService` is a normal
    // `@Injectable()` class provider (app.module.ts), and Nest resolves a
    // constructor parameter typed as a concrete class by that class
    // itself — the same way `NestFactory`/`ModuleRef` resolve any other
    // provider class, no token needed.
    private readonly dlq: DlqService,
  ) {
    super();
  }

  /**
   * [security/silent-failure fix, review round 1] Every `this.logger
   * .error(...)` call in this class goes through here instead of calling
   * the injected logger directly — a THROWING logger must never mask
   * whatever the SURROUNDING logic was already going to do next (rethrow
   * the real error, or simply return/continue). Same discipline
   * apps/worker/src/batch/accumulator.ts's own `runFlush()` established
   * (fix-forward, T3.3.1 review) for the identical risk, applied here
   * consistently across every call site rather than only the ones a
   * single task happened to add — a logger call this class already had
   * (`process()`'s sink-failure branch, T3.1.3) was exactly as exposed to
   * this as the two `onFailed()` added (T3.1.5).
   *
   * The risk differs by call site but the fix is the same everywhere: in
   * `process()`/`routeToDlq()`, BullMQ DOES await the promise this method
   * is called from, so an unguarded throwing logger would replace the
   * REAL error/outcome with the logger's own — strictly worse
   * information for whoever reads BullMQ's `failedReason` next, even
   * though BullMQ's own machinery would still technically catch it.
   * `onFailed()` is worse: it is a plain `@OnWorkerEvent` EventEmitter
   * listener whose return value BullMQ never awaits (verified against
   * the installed bullmq@5.80.10 source — `Worker`'s `emit('failed', ...)`
   * call, worker.js, is fire-and-forget from the emitter's own
   * perspective), so an unguarded throw there becomes a genuine unhandled
   * rejection, not something BullMQ's own machinery would catch at all.
   */
  private safeLog(message: string, meta?: Record<string, unknown>): void {
    try {
      this.logger.error(message, meta);
    } catch {
      // The logger itself failed — nothing further to do about that
      // here; the caller continues with whatever it was already going to
      // do (rethrow the original error, or simply return) regardless.
    }
  }

  async process(job: Job<unknown>): Promise<void> {
    const parsed = eventJobSchema.safeParse(job.data);
    if (!parsed.success) {
      await this.routeToDlq(job, parsed.error);
      return;
    }

    const event = parsed.data;
    try {
      await this.sink.handle(event);
    } catch (error) {
      const causeMessage = error instanceof Error ? error.message : String(error);
      this.safeLog(
        redactCredentialsFromMessage(`Sink failed to handle event ${event.event_id}: ${causeMessage}`),
        { eventId: event.event_id, linkId: event.link_id, tenantId: event.tenant_id },
      );
      // Re-throw the ORIGINAL error, unchanged — BullMQ's own
      // retry/attempts machinery must see exactly what `sink.handle()`
      // rejected with, not a wrapped/redacted copy. The redaction above
      // only ever touches what THIS class writes to its own log line.
      throw error;
    }
  }

  /**
   * T3.1.4 [security] — routes a job that failed `eventJobSchema`
   * validation to `EVENTS_DLQ_QUEUE` (raw `job.data` + the Zod issue
   * list) and RETURNS instead of throwing, so `process()`'s caller sees
   * this job as done. See this file's own header for the verified
   * bullmq semantics ("returns normally" = `job.moveToCompleted()`, no
   * retry) this relies on.
   *
   * [security] Nothing this method hands to `this.logger.error()` ever
   * contains `job.data` or a Zod issue's own `.message` — a Zod message
   * can echo back the actual invalid value, which makes it exactly as
   * unsafe to log as the raw payload itself (this file's own header
   * explains why the OLD T3.1.3 branch logging `parsed.error.message`
   * was wrong to do so). Only the job id and an ISSUE COUNT go to the
   * logger; the full `issues` array (messages included) goes to the DLQ
   * record only.
   */
  private async routeToDlq(job: Job<unknown>, error: z.ZodError): Promise<void> {
    const issues = toDlqIssues(error.issues);
    const originalJobId = job.id ?? '(no id)';

    try {
      // `attemptsMade: 1` is a literal, not `job.attemptsMade`: this path
      // NEVER retries (`process()` always returns normally after this
      // call, so the job completes on its first and only attempt), and
      // `moveToCompleted()` — the only place BullMQ itself increments
      // `attemptsMade` for a job that finishes this way (job.js) — has
      // not run yet at this point, so `job.attemptsMade` would still read
      // 0 here despite the job genuinely having run once.
      await this.dlq.send('schema-validation-failed', job.data, error, {
        originalJobId,
        attemptsMade: 1,
        issues,
      });
    } catch (dlqError) {
      const dlqErrorMessage = dlqError instanceof Error ? dlqError.message : String(dlqError);
      // An INFRASTRUCTURE failure (EVENTS_DLQ_QUEUE itself unreachable),
      // not a validation failure a retry could fix — but there is
      // nowhere safer for this job to land than back into EVENTS_QUEUE's
      // own retry/backoff, so it is re-thrown below rather than silently
      // dropped. `redactCredentialsFromMessage`: `dlqErrorMessage`
      // originates from OUR OWN Redis client, the same category
      // `enqueue.ts`'s header describes, not from the untrusted payload.
      // [T3.1.5] If this keeps failing across all of EVENTS_QUEUE's own
      // retries, the job eventually reaches `onFailed()` below with
      // genuinely raw, unvalidated `job.data` — see this file's own
      // header for why `onFailed()` re-validates rather than trusting
      // that can never happen.
      this.safeLog(
        redactCredentialsFromMessage(
          `Job ${originalJobId} failed eventJobSchema validation AND failed to route to ` +
            `${EVENTS_DLQ_QUEUE}: ${dlqErrorMessage}`,
        ),
        { jobId: job.id },
      );
      throw dlqError;
    }

    this.safeLog(
      `Job ${originalJobId} failed eventJobSchema validation; routed to ${EVENTS_DLQ_QUEUE} ` +
        `(${issues.length} issue(s)), job acked with no retry`,
      { jobId: job.id },
    );
  }

  /**
   * T3.1.5 — the OTHER DLQ path: a job that decoded fine but keeps
   * rejecting at `sink.handle()` until BullMQ's own retry machinery gives
   * up. See this file's own header for the verified BullMQ semantics this
   * relies on (`'failed'` fires on every attempt; `job.attemptsMade` vs
   * `job.opts.attempts` is the only reliable "is this truly the last one"
   * signal available inside the event itself) and for the invariant-6
   * re-validation edge case below.
   *
   * Logs once on a successful DLQ write (mirroring `routeToDlq()`'s own
   * "acked, here's where it went" line) AND, separately, once if the DLQ
   * write itself fails — never both for the same outcome. The success
   * line is genuinely new information even though the underlying failure
   * was already logged on every prior attempt (`process()`'s sink-failure
   * catch, or `routeToDlq()`'s own DLQ-write-failure catch in the edge
   * case above): "this job is now permanently dead-lettered" is a
   * distinct, operationally useful fact from "this attempt failed, a
   * retry is scheduled", and only this method knows which one just
   * happened.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<unknown>, error: Error): Promise<void> {
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (job.attemptsMade < attemptsAllowed) {
      // Not the final attempt — BullMQ has already scheduled (or is
      // about to schedule) a retry for this exact job. Either a later
      // attempt succeeds and this job is never seen again, or it fails
      // again and this handler runs once more with `attemptsMade` one
      // higher.
      return;
    }

    const originalJobId = job.id ?? '(no id)';
    const attemptsMade = job.attemptsMade;
    // [security, invariant 6] see this file's own header for why this
    // re-validation is necessary despite job.data never changing between
    // retries in the normal case.
    const parsed = eventJobSchema.safeParse(job.data);

    try {
      if (parsed.success) {
        await this.dlq.send('attempts-exhausted', parsed.data, error, {
          originalJobId,
          attemptsMade,
        });
      } else {
        await this.dlq.send('schema-validation-failed', job.data, error, {
          originalJobId,
          attemptsMade,
          issues: toDlqIssues(parsed.error.issues),
        });
      }
    } catch (dlqError) {
      const dlqErrorMessage = dlqError instanceof Error ? dlqError.message : String(dlqError);
      // Unlike `routeToDlq()`'s own DLQ-write failure, there is no retry
      // machinery left to fall back into: BullMQ has already finalized
      // this job as 'failed' (`moveToFailed()` already ran, before this
      // event even fired) by the time this handler runs, and this is a
      // plain EventEmitter listener, not a job processor whose thrown
      // error BullMQ would catch and act on — throwing here would only
      // become an unhandled rejection. The original job stays inspectable
      // in EVENTS_QUEUE itself (`removeOnFail: false`, events-queue.ts)
      // even though it never made it into the DLQ; the failure to route
      // it is still logged, loudly, with full context, rather than
      // silently dropped.
      this.safeLog(
        redactCredentialsFromMessage(
          `Job ${originalJobId} exhausted all ${attemptsMade} attempt(s) AND failed to route to ` +
            `${EVENTS_DLQ_QUEUE}: ${dlqErrorMessage}`,
        ),
        { jobId: job.id },
      );
      return;
    }

    this.safeLog(
      `Job ${originalJobId} exhausted all ${attemptsMade} attempt(s); routed to ${EVENTS_DLQ_QUEUE}`,
      { jobId: job.id },
    );
  }
}
