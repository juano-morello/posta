import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createR2Client, eventBatchKey, newId, type R2ClientConfig } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';
import {
  classifyR2Error,
  consoleErrorLogger,
  putR2BatchWithRetry,
  R2_PUT_FAILED_DLQ_REASON,
  retryR2Put,
  sendR2PutFailureToDlq,
  type R2BatchDlqSink,
  type R2Put,
  type R2RetryLogger,
  type R2RetryOptions,
  type Sleep,
} from './r2-retry';

// T3.4.5 [E3, S3.4][INV-7] — r2-retry.ts's own suite. Mirrors
// split-retry.test.ts's own "plain injected function, no real client
// needed to prove the ALGORITHM" choice for the bulk of this file: none of
// retryR2Put/sendR2PutFailureToDlq/putR2BatchWithRetry cares what the
// injected R2Put thunk actually does, only whether it resolves or rejects
// and, on rejection, what shape the rejection carries — exactly the same
// "generic over the operation" contract flush.ts's own FlushBatch and
// split-retry.ts's own retryWithSplit already establish for Postgres.
//
// ONE describe block near the bottom of this file (see its own header,
// below) DOES exercise a REAL createR2Client/MinIO PUT for two of the
// three mandated scenarios — a genuine AWS SDK error shape is the one
// thing a plain injected double cannot honestly stand in for, and
// classifyR2Error's whole job is reading fields off THAT real shape
// (`$metadata.httpStatusCode`, `$retryable`, `.name`), per this task's own
// "check the installed SDK's actual error types rather than guessing"
// instruction.

function buildCaptureEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: null,
    referer: null,
    accept: null,
    accept_language: null,
    sec_fetch_site: null,
    sec_fetch_mode: null,
    sec_fetch_dest: null,
    sec_fetch_user: null,
    sec_purpose: null,
    sec_ch_ua: null,
    sec_ch_ua_mobile: null,
    sec_ch_ua_platform: null,
    purpose: null,
    x_purpose: null,
    x_moz: null,
    country: null,
    asn: null,
    visitor_hash: null,
    ...overrides,
  };
}

function buildBatch(size: number): CaptureEvent[] {
  return Array.from({ length: size }, () => buildCaptureEvent());
}

/** Instant, no-real-wait `sleep` double — the SAME "narrow, replaceable
 * seam" split-retry.test.ts's own `createRecordingSleep` already
 * establishes. Records every `ms` argument, in call order, so the backoff
 * SEQUENCE is assertable without a test ever waiting on a real clock. */
function createRecordingSleep(): { sleep: Sleep; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

function createRecordingLogger(): R2RetryLogger & {
  calls: Array<{ message: string; meta?: Record<string, unknown> }>;
} {
  const calls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    calls,
    error(message, meta) {
      calls.push(meta !== undefined ? { message, meta } : { message });
    },
  };
}

interface RecordedDlqCall {
  readonly reason: typeof R2_PUT_FAILED_DLQ_REASON;
  readonly payload: unknown;
  readonly error: Error;
  readonly meta: { readonly originalJobId: string; readonly attemptsMade: number };
}

function createRecordingDlqSink(): R2BatchDlqSink & { calls: RecordedDlqCall[] } {
  const calls: RecordedDlqCall[] = [];
  return {
    calls,
    async send(reason, payload, error, meta) {
      calls.push({ reason, payload, error, meta });
    },
  };
}

function createRejectingDlqSink(): R2BatchDlqSink & { calls: number } {
  const sink = {
    calls: 0,
    async send(): Promise<void> {
      sink.calls += 1;
      throw new Error('dlq write failed');
    },
  };
  return sink;
}

/** A synthetic AWS SDK v3 service-exception-shaped error — duck-typed the
 * same way dlq.service.ts's own `extractSqlState` duck-types a Postgres
 * error's `.code`, rather than constructing a real `S3ServiceException`
 * (whose constructor wants a full `$metadata`/`$fault` options bag this
 * test has no reason to fill in beyond the fields classifyR2Error actually
 * reads). Verified against the REAL SDK's own error shape separately, in
 * this file's own "real MinIO" describe block below. */
