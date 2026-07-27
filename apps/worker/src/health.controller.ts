import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EVENTS_QUEUE } from '@posta/core';
import { BATCH_ACCUMULATOR } from './consumer/events.consumer';
import { DlqService } from './consumer/dlq.service';

// T3.1.7 [E3, S3.1] — the worker's `GET /health`, replacing main.ts's own
// hand-rolled `app.use('/health', ...)` middleware (T3.1.2) that always
// answered `200 ok` regardless of the worker's actual state. Queue depth
// ALONE looks healthy while the worker is wedged — a stuck `EventsConsumer`
// (its BullMQ Worker paused forever on a hung `sink.handle()`, say) can
// leave `EVENTS_QUEUE` sitting at a small, unremarkable depth while nothing
// is actually being drained. `last_flush_age_ms` (`BatchAccumulator.
// lastFlushAgeMs()`, T3.1.7's own addition to accumulator.ts) is the signal
// that actually distinguishes idle-and-fine from stuck: it only advances on
// a SUCCESSFUL flush, so it keeps growing for as long as nothing is
// genuinely landing in Postgres, independent of what the queue's own depth
// happens to read.
//
// A NARROW, DOUBLE-FRIENDLY SHAPE PER DEPENDENCY, NOT THE CONCRETE
// `Queue`/`BatchAccumulator<CaptureEvent>` TYPES: same "minimal injected
// shape" discipline this epic already established (shutdown.ts's own
// `FlushableAccumulator`, its header explains why) — this controller only
// ever calls three methods total across three dependencies, so a unit test
// can construct it directly against three plain object doubles (no real
// BullMQ `Queue`, no real Postgres-backed `BatchAccumulator`, no
// `@nestjs/testing`) and drive both the 200 and 503 branches with vitest's
// fake timers alone. `@InjectQueue`/`@Inject` are decorators, independent
// of the parameter's own declared TS type, so production DI still resolves
// the real `Queue`/`DlqService`/`BatchAccumulator<CaptureEvent>` instances
// through these narrower interfaces with zero runtime difference.
//
// [INV-4] This endpoint reports operational metrics ONLY — queue/DLQ
// depth, a flush-staleness boolean, and a raw item count. Nothing here
// inspects an event's contents or computes anything resembling a
// human/bot verdict; that stays out of the worker entirely, per that
// invariant.

/** The DI token `AppModule.forRoot()` registers `EVENT_BATCH_INTERVAL_MS`
 * under, for this controller's own staleness threshold (`FLUSH_STALE_
 * MULTIPLIER` below) — a Symbol, same discipline as every other injected
 * primitive in this epic (`SHUTDOWN_TIMEOUT_MS`, `BATCH_ACCUMULATOR`). */
export const FLUSH_INTERVAL_MS = Symbol('FLUSH_INTERVAL_MS');

/** `last_flush_age_ms` trips the 503 branch once it exceeds this many
 * MULTIPLES of the flush interval — the plan's own literal number
 * (docs/plan/03-event-pipeline.md, T3.1.7: "answers 503 when
 * last_flush_age_ms exceeds three flush intervals"). A named constant
 * rather than an inline `3` so a future change to the threshold is a
 * one-line diff with a place to explain WHY, not a magic number a reader
 * has to cross-reference against the plan to understand. */
export const FLUSH_STALE_MULTIPLIER = 3;

/** The exact set of BullMQ job states `queue_depth` counts — mirrors
 * `DlqService.depth()`'s own already-reviewed set (dlq.service.ts) for the
 * identical reason given there: every state a job not yet drained could
 * plausibly be sitting in, `'completed'`/`'failed'` deliberately excluded
 * (a job that finished, either way, is no longer "depth"). */
const QUEUE_DEPTH_JOB_TYPES = ['waiting', 'active', 'delayed', 'paused'] as const;

/** The minimal shape this controller needs from `EVENTS_QUEUE`'s injected
 * `Queue` — narrowed to exactly the job-type union `QUEUE_DEPTH_JOB_TYPES`
 * ever passes, not BullMQ's own broader `JobType`, per this file's own
 * "narrow, double-friendly shape" header note. */
export interface HealthQueue {
  getJobCountByTypes(...types: (typeof QUEUE_DEPTH_JOB_TYPES)[number][]): Promise<number>;
}

/** The minimal shape this controller needs from `DlqService` — `depth()`
 * only, not `send()`, which this endpoint has no use for. */
export interface HealthDlq {
  depth(): Promise<number>;
}

/** The minimal shape this controller needs from the shared
 * `BatchAccumulator<CaptureEvent>` — `size()` (already built for this task,
 * accumulator.ts) and `lastFlushAgeMs()` (T3.1.7's own addition to that
 * same file), neither of which this controller ever calls `add()`/
 * `flushNow()` alongside. */
export interface HealthAccumulator {
  size(): number;
  lastFlushAgeMs(): number;
}

/** The exact response body `GET /health` returns, on both the 200 and the
 * 503 branch — the plan's own literal field list (T3.1.7), snake_case
 * because this is a wire shape read by an operator/Kubernetes probe, not
 * an internal TS value (mirrors `CaptureEvent`'s own snake_case
 * discipline for the same reason, packages/contracts/src/capture.ts). */
export interface WorkerHealthStatus {
  readonly status: 'ok' | 'unhealthy';
  readonly queue_depth: number;
  readonly dlq_depth: number;
  readonly last_flush_age_ms: number;
  readonly batch_size: number;
}

@Controller()
export class HealthController {
  constructor(
    @InjectQueue(EVENTS_QUEUE) private readonly eventsQueue: HealthQueue,
    @Inject(DlqService) private readonly dlq: HealthDlq,
    @Inject(BATCH_ACCUMULATOR) private readonly accumulator: HealthAccumulator,
    @Inject(FLUSH_INTERVAL_MS) private readonly flushIntervalMs: number,
  ) {}

  /**
   * Always computes and returns the full body (this file's own
   * `WorkerHealthStatus`) regardless of health — an operator/dashboard
   * reading a 503's own JSON body gets exactly the same fields a 200
   * would have carried, never a bare error string. The ONLY thing that
   * differs between the two outcomes is the HTTP status code itself
   * (`HttpException` with an object `response` is returned by Nest's
   * default exception filter AS-IS — verified against the installed
   * @nestjs/common source — so the 503 body is not a re-shaped copy).
   */
  @Get('health')
  async getHealth(): Promise<WorkerHealthStatus> {
    const [queueDepth, dlqDepth] = await Promise.all([
      this.eventsQueue.getJobCountByTypes(...QUEUE_DEPTH_JOB_TYPES),
      this.dlq.depth(),
    ]);

    const lastFlushAgeMs = this.accumulator.lastFlushAgeMs();
    const staleThresholdMs = this.flushIntervalMs * FLUSH_STALE_MULTIPLIER;
    const isStale = lastFlushAgeMs > staleThresholdMs;

    const body: WorkerHealthStatus = {
      status: isStale ? 'unhealthy' : 'ok',
      queue_depth: queueDepth,
      dlq_depth: dlqDepth,
      last_flush_age_ms: lastFlushAgeMs,
      batch_size: this.accumulator.size(),
    };

    if (isStale) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }
}
