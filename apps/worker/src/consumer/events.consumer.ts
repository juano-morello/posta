import { Inject, Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { EVENTS_QUEUE, eventJobSchema } from '@posta/core';
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
// DECODE FAILURES ARE NEVER SILENT: `eventJobSchema` (packages/core,
// T3.1.1) is `.strict()` — a job whose data doesn't parse (a malformed
// payload, or one carrying a stray `ip` key, invariant 6) throws instead
// of being swallowed or handed to the sink half-validated. Throwing
// inside `process()` is BullMQ's own documented failure signal: the
// Worker catches it and runs its normal attempts/backoff machinery
// (EVENTS_JOB_OPTIONS, set producer-side in packages/core). A payload
// that can't parse will never parse on a retry either, but routing that
// dead job straight to EVENTS_DLQ_QUEUE instead of burning all 5
// attempts first is T3.1.4's job, not this one (see events-queue.ts's
// own header). Never a human/bot verdict here either [INV-4] — this
// class only decodes and hands off.
//
// [T3.1.3 fix-forward, silent-failure review] REACHING BULLMQ IS NOT THE
// SAME AS BEING VISIBLE: both failure paths in `process()` (a decode
// failure and a rejecting `sink.handle()`) always propagated correctly
// to BullMQ's own retry/attempts machinery via the thrown/rethrown error
// — neither was ever silently swallowed. But until this fix, that error
// only ever landed in BullMQ's Redis job hash (`job.failedReason`),
// invisible to stdout/kubectl logs unless someone thought to query job
// state by hand — not "full context in server logs" (CLAUDE.md). Both
// paths now log FIRST, through an injected `EventsConsumerLogger`, THEN
// re-throw the SAME error unchanged, so BullMQ's retry behavior is
// byte-for-byte what it was before this fix. What gets logged is
// deliberately narrow: job id / event_id / link_id / tenant_id, never
// the raw job payload or a caught error's full object graph (mirrors
// r2/client.ts (T3.4.1)'s own caution) — a payload that failed
// `.strict()` validation is exactly the shape invariant 6 exists to keep
// out of logs, and once T3.3.1's real accumulator can throw here, its
// errors may originate from Postgres/R2 clients whose own `.message`
// can embed connection-string credentials the same way
// apps/api/src/redirect/enqueue.ts's header describes for Redis —
// `redactCredentialsFromMessage` (the same redactor that call site
// already uses) is applied here for the same reason.

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
  ) {
    super();
  }

  async process(job: Job<unknown>): Promise<void> {
    const parsed = eventJobSchema.safeParse(job.data);
    if (!parsed.success) {
      const message = redactCredentialsFromMessage(
        `Job ${job.id ?? '(no id)'} failed eventJobSchema validation: ${parsed.error.message}`,
      );
      // Logged BEFORE throwing, then the SAME error is thrown unchanged
      // below — see this file's own fix-forward header for why. Only the
      // job id goes into `meta`, never `job.data` itself: that payload is
      // exactly what just failed `.strict()` validation, so it is not
      // safe to assume it is invariant-6-clean.
      this.logger.error(message, { jobId: job.id });
      throw new Error(message, { cause: parsed.error });
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
}
