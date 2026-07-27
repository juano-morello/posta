import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { z } from 'zod';
import { EVENTS_DLQ_QUEUE, EVENTS_QUEUE, eventJobSchema } from '@posta/core';
import { redactCredentialsFromMessage, type CaptureEvent } from '@posta/contracts';

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

/** The job name every DLQ routing `add()` call uses — mirrors
 * apps/api/src/redirect/enqueue.ts's own `CAPTURE_JOB_NAME` precedent (a
 * named export rather than a literal duplicated at every call site,
 * including tests). One name for `EVENTS_DLQ_QUEUE` regardless of WHY a
 * job landed there — `EventsDlqJobPayload.reason` (below) is what
 * distinguishes T3.1.4's `'schema-validation-failed'` from T3.1.5's
 * future `'attempts-exhausted'`, not the job name. */
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

function toDlqIssues(issues: z.ZodError['issues']): EventsDlqIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * `EVENTS_DLQ_QUEUE`'s own job payload for a job that never even reached
 * `sink.handle()` — routed here straight out of `eventJobSchema`
 * validation, T3.1.4's own reason. `reason` is a literal (not a shared
 * union with T3.1.5's future variant) deliberately: this file only ever
 * produces `'schema-validation-failed'`, and widening the type to
 * include a reason this file can never actually emit would just be
 * guessing at T3.1.5's own shape ahead of that task.
 */
export interface EventsDlqJobPayload {
  readonly reason: 'schema-validation-failed';
  /** The job's `data`, byte-for-byte as BullMQ delivered it — including
   * whatever made it fail `eventJobSchema` (e.g. an invariant-6-violating
   * `ip` key). Deliberately `unknown`, never `CaptureEvent`: this is
   * exactly the payload that did NOT decode as one. */
  readonly rawPayload: unknown;
  readonly issues: readonly EventsDlqIssue[];
  readonly originalJobId: string;
  /** ISO 8601, `new Date().toISOString()` — same wire format
   * `CaptureEvent.occurred_at` (packages/contracts/src/capture.ts) uses,
   * for the same reason: a `Date` value would not survive this job's own
   * BullMQ round-trip through Redis intact. */
  readonly failedAt: string;
}

/** The default `EventSink` — does nothing. Production wiring
 * (app.module.ts) uses this until T3.3.1 provides a real one; tests pass
 * their own substitute instead via `AppModuleConfig.eventSink`. */
@Injectable()
export class NoopEventSink implements EventSink {
  async handle(_event: CaptureEvent): Promise<void> {
    // Intentionally empty — see this file's own header.
    void _event;
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
    @InjectQueue(EVENTS_DLQ_QUEUE) private readonly dlqQueue: Queue<EventsDlqJobPayload>,
  ) {
    super();
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
      this.logger.error(
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
    const payload: EventsDlqJobPayload = {
      reason: 'schema-validation-failed',
      rawPayload: job.data,
      issues,
      originalJobId,
      failedAt: new Date().toISOString(),
    };

    try {
      await this.dlqQueue.add(EVENTS_DLQ_JOB_NAME, payload);
    } catch (dlqError) {
      const dlqErrorMessage = dlqError instanceof Error ? dlqError.message : String(dlqError);
      // An INFRASTRUCTURE failure (EVENTS_DLQ_QUEUE itself unreachable),
      // not a validation failure a retry could fix — but there is
      // nowhere safer for this job to land than back into EVENTS_QUEUE's
      // own retry/backoff, so it is re-thrown below rather than silently
      // dropped. `redactCredentialsFromMessage`: `dlqErrorMessage`
      // originates from OUR OWN Redis client, the same category
      // `enqueue.ts`'s header describes, not from the untrusted payload.
      this.logger.error(
        redactCredentialsFromMessage(
          `Job ${originalJobId} failed eventJobSchema validation AND failed to route to ` +
            `${EVENTS_DLQ_QUEUE}: ${dlqErrorMessage}`,
        ),
        { jobId: job.id },
      );
      throw dlqError;
    }

    this.logger.error(
      `Job ${originalJobId} failed eventJobSchema validation; routed to ${EVENTS_DLQ_QUEUE} ` +
        `(${issues.length} issue(s)), job acked with no retry`,
      { jobId: job.id },
    );
  }
}
