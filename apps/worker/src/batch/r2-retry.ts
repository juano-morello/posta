import type { CaptureEvent } from '@posta/contracts';

// T3.4.5 [E3, S3.4][INV-7] — retries flush.ts's R2 PUT (putEventBatch,
// T3.4.4) with exponential backoff, and routes the whole batch to the DLQ
// once retries are exhausted (or once a non-retryable error makes further
// retries pointless). NOT WIRED into flush.ts's own call site — that
// coupling is T3.4.6's job by name, per this task's own brief, mirroring
// split-retry.ts's own T3.3.3/T3.3.4 split ("built and proven correct
// here... wiring is a pure composition step for whichever later task does
// it"). This file ships standalone.
//
// GENERIC OVER THE OPERATION, NOT COUPLED TO S3Client — `R2Put` (below) is
// a bare `() => Promise<void>` thunk, the SAME "generic over flushBatch,
// not coupled to Postgres" discipline split-retry.ts's own header
// describes for `FlushBatch`. `retryR2Put` never imports `@aws-sdk/
// client-s3`, never constructs a `PutObjectCommand`, and never sees an
// `S3Client` — a caller closes over its own already-built `r2Client`,
// `r2Bucket`, `key`, and serialized `Body` (exactly flush.ts's own
// `putEventBatch`'s parameters) into a zero-argument closure. This is what
// lets r2-retry.test.ts prove the retry/classification ALGORITHM with a
// plain injected double for 20 of its 22 cases, and still prove real
// composition against MinIO for the remaining 2 (see that file's own
// header) without this module itself depending on the AWS SDK at all.
//
// CLASSIFICATION IS AN ALLOWLIST, NOT A BLOCKLIST — `classifyR2Error`
// (below) treats retryable as the exception, not the default. Only three
// documented categories count as retryable: 5xx server errors, throttling
// (429 or the SDK's own `$retryable.throttling` flag), and a
// transport-level timeout/connection-reset that never got an HTTP
// response at all. EVERYTHING else — 403, 404, an ordinary 400, a
// completely unrecognized error shape, even a non-Error thrown value —
// classifies non-retryable. This is deliberately the more conservative of
// the two possible defaults: an allowlist that quietly misses a genuinely
// retryable error only costs one batch an unnecessary trip to the DLQ
// (recoverable — an operator can replay it, and 3.3.4's own DLQ precedent
// establishes that path), whereas a blocklist that misses a genuinely
// NON-retryable error would spend all 5 attempts (and their backoff delay)
// retrying something that will never succeed no matter how many times it
// is retried — the exact failure mode a misconfigured bucket/credentials
// error (this task's own "403/404... retrying a misconfiguration only
// delays the alert" reasoning) exists to avoid.
//
// WHY $metadata.httpStatusCode AND $retryable, NOT `instanceof
// S3ServiceException` — verified against the installed
// @aws-sdk/client-s3@3.1095.0 / @smithy/core@3.30.0 source
// (ServiceException, submodules/client/smithy-client/exceptions.d.ts):
// every S3-service-originated error (`S3ServiceException` and its
// subclasses) carries `$metadata: ResponseMetadata` (`httpStatusCode?:
// number`) and an optional `$retryable?: { throttling?: boolean }`, both
// duck-typed here rather than checked via `instanceof` — the SAME
// "duck-type one property, no import needed" discipline dlq.service.ts's
// own `extractSqlState` already applies to a `pg`/drizzle error chain,
// applied here to the AWS SDK's error chain instead. `instanceof
// S3ServiceException` would ALSO miss the timeout/connection-reset case
// entirely: verified against @smithy/node-http-handler@4.9.11's own
// source (dist-cjs/index.js), a socket timeout throws a plain `Error`
// with `.name = 'TimeoutError'` (sometimes `.code` in
// `['ECONNRESET','EPIPE','ETIMEDOUT']`) that NEVER reaches the S3
// protocol's error deserialization at all — there is no HTTP response to
// build `$metadata` from, so it is never an `S3ServiceException` instance
// no matter how it is checked. r2-retry.test.ts's own "real MinIO"
// describe block confirms both shapes directly (a genuine
// `SignatureDoesNotMatch`/403 for the non-retryable case) rather than
// trusting this reasoning alone.

