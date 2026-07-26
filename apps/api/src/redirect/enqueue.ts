import { Queue } from 'bullmq';
import { redactCredentialsFromMessage, type CaptureEvent } from '@posta/contracts';
import { Counter, type Registry } from 'prom-client';

// T2.4.2 [INV-1] — the producer half of S2.4's "redirect, then enqueue".
// This file builds the pieces: the `events` BullMQ Queue
// (createEventsQueue) and the function every redirect request calls
// AFTER res.redirect() has already been flushed (createEnqueueCapture).
// Wiring createEventsQueue into main.ts's boot sequence and composing
// resolve -> respond -> enqueue in that exact order is T2.4.3's job, not
// this one — this file makes no assumption about when or whether it is
// called, only that calling it is always safe.
//
// THE PROPERTY THIS FILE EXISTS TO GUARANTEE: a stalled queue costs
// EVENTS, never the PROCESS. If Redis is wedged and queue.add() stops
// settling, every unresolved add() call retains its whole CaptureEvent
// payload in memory until it eventually resolves or rejects — which,
// against a genuinely dead Redis, may be never. Called on every request
// to an unauthenticated public endpoint, that is an unbounded memory
// leak driven directly by request volume. createEnqueueCapture's
// `maxInflight` cap converts that into bounded, COUNTED loss instead:
// once `maxInflight` calls are already outstanding, a further call
// drops the event and increments posta_enqueue_dropped_total rather
// than calling add() at all. Losing analytics is recoverable; losing
// the process is an outage — and a silently dropped event would
// undermine this product's entire "the number is honest" thesis, so the
// drop is always counted, never silent.
//
// CONNECTION DECISION: createEventsQueue builds its OWN dedicated
// ioredis connection — it never reuses the shared cache singleton
// (packages/core/src/redis/client.ts's getRedis()). Two independent
// reasons, either one sufficient alone:
//   1. client.ts fixes `maxRetriesPerRequest: 1` and
//      `enableOfflineQueue: false` DELIBERATELY, for the cache's own
//      fail-fast read path — its own docstring calls both "not
//      configurable through RedisClientOptions". Those values are wrong
//      for BullMQ: a producer-only Queue is non-blocking, so nothing in
//      BullMQ's own connection layer would catch a shared cache
//      client's `maxRetriesPerRequest: 1` silently riding along —
//      every queue.add() would inherit a retry budget tuned for a
//      sub-millisecond cache GET, not a durable job write, failing far
//      too eagerly on a transient blip that a real queue write should
//      tolerate.
//   2. Coupling: one shared socket means Redis load on the cache path
//      (a burst of link-lookup GETs) and the queue path (a burst of
//      add()s) contend on the SAME connection, and a reconnect on one
//      concern stalls the other. Two independent connections mean a
//      Redis problem on one path shows up in that path's own signal —
//      REDIS_LOOKUP_TIMEOUT_MS misses for the cache,
//      posta_enqueue_dropped_total for the queue — instead of the two
//      being indistinguishable.
// The dedicated connection sets `maxRetriesPerRequest: null`: BullMQ's
// own documented requirement for connections it owns. A plain
// producer-only Queue's `hasBlockingConnection` is false, so BullMQ's
// own connection layer would not force this itself the way it does for
// a Worker — setting it explicitly here is what keeps this connection
// correct by construction rather than by accident, and keeps it
// consistent with whatever this same connection is later asked to do
// (a Queue can still issue commands that behave like blocking ones
// internally, e.g. rate-limiting). Harmless either way: nothing on this
// producer's own path (queue.add()) issues a blocking command.

/** The name every producer (this file) and, eventually, every consumer
 * (apps/worker) must agree on. T3.1.1 (E3) promotes this to a shared
 * `packages/core` contract both apps import, so a name mismatch becomes
 * structurally impossible instead of a silent "producer enqueues
 * happily, consumer waits on an empty queue" bug — until that lands,
 * this is the one place the literal is spent. */
export const EVENTS_QUEUE_NAME = 'events';

/** The job name every enqueueCapture() call uses. Exported so tests can
 * assert against it instead of duplicating the literal. */
export const CAPTURE_JOB_NAME = 'capture';