function makeS3Error(options: {
  readonly name: string;
  readonly message?: string;
  readonly httpStatusCode?: number;
  readonly throttling?: boolean;
}): Error {
  const error = new Error(options.message ?? options.name);
  error.name = options.name;
  return Object.assign(error, {
    $metadata: options.httpStatusCode !== undefined ? { httpStatusCode: options.httpStatusCode } : {},
    ...(options.throttling !== undefined ? { $retryable: { throttling: options.throttling } } : {}),
  });
}

/** A synthetic `@smithy/node-http-handler` timeout — this transport-level
 * error never reaches an HTTP response at all, so unlike `makeS3Error` it
 * carries NO `$metadata` (verified against the installed
 * @smithy/node-http-handler source — see this file's own commit message /
 * r2-retry.ts's own header for the exact source line). */
function makeTimeoutError(): Error {
  return Object.assign(new Error('socket timed out'), { name: 'TimeoutError' });
}

function makeConnectionResetError(): Error {
  return Object.assign(new Error('read ECONNRESET'), { name: 'Error', code: 'ECONNRESET' });
}

/** A fake `R2Put` that rejects with each of `errors` in order, then
 * resolves (and flips `landed` to `true`) once `errors` is exhausted —
 * mirrors split-retry.test.ts's own `createFakeFlushBatch` in spirit:
 * tracks call count and records the actual delay sequence indirectly via
 * whatever `Sleep` double the caller supplies. */
function createScriptedPut(errors: readonly Error[]): { put: R2Put; callCount(): number; landed(): boolean } {
  let calls = 0;
  let landed = false;
  const put: R2Put = async () => {
    const error = errors[calls];
    calls += 1;
    if (error !== undefined) throw error;
    landed = true;
  };
  return { put, callCount: () => calls, landed: () => landed };
}

/** A fake `R2Put` that always rejects with `error` — used for both the
 * "exhausts every attempt" and "non-retryable fails immediately" cases. */
function createAlwaysFailingPut(error: Error): { put: R2Put; callCount(): number } {
  let calls = 0;
  const put: R2Put = async () => {
    calls += 1;
    throw error;
  };
  return { put, callCount: () => calls };
}

const FIVE_HUNDRED_ERROR = () => makeS3Error({ name: 'InternalError', httpStatusCode: 500 });
const FORBIDDEN_ERROR = () => makeS3Error({ name: 'AccessDenied', httpStatusCode: 403 });
const NOT_FOUND_ERROR = () => makeS3Error({ name: 'NoSuchBucket', httpStatusCode: 404 });

describe('classifyR2Error', () => {
  it.each([500, 502, 503, 599])('classifies a %i response as retryable', (httpStatusCode) => {
    expect(classifyR2Error(makeS3Error({ name: 'InternalError', httpStatusCode }))).toBe('retryable');
  });

  it('classifies HTTP 429 (Too Many Requests) as retryable', () => {
    expect(classifyR2Error(makeS3Error({ name: 'SlowDown', httpStatusCode: 429 }))).toBe('retryable');
  });

  it('classifies $retryable.throttling === true as retryable, even on a non-5xx status', () => {
    expect(
      classifyR2Error(makeS3Error({ name: 'RequestLimitExceeded', httpStatusCode: 400, throttling: true })),
    ).toBe('retryable');
  });

  it('classifies a TimeoutError (no $metadata at all — no response was ever received) as retryable', () => {
    expect(classifyR2Error(makeTimeoutError())).toBe('retryable');
  });

  it('classifies a raw ECONNRESET/ETIMEDOUT/EPIPE-coded error as retryable', () => {
    expect(classifyR2Error(makeConnectionResetError())).toBe('retryable');
  });

  it('classifies HTTP 403 (Forbidden) as non-retryable', () => {
    expect(classifyR2Error(FORBIDDEN_ERROR())).toBe('non-retryable');
  });

  it('classifies HTTP 404 (bucket not found) as non-retryable', () => {
    expect(classifyR2Error(NOT_FOUND_ERROR())).toBe('non-retryable');
  });

  it('classifies an ordinary 400 with no throttling signal as non-retryable', () => {
    expect(classifyR2Error(makeS3Error({ name: 'InvalidRequest', httpStatusCode: 400 }))).toBe('non-retryable');
  });

  it('classifies an Error with no recognizable AWS SDK shape as non-retryable (fail fast on the unknown)', () => {
    expect(classifyR2Error(new Error('something unexpected'))).toBe('non-retryable');
  });

  it('classifies a non-Error thrown value as non-retryable', () => {
    expect(classifyR2Error('a plain string rejection')).toBe('non-retryable');
    expect(classifyR2Error(undefined)).toBe('non-retryable');
    expect(classifyR2Error(null)).toBe('non-retryable');
  });
});

