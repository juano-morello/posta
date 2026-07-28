import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { CaptureEvent } from '@posta/contracts';
import {
  enrich,
  eventBatchKey,
  insertEventsBatch,
  newId,
  resolveDestinationsByLinkIds,
  serializeBatch,
  type DbClient,
  type LoggedEvent,
  type LinkDestinationLookup,
  type NewEvent,
} from '@posta/core';
import { putR2BatchWithRetry, type R2BatchDlqSink, type R2Put } from './r2-retry';

// T3.3.2 [E3, S3.3][INV-8] — flushBatch is the worker's actual write to
// Postgres: T3.2.5's enrich() composes the seven enrichment columns per
// event, and packages/core's insertEventsBatch (T3.3.2, db/events.ts)
// issues the ONE multi-row `INSERT ... ON CONFLICT (event_id,
// occurred_at) DO NOTHING` this file's own task names. See flush.test.ts
// for the two things this task had to independently prove: idempotency
// (the SAME batch flushed twice produces the SAME rows, invariant 8) and
// "one statement, not 100" (the INSERT is never chunked into one round
// trip per event).
//
// DESTINATION LOOKUP — THE GAP enrich.ts'S OWN HEADER NAMES THIS FILE AS
// OWNING: CaptureEvent has no `destination` field (E2 capture doesn't
// know it), but enrich()'s dest_host column needs one. This resolves
// every event's CURRENT destination with ONE batched Postgres SELECT per
// flush (packages/core's resolveDestinationsByLinkIds, keyed by
// `link_id` — see that function's own header, packages/core/src/db/
// tenant.ts, for why it is NOT forTenant()-scoped and why matching by
// `id` alone is still safe), never one SELECT per event. A direct
// Postgres read, not a Redis cache read: this flush already needs a
// Postgres connection for the INSERT itself, so adding Redis as a SECOND
// dependency to trace through (with its own cache-miss/staleness
// questions) buys nothing this task's scope needs.
//
// An event with no resolvable destination — its link_id wasn't in the
// batch's own SELECT result (a deleted/never-existed link), or it WAS
// found but under a tenant_id that doesn't match this event's own
// (defense in depth against a CaptureEvent that crossed a process
// boundary with a mismatched pairing) — enriches with `destination:
// null`, exactly like a CaptureEvent that already carried no
// destination: enrich() already treats `null` and `''` identically,
// resolving `dest_host` to `null` rather than throwing. That fallback is
// the CORRECT behavior, not a bug — but it was previously silent at
// scale, with no way for an operator to notice a pattern (link
// deletions racing flushes, or a genuine upstream data-integrity
// problem). [review round 2, observability fix] `logger` (see
// `FlushBatchLogger` below) now reports ONE batch-level summary line
// per flush — never per event, which would just be noise — whenever at
// least one event in the batch didn't resolve, naming how many and why
// (not-found vs. tenant-mismatch are counted separately, since a
// tenant-mismatch is a much stronger signal something is actually wrong
// upstream than an ordinary deleted link).
//
// TWO STATEMENTS PER FLUSH, NOT ONE — recorded here so it is never
// mistaken for an oversight. The destination SELECT above must run
// BEFORE enrich() (dest_host needs the destination as a plain string,
// and enrich() is pure — no I/O of its own), so it cannot be folded into
// the INSERT itself without either reimplementing destHost()'s
// URL-parsing in SQL (a second, drifting copy of T3.2.4 — the
// enrichment barrel's own header explicitly warns against a second
// composition of these functions) or a second WRITE pass (an UPDATE
// after the INSERT, touching the same 100 rows again — strictly worse).
// Both statements are batched for the WHOLE flush, never one per event —
// that is the "not 100" property this task's verify command actually
// checks for; flush.test.ts asserts both the INSERT side and the SELECT
// side of it directly, and asserts the total (2, not 1) is exactly this
// and nothing more.
//
// enrich() ALSO NEEDS A CaptureEvent & EnrichmentResult INTERMEDIATE —
// LoggedEvent (packages/core/src/r2/ndjson.ts, T3.4.2) already names
// this exact merged shape and this file (T3.3.2) as the sibling task
// that assembles it; reusing it here (rather than inventing a second,
// unnamed "enriched event" shape) is what lets this same task compose
// R2's own write (below) by handing that same array straight to
// serializeBatch() without redoing enrichment.
//
// T3.4.4 [E3, S3.4][INV-7] — ONE R2 PUT PER FLUSH, NEVER PER EVENT.
// flushBatch now composes the three T3.4.1-T3.4.3 pieces
// (createR2Client, serializeBatch, eventBatchKey — all already built,
// this task only wires them in) alongside the Postgres write above: the
// SAME `loggedEvents` array (LoggedEvent[], the merged CaptureEvent &
// EnrichmentResult shape) that already feeds `toNewEventRow` also feeds
// `serializeBatch`, and the WHOLE serialized batch goes out as a single
// `PutObjectCommand` — R2 bills per PUT, so one object per click would be
// real money at any volume, quite apart from turning a 10k-event burst
// into 10k round trips. `r2Client` is threaded in via
// `CreateFlushBatchOptions` (below), constructed ONCE at boot by
// whoever wires this up (createR2Client's own header — never
// per-request, never per-batch), matching `db`'s identical
// closed-over-not-reconstructed treatment.
//
// batchId — WHERE THE R2 KEY'S STABILITY ACTUALLY COMES FROM: eventBatchKey
// needs an opaque `batchId` to key the object with (packages/core/src/r2/
// keys.ts's own header: "every retry of the same batch PUTs to the same
// key"). BatchAccumulator (T3.3.1) already mints exactly this id once, when
// a batch opens, and its own header already names this file as the
// consumer that keys the R2 object off it — so `flushBatch`'s own second
// parameter is `batchId`, structurally the SAME shape accumulator.ts's
// `BatchFlushCallback<CaptureEvent>` already expects it to accept. It stays
// OPTIONAL, defaulting to a freshly minted `newId()` when omitted, rather
// than required: this task does not wire flushBatch into BatchAccumulator
// (that wiring, and threading a batch's own id through
// apps/worker/src/batch/split-retry.ts's retry loop so a RETRY of the same
// batch reuses the same key, are both later tasks' jobs, deliberately out
// of this one's scope) — an optional default keeps every existing caller
// (flush.test.ts, split-retry.ts's `flushBatch(events)`, both call with one
// argument) compiling unchanged, while a caller that DOES have a real
// batch_id (the eventual BatchAccumulator wiring) gets the idempotent-key
// property this parameter exists for. Known, narrow consequence recorded
// here rather than silently: until that wiring lands, a batch retried
// through `retryWithSplit` (which never passes `batchId`) mints a NEW
// R2 key per attempt rather than overwriting the same one — duplicate
// objects holding identical data, not data loss, and not this task's to
// fix.
//
// T3.4.6 [E3, S3.4][INV-7] — THE TWO WRITES ARE NOW COUPLED. Flush order is
// R2 PUT (via T3.4.5's `putR2BatchWithRetry`, retried with backoff) FIRST,
// awaited to completion, and the Postgres `INSERT` (still `insertEventsBatch`,
// T3.3.2) only ever runs once that PUT has actually succeeded. The
// `Promise.all` this replaced ran both concurrently with no ordering
// guarantee — exactly the shape that lets Postgres hold a row the R2 log
// never saw, which is the one way invariant 7's "the R2 NDJSON log is the
// source of truth... Postgres is a rebuildable projection" quietly stops
// being true: a projection that ends up BIGGER than the log it was
// rebuilt from is not a projection of that log at all.
//
// ON EXHAUSTION, THE TRANSACTION IS NEVER OPENED — the batch goes to the
// DLQ WHOLE instead. `putR2BatchWithRetry` (r2-retry.ts, T3.4.5) already
// owns both halves of that: it retries the PUT with exponential backoff,
// classifying each rejection as retryable or not (`classifyR2Error`), and
// on a terminal failure (retries exhausted, or a non-retryable error on
// the very first attempt) routes the WHOLE `events` array to `dlqSink` as
// ONE entry via `sendR2PutFailureToDlq`, before ever resolving. This
// function's own job is narrow: call it, and branch on its returned
// `R2PutOutcome` — `insertEventsBatch` is reached ONLY on `succeeded:
// true`.
//
// A DLQ-ROUTED FAILURE RESOLVES `flushBatch`, IT DOES NOT REJECT IT — the
// SAME "never throws for a handled outcome" design `retryWithSplit`
// (split-retry.ts) and `putR2BatchWithRetry` itself already establish for
// a classified failure that has somewhere safe to land. The batch is not
// lost — its full payload is sitting in `EVENTS_DLQ_QUEUE`, inspectable
// and (once T3.6.3's replay tooling exists) replayable — so treating this
// the same as an unhandled exception would be strictly less honest than
// what actually happened. This is also why `BatchAccumulator.
// lastFlushAgeMs()` (T3.1.7, accumulator.ts) intentionally does NOT
// distinguish "committed to Postgres" from "DLQ'd" — both are a flush
// LOOP that is genuinely still turning, not stuck; a sustained R2 outage
// is instead surfaced through `dlq_depth` growing (HealthController,
// T3.1.7), a SEPARATE signal for a separate failure mode.
//
// A `dlqSink.send()` rejection is the one case that still propagates as a
// genuine `flushBatch` rejection — `putR2BatchWithRetry`'s own contract
// (r2-retry.ts) never swallows that, and neither does this function: a
// batch that fails BOTH to PUT and to reach the DLQ has nowhere safe left
// to land, and invariant 7 is better served by a loud failure (retried by
// whatever called `flushBatch`) than by discarding it.
//
// `dlqSink` DEFAULTS TO {@link rejectingDlqSink}, NOT A REAL DLQ — see
// that value's own doc comment for why: every existing call site that
// predates this task (flush.test.ts, r2-put.test.ts, idempotency.test.ts,
// poison-dlq.test.ts — none of them this task's own files) never
// constructs a real `DlqService`, and r2-put.test.ts's own pre-existing
// [INV-7] assertion ("a real R2 PUT failure rejects the whole flush")
// must keep holding for them. Production (app.module.ts's
// `buildProductionFlush`) supplies the real thing — a `DlqService`
// instance satisfies `R2BatchDlqSink` structurally, zero adapter code
// needed (r2-retry.ts's own header explains why).