/** Minimal logger shape this file needs — the SAME `{ error(message,
 * meta?): void }` shape split-retry.ts's own `SplitRetryLogger` and
 * flush.ts's own `FlushBatchLogger` already use, deliberately not a
 * fourth shape. */
export interface R2RetryLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — writes to stderr via `console.error`, mirroring
 * the identical `consoleErrorLogger` split-retry.ts/flush.ts/
 * accumulator.ts already export, as a separate instance rather than a
 * shared import since none of these files have any other reason to
 * depend on each other. */
export const consoleErrorLogger: R2RetryLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** Delays for `ms` milliseconds. Injectable so tests can skip real
 * waiting while still observing the exponential backoff SEQUENCE — the
 * SAME seam split-retry.ts's own `Sleep`/`realSleep` already establish. */
export type Sleep = (ms: number) => Promise<void>;

/** Production default — a real `setTimeout`-based delay. */
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A single R2 PUT attempt, already bound to its own client/bucket/key/
 * body by the caller — see this file's own header for why this stays a
 * bare thunk rather than taking an `S3Client` or a `PutObjectCommand`
 * itself. */
export type R2Put = () => Promise<void>;

export type R2ErrorClassification = 'retryable' | 'non-retryable';

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;

/** Error `.name` values a transport-level timeout/connection failure is
 * known to carry — verified against @smithy/node-http-handler@4.9.11's
 * own source, see this file's own header. */
const RETRYABLE_TRANSPORT_ERROR_NAMES = new Set(['TimeoutError']);

/** Node.js error `.code` values the SAME transport layer also uses for a
 * socket-level failure (a reset, a broken pipe, or a raw OS-level
 * timeout) — again verified against @smithy/node-http-handler's own
 * `NODEJS_TIMEOUT_ERROR_CODES` constant. */
const RETRYABLE_TRANSPORT_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED']);

/**
 * Classifies an R2/S3 PUT rejection as `'retryable'` (a 5xx, throttling,
 * or a transport-level timeout/connection failure — worth spending another
 * attempt on) or `'non-retryable'` (everything else, INCLUDING 403/404 —
 * spending the retry budget on it only delays the alert, per this task's
 * own brief). See this file's own header for the full allowlist-not-
 * blocklist reasoning and the exact SDK fields this reads.
 */
export function classifyR2Error(error: unknown): R2ErrorClassification {
  if (!(error instanceof Error)) return 'non-retryable';

  if (RETRYABLE_TRANSPORT_ERROR_NAMES.has(error.name)) return 'retryable';

  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === 'string' && RETRYABLE_TRANSPORT_ERROR_CODES.has(code)) return 'retryable';

  const retryable = (error as { readonly $retryable?: { readonly throttling?: unknown } }).$retryable;
  if (retryable?.throttling === true) return 'retryable';

  const metadata = (error as { readonly $metadata?: { readonly httpStatusCode?: unknown } }).$metadata;
  const statusCode = metadata?.httpStatusCode;
  if (typeof statusCode === 'number') {
    const isThrottled = statusCode === HTTP_TOO_MANY_REQUESTS;
    const isServerError = statusCode >= HTTP_SERVER_ERROR_MIN && statusCode <= HTTP_SERVER_ERROR_MAX;
    return isThrottled || isServerError ? 'retryable' : 'non-retryable';
  }

  return 'non-retryable';
}

export interface R2RetryOptions {
  /**
   * Attempts before giving up on this PUT — the plan's own brief names 5
   * for production, but this stays a required, non-defaulted field (never
   * hardcoded in this module) matching split-retry.ts's own
   * `maxAttemptsPerBatch`. Must be a positive integer.
   */
  readonly maxAttempts: number;
  /**
   * Base delay before the SECOND attempt; each further retry doubles it
   * (attempt 1 -> 2 waits `initialDelayMs`, attempt 2 -> 3 waits
   * `initialDelayMs * 2`, ...) — the SAME sequence split-retry.ts's own
   * `SplitRetryOptions.initialDelayMs` documents. Must be a non-negative
   * integer.
   */
  readonly initialDelayMs: number;
  /** Defaults to {@link realSleep}. */
  readonly sleep?: Sleep;
  /** Defaults to {@link consoleErrorLogger}. */
  readonly logger?: R2RetryLogger;
}