describe('retryR2Put — option validation', () => {
  const noopPut: R2Put = async () => undefined;

  it.each([0, -1, 1.5, Number.NaN])('rejects a non-positive-integer maxAttempts: %j', async (maxAttempts) => {
    await expect(
      retryR2Put(noopPut, { maxAttempts, initialDelayMs: 10 } as R2RetryOptions),
    ).rejects.toThrow(/maxAttempts/);
  });

  it.each([-1, 1.5, Number.NaN])('rejects a non-non-negative-integer initialDelayMs: %j', async (initialDelayMs) => {
    await expect(
      retryR2Put(noopPut, { maxAttempts: 5, initialDelayMs } as R2RetryOptions),
    ).rejects.toThrow(/initialDelayMs/);
  });
});

describe('retryR2Put — a PUT failing twice then succeeding lands the object', () => {
  it('retries with exponential backoff and resolves succeeded:true on the 3rd attempt', async () => {
    const { put, callCount, landed } = createScriptedPut([FIVE_HUNDRED_ERROR(), FIVE_HUNDRED_ERROR()]);
    const { sleep, delays } = createRecordingSleep();

    const result = await retryR2Put(put, { maxAttempts: 5, initialDelayMs: 10, sleep });

    expect(result).toEqual({ succeeded: true, attempts: 3 });
    expect(callCount()).toBe(3);
    expect(landed()).toBe(true);
    expect(delays).toEqual([10, 20]);
  });
});

describe('retryR2Put — exhausts every attempt on a persistent retryable failure', () => {
  it('calls put maxAttempts times with doubling backoff, then resolves succeeded:false', async () => {
    const { put, callCount } = createAlwaysFailingPut(FIVE_HUNDRED_ERROR());
    const { sleep, delays } = createRecordingSleep();
    const logger = createRecordingLogger();

    const result = await retryR2Put(put, { maxAttempts: 5, initialDelayMs: 10, sleep, logger });

    expect(callCount()).toBe(5);
    expect(result.succeeded).toBe(false);
    expect(result.attempts).toBe(5);
    if (!result.succeeded) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.name).toBe('InternalError');
    }
    // 5 attempts -> 4 waits between them, doubling from the base each time.
    expect(delays).toEqual([10, 20, 40, 80]);
    expect(logger.calls.length).toBeGreaterThan(0);
  });
});

describe('retryR2Put — a non-retryable error fails after a single attempt', () => {
  it('spends none of the retry budget on a 403', async () => {
    const { put, callCount } = createAlwaysFailingPut(FORBIDDEN_ERROR());
    const { sleep, delays } = createRecordingSleep();

    const result = await retryR2Put(put, { maxAttempts: 5, initialDelayMs: 10, sleep });

    expect(callCount()).toBe(1);
    expect(result.succeeded).toBe(false);
    expect(result.attempts).toBe(1);
    if (!result.succeeded) {
      expect(result.error.name).toBe('AccessDenied');
    }
    expect(delays).toEqual([]); // never slept — no retry was ever attempted
  });
});