/** Minimal logger shape this file needs — the SAME `{ error(message,
 * meta?): void }` shape apps/worker/src/consumer/events.consumer.ts's
 * own `EventsConsumerLogger` and apps/worker/src/batch/accumulator.ts's
 * own `BatchAccumulatorLogger` already use, deliberately not a fourth
 * shape — a test can pass a plain spy object, and there is still no
 * real pino instance wired up anywhere in this codebase to depend on. */
export interface FlushBatchLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — writes to stderr via `console.error`, mirroring
 * the identical `consoleErrorLogger` both files named above already
 * export, as a separate instance rather than a shared import since none
 * of the three have any other reason to depend on each other. */
export const consoleErrorLogger: FlushBatchLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** [T3.2.8] Postgres `text` columns reject a value containing a literal
 * NUL byte (U+0000) outright — `error: invalid byte sequence for encoding
 * "UTF8": 0x00` (SQLSTATE 22021), confirmed against a real Postgres
 * instance while building hostile-ua.test.ts. Because the INSERT below is
 * ONE multi-row statement for the WHOLE flush (this file's own header —
 * "never chunked, never per-row"), a NUL byte hiding in even ONE row's
 * raw header value rejects the ENTIRE statement, taking down all 100 rows
 * in the batch, not just the poisoned one — precisely the "stalled
 * pipeline" failure mode hostile-ua.test.ts exists to catch.
 *
 * In real production traffic this specific byte never reaches here at
 * all: Node's own HTTP parser rejects a NUL byte in a header value with
 * 400 before app code ever runs (see docs/plan/02-redirect-hot-path.md's
 * own note on the visitor-hash NUL delimiter). But `toNewEventRow` has no
 * way to assume every `CaptureEvent` it is ever handed arrived via that
 * HTTP path — a directly-constructed event (hostile-ua.test.ts's own
 * harness, or T3.6.3's future R2 replay tooling) is not covered by that
 * upstream guarantee, so this function defends at its own boundary
 * instead of relying on a layer it does not control.
 *
 * Nulls the WHOLE field rather than stripping just the offending
 * character(s) out of the middle of the string — the same "cannot
 * represent it cleanly, so null it, never invent a mangled substring"
 * discipline ua.ts's own catch-and-null-everything already follows for
 * unparseable UAs. Nothing invariant 7 promises is lost: R2 (the true
 * source of truth) already received the untouched raw value via
 * `loggedEvents`/`serializeBatch` above, entirely independent of this
 * function — only this rebuildable Postgres projection drops what it
 * structurally cannot hold. */
function sanitizeForPostgresText(value: string | null): string | null {
  return value !== null && value.includes('\u0000') ? null : value;
}

/** Maps a `LoggedEvent` (the merged, snake_case `CaptureEvent &
 * EnrichmentResult` shape) onto `NewEvent` (schema/events.ts's
 * camelCase Drizzle insert shape) — one property per `events` column,
 * by name, deliberately not a spread: an object literal here gets a
 * compile-time excess-property error if it ever names an unexpected
 * key, the same discipline ndjson.ts's toLogLine() follows for the
 * identical reason.
 *
 * [T3.2.8] Every raw, header-derived text field (never the enrichment
 * columns below them, which enrich() already derives fresh from parsed
 * facts rather than copying attacker-controlled input verbatim) is passed
 * through `sanitizeForPostgresText` — see that function's own docstring
 * for why this cannot be narrowed to `userAgent` alone: the Postgres
 * constraint it works around applies uniformly to every `text` column,
 * not specifically to User-Agent.
 *
 * EXPORTED as of T3.6.3 — apps/worker/src/cli/replay-driver.ts is the
 * second real caller. `LoggedEvent` is EXACTLY what `streamEventLog`
 * (packages/core/src/r2/ndjson.ts, T3.6.2) yields back off an archived
 * NDJSON line, so this same column mapping applies unchanged to a
 * replayed record — no second, drifting copy of the 31-field mapping
 * lives in the replay driver. The live path (`flushBatch` below) builds
 * its own `LoggedEvent`s fresh via `toLoggedEvent` (which calls
 * `enrich()`/`resolveDestinationsByLinkIds` first); replay never does —
 * it hands this function a `LoggedEvent` it read verbatim off R2, dest_host
 * and all, which is the whole point (see replay-driver.ts's own header on
 * why re-deriving dest_host at replay time would silently rewrite history). */
export function toNewEventRow(logged: LoggedEvent): NewEvent {
  return {
    eventId: logged.event_id,
    occurredAt: new Date(logged.occurred_at),
    tenantId: logged.tenant_id,
    linkId: logged.link_id,
    slug: logged.slug,
    visitorHash: sanitizeForPostgresText(logged.visitor_hash),
    httpMethod: sanitizeForPostgresText(logged.http_method),
    userAgent: sanitizeForPostgresText(logged.user_agent),
    referer: sanitizeForPostgresText(logged.referer),
    accept: sanitizeForPostgresText(logged.accept),
    acceptLanguage: sanitizeForPostgresText(logged.accept_language),
    secFetchSite: sanitizeForPostgresText(logged.sec_fetch_site),
    secFetchMode: sanitizeForPostgresText(logged.sec_fetch_mode),
    secFetchDest: sanitizeForPostgresText(logged.sec_fetch_dest),
    secFetchUser: sanitizeForPostgresText(logged.sec_fetch_user),
    secPurpose: sanitizeForPostgresText(logged.sec_purpose),
    secChUa: sanitizeForPostgresText(logged.sec_ch_ua),
    secChUaMobile: sanitizeForPostgresText(logged.sec_ch_ua_mobile),
    secChUaPlatform: sanitizeForPostgresText(logged.sec_ch_ua_platform),
    purpose: sanitizeForPostgresText(logged.purpose),
    xPurpose: sanitizeForPostgresText(logged.x_purpose),
    xMoz: sanitizeForPostgresText(logged.x_moz),
    country: sanitizeForPostgresText(logged.country),
    asn: logged.asn,
    browser: logged.browser,
    browserVersion: logged.browser_version,
    os: logged.os,
    deviceType: logged.device_type,
    sourcePlatform: logged.source_platform,
    isInApp: logged.is_in_app,
    destHost: logged.dest_host,
  };
}

/** Enriches one CaptureEvent with its already-resolved `destination`
 * (or `null` when unresolvable — see this file's own header), producing
 * the merged `LoggedEvent` shape both the Postgres insert and the R2
 * write (both below) consume identically. */
function toLoggedEvent(event: CaptureEvent, destination: string | null): LoggedEvent {
  return {
    ...event,
    ...enrich({ user_agent: event.user_agent, referer: event.referer, destination }),
  };
}

/** One event's destination-resolution outcome — `reason` is `null` for
 * a clean resolve, or names exactly why `destination` fell back to
 * `null` otherwise. Kept as an intermediate (rather than folding
 * straight into `toLoggedEvent`) so the batch-level log summary below
 * can count outcomes without re-deriving them a second time. */
interface ResolvedEvent {
  readonly event: CaptureEvent;
  readonly destination: string | null;
  readonly reason: 'not-found' | 'tenant-mismatch' | null;
}

function resolveDestination(
  event: CaptureEvent,
  destinationsByLinkId: ReadonlyMap<string, LinkDestinationLookup>,
): ResolvedEvent {
  const resolved = destinationsByLinkId.get(event.link_id);

  if (resolved === undefined) {
    return { event, destination: null, reason: 'not-found' };
  }
  if (resolved.tenantId !== event.tenant_id) {
    return { event, destination: null, reason: 'tenant-mismatch' };
  }
  return { event, destination: resolved.destination, reason: null };
}

/**
 * Logs ONE batch-level summary line — never per event, which would be
 * noise at 100 events/flush — and only when at least one event in the
 * batch actually failed to resolve a destination. An all-resolved flush
 * (the common case) logs nothing: an `error()` line on every single
 * healthy flush would itself become the noise this function exists to
 * avoid.
 *
 * `not-found` and `tenant-mismatch` are counted separately rather than
 * folded into one number: a deleted link racing a flush is ordinary
 * operation, but a tenant mismatch means a CaptureEvent's `tenant_id`/
 * `link_id` pairing didn't match Postgres at all — a much stronger
 * signal that something upstream is actually wrong, worth an operator
 * being able to tell apart from routine link churn at a glance.
 */
function logUnresolvedDestinations(
  logger: FlushBatchLogger,
  resolutions: readonly ResolvedEvent[],
  distinctLinkIdCount: number,
): void {
  const notFoundCount = resolutions.filter((r) => r.reason === 'not-found').length;
  const tenantMismatchCount = resolutions.filter((r) => r.reason === 'tenant-mismatch').length;
  const unresolvedCount = notFoundCount + tenantMismatchCount;

  if (unresolvedCount === 0) return;

  logger.error(
    `flushBatch: ${unresolvedCount} of ${resolutions.length} event(s) in this batch did not resolve a ` +
      `destination (${notFoundCount} link_id not found, ${tenantMismatchCount} tenant mismatch) — dest_host ` +
      'stays null for these rows, nothing else in the row is affected.',
    {
      batchSize: resolutions.length,
      distinctLinkIdCount,
      unresolvedCount,
      notFoundCount,
      tenantMismatchCount,
    },
  );
}

/** The `flushBatch(events, batchId?)` shape this file builds — also
 * exactly the shape apps/worker/src/batch/accumulator.ts's
 * `BatchFlushCallback<T>` expects as its `flush` option (a function whose
 * second parameter is OPTIONAL is still structurally assignable where
 * `BatchFlushCallback<CaptureEvent>` requires it — every real caller
 * BatchAccumulator drives always supplies one). `batchId` defaults to a
 * freshly minted `newId()` when a caller omits it — see this file's own
 * header (T3.4.4) for why: it keeps existing single-argument callers
 * (flush.test.ts, split-retry.ts's `flushBatch(events)`) compiling and
 * behaving unchanged, while a caller that DOES pass BatchAccumulator's own
 * stable id gets `eventBatchKey`'s idempotent-retry property. */
export type FlushBatch = (events: readonly CaptureEvent[], batchId?: string) => Promise<void>;

export interface CreateFlushBatchOptions {
  readonly db: DbClient['db'];
  /** The already-constructed S3-compatible client (packages/core/src/r2/
   * client.ts's `createR2Client`, T3.4.1) — built ONCE at boot by whoever
   * wires this up, never here; see that function's own docstring for why
   * constructing per-request/per-batch is wrong. Typed `S3Client` directly
   * (not re-derived via `ReturnType<typeof createR2Client>`) since
   * `@aws-sdk/client-s3` is now a direct dependency of this package —
   * `PutObjectCommand` (below) needs the same import regardless, so there
   * is no `DbClient`-style "never import the underlying library" boundary
   * to preserve here the way there is for drizzle-orm. */
  readonly r2Client: S3Client;
  /** The bucket every batch's NDJSON object is written to — `R2_BUCKET_EVENTS`
   * in both apps' own env schemas (apps/worker/src/env.ts,
   * apps/api/src/env.ts). A plain string, not folded into `r2Client` itself:
   * S3Client's constructor has no "default bucket" concept (see
   * `R2ClientConfig`'s own docstring), so a bucket is always supplied
   * per-call. */
  readonly r2Bucket: string;
  /** Defaults to {@link consoleErrorLogger} when omitted — same
   * optional-with-a-console-default shape `BatchAccumulatorOptions`
   * (accumulator.ts) already uses for its own `logger` field. Also
   * threaded through as `putR2BatchWithRetry`'s own `logger` (T3.4.6) —
   * `FlushBatchLogger` and r2-retry.ts's `R2RetryLogger` are the SAME
   * `{ error(message, meta?): void }` shape, so one injected logger
   * covers both the unresolved-destination summary AND the R2 retry/DLQ
   * log lines, rather than this file exposing a second logger field for
   * what is structurally identical. */
  readonly logger?: FlushBatchLogger;
  /** [T3.4.6][INV-7] Where the WHOLE batch is routed once the R2 PUT
   * below (`putR2BatchWithRetry`, r2-retry.ts, T3.4.5) exhausts every
   * retry or hits a non-retryable error on its first attempt — see this
   * file's own header for the full coupling design this field exists
   * for. Defaults to {@link rejectingDlqSink} when omitted; production
   * (app.module.ts's `buildProductionFlush`) always supplies a real
   * `DlqService` instance instead, which satisfies `R2BatchDlqSink`
   * structurally with zero adapter code (r2-retry.ts's own header
   * explains why). */
  readonly dlqSink?: R2BatchDlqSink;
  /** [T3.4.6] Tunes `putR2BatchWithRetry`'s own backoff for THIS flush
   * closure. `maxAttempts` defaults to {@link DEFAULT_R2_MAX_ATTEMPTS} (5
   * — r2-retry.ts's own header: "the plan's own brief names 5 for
   * production"); `initialDelayMs` defaults to
   * {@link DEFAULT_R2_INITIAL_DELAY_MS} (200). Exposed as a caller
   * override (rather than hardcoded) so a test proving this coupling
   * against a genuinely stopped MinIO container isn't stuck waiting out
   * production's own backoff schedule — see coupled-writes.test.ts. */
  readonly r2RetryOptions?: {
    readonly maxAttempts?: number;
    readonly initialDelayMs?: number;
  };
}

/** [T3.4.6] Production's own retry budget for the R2 PUT — r2-retry.ts's
 * own header: "the plan's own brief names 5 for production". Not
 * exported: a caller tunes this via `CreateFlushBatchOptions.
 * r2RetryOptions`, never by importing this constant directly. */
const DEFAULT_R2_MAX_ATTEMPTS = 5;

/** [T3.4.6] Base delay (ms) before the SECOND R2 PUT attempt; each
 * further retry of the SAME batch doubles it (r2-retry.ts's own
 * `R2RetryOptions.initialDelayMs`). 200ms keeps a genuinely exhausted
 * sequence (5 attempts: waits of 200/400/800/1600ms between them, ~3s
 * total) comfortably inside `SHUTDOWN_TIMEOUT_MS`'s own production
 * default (30s, env.ts) even stacked on top of a real Postgres round
 * trip. */
const DEFAULT_R2_INITIAL_DELAY_MS = 200;

/** [T3.4.6] The default `dlqSink` when a caller omits
 * `CreateFlushBatchOptions.dlqSink` — deliberately NOT a silent no-op:
 * this ALWAYS rejects. Every call site that predates this task
 * (flush.test.ts, r2-put.test.ts, idempotency.test.ts, poison-dlq.test.ts
 * — none of them this task's own files to touch) constructs
 * `createFlushBatch` with no real DLQ wired through, and r2-put.test.ts's
 * own pre-existing [INV-7] assertion ("a real R2 PUT failure rejects the
 * whole flush — R2 never silently becomes optional") must keep holding
 * for every one of them unchanged. A default that silently swallowed the
 * failure instead would make R2 optional in exactly the way that
 * assertion — and invariant 7 itself — forbids. Production
 * (app.module.ts's `buildProductionFlush`) always supplies a real
 * `DlqService` instance instead, which absorbs the failure into a real,
 * inspectable DLQ entry and lets `flushBatch` resolve normally (see this
 * file's own header). `putR2BatchWithRetry`'s own contract (r2-retry.ts)
 * never swallows a `dlqSink.send()` rejection either way, so this sink's
 * rejection propagates all the way out of `flushBatch` exactly like the
 * pre-T3.4.6 code's own unconditional PUT rejection did. */
export const rejectingDlqSink: R2BatchDlqSink = {
  async send(): Promise<void> {
    throw new Error(
      'createFlushBatch: the R2 PUT failed and no real dlqSink was configured ' +
        '(CreateFlushBatchOptions.dlqSink) — the batch cannot be safely discarded, so this flush ' +
        'fails loudly instead of silently dropping it.',
    );
  },
};

/**
 * Writes one batch's NDJSON body to R2 as a single `PutObjectCommand` —
 * see this file's own header (T3.4.4) for why ONE PUT per flush, never
 * one per event, is the property that matters here. `firstOccurredAt`
 * is the CALLER's choice of which event's timestamp represents the whole
 * batch (see `eventBatchKey`'s own docstring) — this function does not
 * decide that, only turns the already-decided pieces into bytes on the
 * wire. Explicitly UTF-8-encodes via `Buffer.from` rather than handing
 * `serializeBatch`'s plain string straight to `Body` — `ndjson.ts`'s own
 * header names this exact encoding step as the later caller's job, not
 * `serializeBatch`'s.
 */
async function putEventBatch(
  r2Client: S3Client,
  r2Bucket: string,
  batchId: string,
  firstOccurredAt: string,
  loggedEvents: readonly LoggedEvent[],
): Promise<void> {
  const key = eventBatchKey(batchId, firstOccurredAt);
  const body = serializeBatch(loggedEvents);

  await r2Client.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: key,
      Body: Buffer.from(body, 'utf-8'),
      ContentType: 'application/x-ndjson',
    }),
  );
}