/** The outcome of a single `retryR2Put` call — `attempts` is populated on
 * BOTH branches (unlike split-retry.ts's own `SplitRetryResult`, which has
 * no equivalent "how many tries did the successful one take" field) since
 * it costs nothing to report and is genuinely useful for the caller's own
 * DLQ `attemptsMade` metadata on the failure branch. */
export type R2PutOutcome =
  | { readonly succeeded: true; readonly attempts: number }
  | { readonly succeeded: false; readonly error: Error; readonly attempts: number };

function validateOptions(options: R2RetryOptions): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0) {
    throw new Error(`retryR2Put maxAttempts must be a positive integer; received ${options.maxAttempts}`);
  }
  if (!Number.isInteger(options.initialDelayMs) || options.initialDelayMs < 0) {
    throw new Error(`retryR2Put initialDelayMs must be a non-negative integer; received ${options.initialDelayMs}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalises an unknown rejection into a real `Error` — the SAME
 * fallback split-retry.ts's own `toError` already applies, preserving any
 * extra property (`.name`, `.$metadata`, `.code`) a caller attached when
 * the rejection already IS an `Error`. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

/**
 * Retries `put` with exponential backoff, up to `options.maxAttempts`
 * times — but ONLY for a `classifyR2Error`-`'retryable'` rejection. A
 * `'non-retryable'` rejection (403, 404, ...) short-circuits on the VERY
 * FIRST attempt, spending none of the remaining budget and sleeping not
 * at all — this is what makes the plan's own "a 403 fails after a single
 * attempt" verify wording literally true.
 *
 * Never throws for a classified PUT failure — the SAME "a handled outcome,
 * not an exceptional one" design split-retry.ts's own `retryWithSplit`
 * already follows for a poisoned sub-batch. DOES throw (reject) for
 * invalid `options`, mirroring `retryWithSplit`'s own `validateOptions`.
 */
export async function retryR2Put(put: R2Put, options: R2RetryOptions): Promise<R2PutOutcome> {
  validateOptions(options);

  const sleep = options.sleep ?? realSleep;
  const logger = options.logger ?? consoleErrorLogger;

  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      await put();
      return { succeeded: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryDecision = classifyR2Error(error);

      if (retryDecision === 'non-retryable') {
        logger.error(
          `retryR2Put: non-retryable error on attempt ${attempt}, giving up without retrying: ${errorMessage(error)}`,
          { attempt, retryDecision },
        );
        return { succeeded: false, error: toError(error), attempts: attempt };
      }

      if (attempt < options.maxAttempts) {
        await sleep(options.initialDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  logger.error(
    `retryR2Put: exhausted ${options.maxAttempts} attempt(s), all retryable: ${errorMessage(lastError)}`,
    { attempts: options.maxAttempts },
  );
  return { succeeded: false, error: toError(lastError), attempts: options.maxAttempts };
}

/** The literal `DlqReason` value this file's own R2-failure-routing seam
 * sends (dlq.service.ts's own `DlqReason` union, extended by this task to
 * include it — see that file's own header for the full "why a FOURTH
 * reason, and why not reuse an existing one" discussion). Exported as a
 * named constant, the SAME `FLUSH_POISON_DLQ_REASON` precedent
 * split-retry.ts already sets, so a caller wiring a real `DlqService` in
 * later never has to hand-type the string a second time. Deliberately NOT
 * imported from dlq.service.ts — this file stays unaware `DlqService`/
 * `EVENTS_DLQ_QUEUE` exist, matching split-retry.ts's own reasoning for
 * `PoisonDlqSink` below. Keep this value in sync with dlq.service.ts's
 * `DlqReason` by hand; a mismatch fails to compile the moment a real
 * `DlqService` is passed as an {@link R2BatchDlqSink} (structural typing
 * catches the drift there, not here). */
export const R2_PUT_FAILED_DLQ_REASON = 'r2-put-failed';

/** The narrow slice of `DlqService.send()`
 * (apps/worker/src/consumer/dlq.service.ts) `sendR2PutFailureToDlq` needs
 * — the SAME "narrow, replaceable seam" discipline split-retry.ts's own
 * `PoisonDlqSink` already establishes, so a real `DlqService` instance
 * satisfies this interface with zero adapter code while
 * r2-retry.test.ts substitutes a plain recording double instead of
 * booting a real BullMQ queue. */
export interface R2BatchDlqSink {
  send(
    reason: typeof R2_PUT_FAILED_DLQ_REASON,
    payload: unknown,
    error: Error,
    meta: { readonly originalJobId: string; readonly attemptsMade: number },
  ): Promise<void>;
}

/** The per-call metadata `sendR2PutFailureToDlq` needs beyond
 * `events`/`error` — `batchId` stands in for `DlqSendMeta.originalJobId`
 * the SAME way split-retry.ts's own `PoisonDlqMeta.batchId` does (a whole
 * batch has no single originating BullMQ job id), and `attemptsMade` is
 * `retryR2Put`'s own returned `R2PutOutcome.attempts` on the failure
 * branch — 1 for a non-retryable short-circuit, `options.maxAttempts`
 * for a genuinely exhausted retryable failure. */
export interface R2BatchDlqMeta {
  readonly batchId: string;
  readonly attemptsMade: number;
}

/**
 * Routes an entire failed batch to `dlqSink.send()` as ONE entry — NOT one
 * per event, unlike split-retry.ts's own `sendPoisonEventsToDlq`. That
 * distinction is deliberate and load-bearing: a poisoned event there was
 * isolated by binary search down to exactly the one row that would not
 * commit, so per-event entries are the natural unit. Here, an R2 PUT
 * failure says nothing about which event (if any) was individually at
 * fault — the WHOLE batch's single object write failed — so `events`
 * (every event still holding its full original shape) is stored as one
 * array-valued `rawPayload`, "payload intact" per this task's own brief.
 *
 * A `dlqSink.send()` rejection is NOT swallowed here — the SAME "a poison
 * event that fails to even reach the DLQ is exactly the outcome this
 * exists to prevent" reasoning split-retry.ts's own
 * `sendPoisonEventsToDlq` already documents.
 */
export async function sendR2PutFailureToDlq(
  events: readonly CaptureEvent[],
  error: Error,
  dlqSink: R2BatchDlqSink,
  meta: R2BatchDlqMeta,
): Promise<void> {
  await dlqSink.send(R2_PUT_FAILED_DLQ_REASON, events, error, {
    originalJobId: meta.batchId,
    attemptsMade: meta.attemptsMade,
  });
}

/**
 * Composes `retryR2Put` and `sendR2PutFailureToDlq`: attempts `put` with
 * backoff, and on ANY terminal failure (retries exhausted OR a
 * non-retryable error hit) routes the whole `events` batch to `dlqSink`
 * before resolving. This is the function a future caller (T3.4.6's own
 * job — see this file's own header) wires into flush.ts's `putEventBatch`
 * call site; `retryR2Put`/`sendR2PutFailureToDlq` stay separately exported
 * and independently useful for exactly the same "testable and reusable
 * without a DLQ dependency" reasons split-retry.ts's own header gives for
 * keeping `retryWithSplit` and `sendPoisonEventsToDlq` apart.
 *
 * Never throws for a classified PUT failure or a successful DLQ route —
 * resolves with the SAME `R2PutOutcome` `retryR2Put` itself would have
 * returned, so a caller can tell "committed" from "DLQ'd" without this
 * function inventing a THIRD result shape. A `dlqSink.send()` rejection
 * still propagates (`sendR2PutFailureToDlq`'s own contract, above) —
 * this function does not swallow it either.
 */
export async function putR2BatchWithRetry(
  put: R2Put,
  events: readonly CaptureEvent[],
  batchId: string,
  dlqSink: R2BatchDlqSink,
  options: R2RetryOptions,
): Promise<R2PutOutcome> {
  const outcome = await retryR2Put(put, options);

  if (!outcome.succeeded) {
    await sendR2PutFailureToDlq(events, outcome.error, dlqSink, {
      batchId,
      attemptsMade: outcome.attempts,
    });
  }

  return outcome;
}