// Bounded, deliberately never `true` (removes the job instantly on
// settle — zero retention, no way to inspect a single failed job after
// the fact) and never left unset (BullMQ's own default: keep every job
// forever). Redis here also holds the TTL'd link/handle cache under
// `volatile-lru` (spec §9) — un-TTL'd BullMQ job hashes are never
// eviction candidates under that policy, so unbounded retention is a
// real memory hazard for the WHOLE Redis instance, not just this queue.
// A completed job has already done its job and carries little forensic
// value, so a larger bound costs little; a failed job is what someone
// will actually go looking at, so a smaller-but-nonzero bound keeps
// enough recent history to debug without letting failures accumulate
// unbounded the way `removeOnFail: false` would.
const REMOVE_ON_COMPLETE = 1000;
const REMOVE_ON_FAIL = 500;

/**
 * Builds the `events` BullMQ Queue with its own dedicated connection
 * (see this file's header for why) and the bounded job-retention policy
 * above. Called exactly once, at boot (T2.4.3 wires the call into
 * main.ts) — never per request [INV-2].
 */
export function createEventsQueue(redisUrl: string): Queue<CaptureEvent> {
  return new Queue<CaptureEvent>(EVENTS_QUEUE_NAME, {
    connection: {
      url: redisUrl,
      maxRetriesPerRequest: null,
    },
    defaultJobOptions: {
      removeOnComplete: REMOVE_ON_COMPLETE,
      removeOnFail: REMOVE_ON_FAIL,
    },
  });
}

export const ENQUEUE_DROPPED_COUNTER_NAME = 'posta_enqueue_dropped_total';

/**
 * Builds the posta_enqueue_dropped_total counter. Pass a dedicated
 * `registry` in tests to avoid colliding with prom-client's shared
 * global default registry — mirrors createHandleRootHitsCounter
 * (./middleware.ts) and createDefaultPartitionRowsGauge
 * (apps/worker/src/partitions/partition-maintenance.job.ts)'s identical
 * shape.
 *
 * Any non-zero value means events were PERMANENTLY LOST because the
 * queue was not draining fast enough for the redirect hot path's own
 * pace (Redis unreachable, BullMQ backed up, ...) — this number never
 * recovers on its own and is the signal to go look at Redis/worker
 * health immediately.
 */
export function createEnqueueDroppedCounter(registry?: Registry): Counter<string> {
  // `exactOptionalPropertyTypes` forbids passing `registers: undefined`
  // explicitly — the key must be OMITTED entirely (not present-but-
  // undefined) when no registry override is given, so prom-client falls
  // back to its own default registry.
  return new Counter({
    name: ENQUEUE_DROPPED_COUNTER_NAME,
    help:
      'Count of captured events dropped because MAX_INFLIGHT_ENQUEUES outstanding ' +
      'queue.add() calls were already in flight. Any non-zero value means events were ' +
      'PERMANENTLY LOST because the queue was not draining — investigate Redis and worker ' +
      'health; this number never recovers on its own.',
    ...(registry ? { registers: [registry] } : {}),
  });
}

/** MAX_INFLIGHT_ENQUEUES' own default (env.ts requires the env var
 * present with no schema-level fallback, matching every other numeric
 * var in apiEnvSchema — this is the application-level default used when
 * a caller of createEnqueueCapture omits `maxInflight`, e.g. a test that
 * does not care about the exact bound). */
export const DEFAULT_MAX_INFLIGHT_ENQUEUES = 1000;

/** The minimal shape enqueueCapture needs off a Queue — narrow on
 * purpose so a test can hand it a stub whose add() never settles (the
 * scenario this task's own verify command requires) instead of a real
 * BullMQ Queue, which needs a live Redis just to construct. A real
 * `Queue<CaptureEvent>` (createEventsQueue's return type) satisfies this
 * structurally, no cast needed: its own `add(name, data, opts?)`
 * accepts everything this narrower signature does, plus more. */
export interface EnqueueQueue {
  add(name: string, data: CaptureEvent): Promise<unknown>;
}

export interface CreateEnqueueCaptureDeps {
  /** Built once at boot (createEventsQueue) or a stub in tests. */
  readonly queue: EnqueueQueue;
  /** Built once at boot via createEnqueueDroppedCounter — never built
   * inside this factory, so a caller controls exactly which Registry
   * (or none) it registers against. */
  readonly droppedCounter: Counter<string>;
  /** Defaults to DEFAULT_MAX_INFLIGHT_ENQUEUES (1000). Production
   * callers (main.ts, T2.4.3) pass env.MAX_INFLIGHT_ENQUEUES explicitly. */
  readonly maxInflight?: number;
}