describe('sendR2PutFailureToDlq', () => {
  it('routes the WHOLE batch as ONE DLQ entry, payload intact', async () => {
    const events = buildBatch(100);
    const error = FIVE_HUNDRED_ERROR();
    const sink = createRecordingDlqSink();

    await sendR2PutFailureToDlq(events, error, sink, { batchId: 'batch-123', attemptsMade: 5 });

    expect(sink.calls).toHaveLength(1);
    const [call] = sink.calls;
    expect(call?.reason).toBe(R2_PUT_FAILED_DLQ_REASON);
    expect(call?.payload).toBe(events); // same array reference — nothing copied, nothing summarized
    expect((call?.payload as CaptureEvent[]).length).toBe(100);
    expect(call?.error).toBe(error);
    expect(call?.meta).toEqual({ originalJobId: 'batch-123', attemptsMade: 5 });
  });

  it('does NOT swallow a dlqSink.send() rejection — propagates rather than vanishing silently', async () => {
    const sink = createRejectingDlqSink();

    await expect(
      sendR2PutFailureToDlq([buildCaptureEvent()], FIVE_HUNDRED_ERROR(), sink, {
        batchId: 'batch-1',
        attemptsMade: 1,
      }),
    ).rejects.toThrow(/dlq write failed/);
    expect(sink.calls).toBe(1);
  });
});

describe("putR2BatchWithRetry — the plan's three mandated verify scenarios", () => {
  it('[1] a PUT failing twice then succeeding lands the object — no DLQ entry is ever created', async () => {
    const events = buildBatch(10);
    const { put, callCount, landed } = createScriptedPut([FIVE_HUNDRED_ERROR(), FIVE_HUNDRED_ERROR()]);
    const { sleep } = createRecordingSleep();
    const dlqSink = createRecordingDlqSink();

    const result = await putR2BatchWithRetry(put, events, 'batch-1', dlqSink, {
      maxAttempts: 5,
      initialDelayMs: 10,
      sleep,
    });

    expect(result).toEqual({ succeeded: true, attempts: 3 });
    expect(callCount()).toBe(3);
    expect(landed()).toBe(true);
    expect(dlqSink.calls).toHaveLength(0);
  });

  it('[2] 5 failures produce ONE DLQ entry holding all 100 events', async () => {
    const events = buildBatch(100);
    const { put, callCount } = createAlwaysFailingPut(FIVE_HUNDRED_ERROR());
    const { sleep } = createRecordingSleep();
    const dlqSink = createRecordingDlqSink();

    const result = await putR2BatchWithRetry(put, events, 'batch-2', dlqSink, {
      maxAttempts: 5,
      initialDelayMs: 10,
      sleep,
    });

    expect(callCount()).toBe(5);
    expect(result.succeeded).toBe(false);
    expect(result.attempts).toBe(5);

    expect(dlqSink.calls).toHaveLength(1);
    const [call] = dlqSink.calls;
    expect(call?.reason).toBe(R2_PUT_FAILED_DLQ_REASON);
    expect((call?.payload as CaptureEvent[]).length).toBe(100);
    expect((call?.payload as CaptureEvent[]).map((e) => e.event_id).sort()).toEqual(
      events.map((e) => e.event_id).sort(),
    );
    expect(call?.meta).toEqual({ originalJobId: 'batch-2', attemptsMade: 5 });
  });

  it('[3] a 403 fails after a single attempt — the whole batch is still DLQ-routed, not silently dropped', async () => {
    const events = buildBatch(100);
    const { put, callCount } = createAlwaysFailingPut(FORBIDDEN_ERROR());
    const { sleep } = createRecordingSleep();
    const dlqSink = createRecordingDlqSink();

    const result = await putR2BatchWithRetry(put, events, 'batch-3', dlqSink, {
      maxAttempts: 5,
      initialDelayMs: 10,
      sleep,
    });

    expect(callCount()).toBe(1);
    expect(result.succeeded).toBe(false);
    expect(result.attempts).toBe(1);

    expect(dlqSink.calls).toHaveLength(1);
    const [call] = dlqSink.calls;
    expect((call?.payload as CaptureEvent[]).length).toBe(100);
    expect(call?.meta).toEqual({ originalJobId: 'batch-3', attemptsMade: 1 });
  });
});