/**
 * Builds a `flushBatch(events, batchId?)` closure bound to `db`, `r2Client`
 * and `r2Bucket` (and, optionally, a `logger` for the unresolved-destination
 * summary/R2 retry logging, a `dlqSink` for a terminal R2 PUT failure, and
 * `r2RetryOptions` tuning the retry backoff — see this file's own header,
 * T3.4.6, for the full coupling design those three exist for). `db` is
 * typed as `DbClient['db']` (an indexed-access type off `@posta/core`'s own
 * `DbClient` interface), not
 * `NodePgDatabase` written out directly — apps/worker never imports
 * drizzle-orm itself, matching apps/api/src/redirect/resolve-link.ts's
 * identical precedent (it only ever imports `DbClient`'s TYPE plus this
 * package's own query functions). Drizzle stays an implementation detail of
 * packages/core; `resolveDestinationsByLinkIds` and `insertEventsBatch` are
 * the two calls that actually touch it.
 *
 * A redirect never blocks on analytics (invariant 1) is untouched here
 * on purpose — that invariant governs the HOT PATH (apps/api's redirect
 * controller), not the worker's own batch write, which runs entirely
 * off that path, downstream of the BullMQ queue.
 */
export function createFlushBatch(options: CreateFlushBatchOptions): FlushBatch {
  const {
    db,
    r2Client,
    r2Bucket,
    logger = consoleErrorLogger,
    dlqSink = rejectingDlqSink,
    r2RetryOptions,
  } = options;
  const r2MaxAttempts = r2RetryOptions?.maxAttempts ?? DEFAULT_R2_MAX_ATTEMPTS;
  const r2InitialDelayMs = r2RetryOptions?.initialDelayMs ?? DEFAULT_R2_INITIAL_DELAY_MS;

  return async function flushBatch(
    events: readonly CaptureEvent[],
    batchId: string = newId(),
  ): Promise<void> {
    const [firstEvent] = events;
    if (firstEvent === undefined) return;

    const linkIds = [...new Set(events.map((event) => event.link_id))];
    const destinationsByLinkId = await resolveDestinationsByLinkIds(db, linkIds);

    const resolutions = events.map((event) => resolveDestination(event, destinationsByLinkId));
    logUnresolvedDestinations(logger, resolutions, linkIds.length);

    const loggedEvents: LoggedEvent[] = resolutions.map(({ event, destination }) =>
      toLoggedEvent(event, destination),
    );
    const rows: NewEvent[] = loggedEvents.map(toNewEventRow);

    // [T3.4.6][INV-7] R2 PUT FIRST, awaited to completion — see this
    // file's own header for the full coupling rationale. `put` closes
    // over everything `putEventBatch` needs so it stays the bare
    // zero-argument `R2Put` thunk `putR2BatchWithRetry` expects (r2-retry.ts's
    // own header explains why that function never imports the AWS SDK
    // itself).
    const put: R2Put = () => putEventBatch(r2Client, r2Bucket, batchId, firstEvent.occurred_at, loggedEvents);
    const outcome = await putR2BatchWithRetry(put, events, batchId, dlqSink, {
      maxAttempts: r2MaxAttempts,
      initialDelayMs: r2InitialDelayMs,
      logger,
    });

    if (!outcome.succeeded) {
      // Terminal, HANDLED failure: putR2BatchWithRetry has already routed
      // the whole batch to dlqSink before resolving (its own contract,
      // r2-retry.ts) — the Postgres transaction below is never opened.
      // This resolves `flushBatch`, it does not reject it; see this
      // file's own header for why that is the correct outcome for a
      // batch that has somewhere safe to land.
      return;
    }

    await insertEventsBatch(db, rows);
  };
}