export type EnqueueCapture = (payload: CaptureEvent) => Promise<void>;

/**
 * Builds enqueueCapture, closing over a private `inflight` counter that
 * exists ONLY for the lifetime of the function this factory returns —
 * every call to createEnqueueCapture starts a fresh count at zero, never
 * shared module-level state, so production (one call, at boot) and every
 * test (one call each) get independent counters.
 *
 * Cap logic: while `inflight < maxInflight`, a call increments `inflight`
 * and calls `queue.add()`. Once `inflight` has reached `maxInflight`, a
 * further call does NOT call `queue.add()` at all — it increments
 * `droppedCounter` and returns an already-resolved promise, synchronously,
 * with no `await` in between. This is deliberate: past the cap, adding to
 * a possibly-wedged queue would only grow the very backlog the cap exists
 * to bound.
 *
 * Decrement: exactly one call site, a `.finally()` on the SAME promise
 * chain queue.add() returns — never two separate call sites (one for
 * success, one for failure), which is exactly the shape a future edit
 * could accidentally break by touching only one of the two. `.finally()`
 * runs on both settle paths by construction, so "decrement on success
 * AND failure" is structurally guaranteed rather than something a review
 * has to keep re-verifying by hand.
 *
 * Never throws synchronously (both the cap-exceeded path and the
 * accepted path only ever return a Promise), and never swallows a
 * queue.add() rejection — that rejection propagates out through the
 * returned promise unchanged, so a caller that does
 * `void enqueueCapture(payload).catch(logEnqueueFailure)` (T2.4.3's job)
 * actually receives it. A caller that does not attach anything is still
 * safe: nothing here throws, and this function is only ever called with
 * an immediate `.catch()` attached in production (T2.4.3), which is what
 * "safe to void with a .catch()" means — a caller that DOES attach one
 * never sees an unhandled rejection, because the handler is attached in
 * the same synchronous tick the promise is created in.
 */
export function createEnqueueCapture(deps: CreateEnqueueCaptureDeps): EnqueueCapture {
  const { queue, droppedCounter } = deps;
  const maxInflight = deps.maxInflight ?? DEFAULT_MAX_INFLIGHT_ENQUEUES;
  let inflight = 0;

  return function enqueueCapture(payload: CaptureEvent): Promise<void> {
    if (inflight >= maxInflight) {
      droppedCounter.inc();
      return Promise.resolve();
    }

    inflight += 1;
    return queue
      .add(CAPTURE_JOB_NAME, payload)
      .then(() => undefined)
      .finally(() => {
        inflight -= 1;
      });
  };
}

// T2.4.4 [security] — the failure half of "redirect, then enqueue": by
// the time enqueueCapture's returned promise rejects, the visitor already
// has their 307 (T2.4.3's own ordering guarantee) and is gone. All that
// remains is one log line, and that log line is the single place three
// different secrets could escape at once:
//   1. The visitor's raw IP [INV-6] — never reaches this file at all.
//      `EnqueueFailureContext` (below) has no slot for one, and its
//      three fields are the only inputs this function ever touches.
//   2. The Redis password. This producer's own dedicated connection
//      (createEventsQueue, above) can fail exactly the way
//      resolve-redis.ts's own header describes: ioredis embeds
//      REDIS_URL — password included — directly in a connection error's
//      `.message` (e.g. "connect ECONNREFUSED redis://user:s3cret@host:6379").
//      redactCredentialsFromMessage (packages/contracts) is the SAME
//      redactor describeError (resolve-redis.ts) already uses for this
//      exact problem — built once, in packages/contracts, specifically
//      so this call site would not need a second copy. See that file's
//      own header for why ".message is safer than the raw Error object"
//      is true but insufficient on its own.
//   3. The capture payload's signal values (user_agent, referer, ...).
//      Structurally excluded — see EnqueueFailureContext's own comment.

