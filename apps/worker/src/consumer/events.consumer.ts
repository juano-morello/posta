import { Inject, Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';
import { EVENTS_QUEUE, eventJobSchema } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';

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
  constructor(@Inject(EVENT_SINK) private readonly sink: EventSink) {
    super();
  }

  async process(job: Job): Promise<void> {
    const parsed = eventJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(
        `Job ${job.id ?? '(no id)'} failed eventJobSchema validation: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }

    await this.sink.handle(parsed.data);
  }
}