// T3.4.5 — composes with a REAL createR2Client/MinIO PUT (no mocks) for
// two of the three scenarios: a genuine AWS SDK error shape is the one
// thing the synthetic `makeS3Error` above cannot honestly stand in for.
// Follows r2-put.test.ts's own established REAL_CONFIG/no-testcontainer
// pattern (MinIO is the already-running compose service, not a
// testcontainer) — duplicated here rather than imported, same precedent
// r2-put.test.ts/poison-dlq.test.ts already set for this exact constant.
describe('putR2BatchWithRetry / classifyR2Error — real createR2Client/MinIO composition', () => {
  const REAL_CONFIG: R2ClientConfig = {
    endpoint: 'http://localhost:9000',
    accessKeyId: 'posta-local-dev',
    secretAccessKey: 'posta-local-dev-secret',
    bucket: 'posta-events',
  };

  let r2Client: S3Client;
  const createdKeys: string[] = [];

  beforeAll(() => {
    r2Client = createR2Client(REAL_CONFIG);
  });

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await Promise.all(
        createdKeys.splice(0).map((key) =>
          r2Client.send(new DeleteObjectCommand({ Bucket: REAL_CONFIG.bucket, Key: key })),
        ),
      );
    }
    r2Client.destroy();
  });

  it('a real PUT, failing twice via an injected wrapper then delegating to the real client, actually lands the object in MinIO', async () => {
    const batchId = newId();
    const occurredAt = new Date().toISOString();
    const key = eventBatchKey(batchId, occurredAt);
    createdKeys.push(key);

    let attempts = 0;
    const put: R2Put = async () => {
      attempts += 1;
      if (attempts <= 2) throw FIVE_HUNDRED_ERROR();
      await r2Client.send(
        new PutObjectCommand({
          Bucket: REAL_CONFIG.bucket,
          Key: key,
          Body: Buffer.from('{"real":"object"}\n', 'utf-8'),
          ContentType: 'application/x-ndjson',
        }),
      );
    };
    const { sleep } = createRecordingSleep();

    const result = await retryR2Put(put, { maxAttempts: 5, initialDelayMs: 5, sleep });

    expect(result).toEqual({ succeeded: true, attempts: 3 });

    const getResult = await r2Client.send(new GetObjectCommand({ Bucket: REAL_CONFIG.bucket, Key: key }));
    const body = await getResult.Body?.transformToString('utf-8');
    expect(body).toBe('{"real":"object"}\n');
  });

  it('a REAL 403 from MinIO (bad credentials) classifies as non-retryable and fails putR2BatchWithRetry after one attempt', async () => {
    const badCredentialsClient = createR2Client({ ...REAL_CONFIG, secretAccessKey: 'not-the-real-secret' });
    const batchId = newId();
    const key = eventBatchKey(batchId, new Date().toISOString());

    let attempts = 0;
    const put: R2Put = async () => {
      attempts += 1;
      await badCredentialsClient.send(
        new PutObjectCommand({
          Bucket: REAL_CONFIG.bucket,
          Key: key,
          Body: Buffer.from('{}\n', 'utf-8'),
          ContentType: 'application/x-ndjson',
        }),
      );
    };
    const events = buildBatch(3);
    const dlqSink = createRecordingDlqSink();
    const { sleep } = createRecordingSleep();

    const result = await putR2BatchWithRetry(put, events, batchId, dlqSink, {
      maxAttempts: 5,
      initialDelayMs: 5,
      sleep,
    });

    expect(attempts).toBe(1);
    expect(result.succeeded).toBe(false);
    if (!result.succeeded) {
      expect(classifyR2Error(result.error)).toBe('non-retryable');
      expect(result.error.name === 'SignatureDoesNotMatch' || result.error.name === 'InvalidAccessKeyId').toBe(
        true,
      );
    }
    expect(dlqSink.calls).toHaveLength(1);

    badCredentialsClient.destroy();

    // No object was ever created under this key — confirm by expecting the
    // GET to reject (NoSuchKey), rather than assuming.
    await expect(r2Client.send(new GetObjectCommand({ Bucket: REAL_CONFIG.bucket, Key: key }))).rejects.toBeDefined();
  });
});

// Exercise consoleErrorLogger's own default branch once, matching
// split-retry.test.ts's/flush.test.ts's own established precedent for
// covering a console-writing default without asserting on stderr output
// itself (there is nothing meaningful to assert beyond "does not throw").
describe('consoleErrorLogger', () => {
  it('does not throw when called', () => {
    expect(() => consoleErrorLogger.error('r2-retry test message', { some: 'meta' })).not.toThrow();
    expect(() => consoleErrorLogger.error('r2-retry test message with no meta')).not.toThrow();
  });
});