/**
 * The three fields a diagnosable enqueue-failure log line needs, and
 * NOTHING else. Deliberately its OWN type — not `CaptureEvent`, not
 * `Pick<CaptureEvent, 'event_id' | 'tenant_id' | 'slug'>` — and
 * deliberately camelCase while `CaptureEvent`'s own fields are snake_case
 * (`event_id`, `tenant_id`, `slug`, packages/contracts/src/capture.ts).
 * That naming difference is not cosmetic: it is what makes passing a
 * whole `CaptureEvent` payload here a COMPILE ERROR rather than a
 * structurally-valid accident — a `CaptureEvent` value has no `eventId`/
 * `tenantId` property for TypeScript to match against, so `logEnqueueFailure(error,
 * payload)` fails to typecheck instead of silently widening what this
 * log line carries. A caller MUST build this object field-by-field at
 * the call site, the same "structural, not conventional" standard T2.3.7
 * held `ClientIp`/`VisitorHash` (capture.ts) to for the identical reason.
 *
 * [security review, fix round 1 — corrected overclaim] Precisely what
 * this stops, and what it does not: it rejects a whole-payload
 * SUBSTITUTION — `logEnqueueFailure(error, payload)` — at compile time,
 * which is the likely accidental regression (reaching for the
 * already-in-scope payload instead of building the narrow object) and
 * real protection against it. It does NOT stop a spread bolted on
 * ALONGSIDE the explicit fields — `logEnqueueFailure(error, { ...payload,
 * eventId: payload.event_id, tenantId, slug })` compiles with ZERO errors
 * (verified by hand against this repo's own `tsc --noEmit -p
 * tsconfig.test.json`): TypeScript's excess-property check only inspects
 * properties written literally in an object literal, and spread-
 * contributed properties are exempt from it. (Writing the spread AFTER
 * the three explicit fields instead — `{ eventId, tenantId, slug,
 * ...payload }` — additionally trips an UNRELATED diagnostic, TS2783
 * "specified more than once", because `payload` itself also carries a
 * `slug` key; that is a property-order lint, not the type-safety
 * boundary this comment is about, and ordering the spread first avoids
 * it while still demonstrating the same bypass.) The call site in
 * `middleware.ts` has no such spread, and this type cannot enforce that
 * one never gets added — that remains a code-review concern, not a
 * compiler-enforced one.
 */
export interface EnqueueFailureContext {
  readonly eventId: string;
  readonly tenantId: string;
  readonly slug: string;
}

/** Minimal logger shape this function needs — mirrors
 * RedirectMiddlewareLogger (./middleware.ts) and ResolveLogger
 * (./resolve-redis.ts). Duplicated rather than imported: middleware.ts
 * already imports `EnqueueCapture` FROM this file, so importing
 * `RedirectMiddlewareLogger` back from middleware.ts would be a circular
 * import — the same reasoning resolve-redis.ts's own `ResolveLogger` and
 * geoip/lookup.ts's `GeoLookupLogger` already document for their own
 * near-identical shapes. */
export interface EnqueueFailureLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export type LogEnqueueFailure = (error: unknown, context: EnqueueFailureContext) => void;

/**
 * Builds `logEnqueueFailure(error, context)`, closing over `logger`
 * exactly like `createNetworkLookup`/`createDailySalt` close over their
 * own deps (packages/core) — built once at boot (middleware.ts's
 * `createRedirectMiddleware`, itself called once in main.ts), never per
 * request [INV-2].
 *
 * Logs exactly five things: `context.eventId`, `context.tenantId`,
 * `context.slug`, and the failing error's own `name` and REDACTED
 * `message` — nothing else. Not the stack (can carry surrounding closure
 * scope in some runtimes), not the raw `Error` object, not `.cause`, and
 * — because `EnqueueFailureContext` has no slot for one — never the
 * `CaptureEvent` payload or the originating request.
 *
 * A non-`Error` rejection (a thrown string, say) still produces a safe
 * line: `typeof error` stands in for `.name`, and `String(error)` stands
 * in for `.message` before either goes through the same redactor.
 */
export function createLogEnqueueFailure(logger: EnqueueFailureLogger): LogEnqueueFailure {
  return function logEnqueueFailure(error: unknown, context: EnqueueFailureContext): void {
    const errorName = error instanceof Error ? error.name : typeof error;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const errorMessage = redactCredentialsFromMessage(rawMessage);

    logger.error('Enqueue failed; the redirect already succeeded, event dropped', {
      ...context,
      errorName,
      errorMessage,
    });
  };
}
