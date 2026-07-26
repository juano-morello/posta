import type { IncomingHttpHeaders } from 'node:http';
import type { CaptureEvent } from '@posta/contracts';
import { newId } from '@posta/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCapturePayload, computeVisitorHash, readClientIp, readSignals } from './capture';
import {
  createLogEnqueueFailure,
  type EnqueueFailureContext,
  type EnqueueFailureLogger,
} from './enqueue';
import { captureAllOutputChannels, createRecordingLogger, type RecordedLogCall } from './output-channel-test-support';

// T2.4.4 [security] — by the time enqueueCapture's returned promise
// rejects, the visitor already has their 307 (T2.4.3's own ordering
// guarantee) and is gone. All that remains is one log line, and it is the
// single place three different secrets could escape at once: the Redis
// password (ioredis embeds REDIS_URL in a connection error's own
// `.message`), the visitor's raw IP [INV-6], and the capture payload's
// signal values. This file proves logEnqueueFailure leaks NONE of them —
// not via the injected logger's own call log, and not via any OTHER
// output channel a stray `console.error`/`process.stderr.write` could use
// instead (captureAllOutputChannels, below, mirrors
// capture-privacy.test.ts's identical helper and identical reasoning for
// why that is "any injected logger" for this codebase as it exists
// today).
//
// The adversarial scenarios below build a REAL CaptureEvent via the real
// capture.ts pipeline (readSignals/readClientIp/computeVisitorHash/
// buildCapturePayload) — not a hand-typed literal — so "no capture-signal
// values leak" is proven against values that actually flowed through the
// same functions handleLinkTarget (middleware.ts) calls, carrying
// distinctive, greppable content in user_agent/referer/accept_language
// and a distinctive IP feeding visitor_hash. logEnqueueFailure itself is
// then called the same way middleware.ts's own `.catch()` call site
// calls it: with ONLY the three-field EnqueueFailureContext derived from
// that payload, never the payload itself — proving structurally, not
// just by inspection, that the rest of the payload has nowhere to leak
// from.

const DISTINCTIVE_USER_AGENT = 'PostaEnqueueLoggingTest/1.0 (distinctive-ua-marker-7f3c)';
const DISTINCTIVE_REFERER = 'https://distinctive-referer-marker-7f3c.example.test/campaign';
const DISTINCTIVE_ACCEPT_LANGUAGE = 'xx-DISTINCTIVE-LANG-MARKER-7f3c';
const DISTINCTIVE_IP = '203.0.113.99'; // RFC 5737 TEST-NET-3 — never a real host.
const WORKING_SALT = 'deterministic-test-salt-value-not-a-real-secret';

const REDIS_CREDENTIAL_MESSAGE = 'connect ECONNREFUSED redis://user:s3cret@host:6379';
const POSTGRES_CREDENTIAL_MESSAGE =
  'Connection terminated unexpectedly: postgresql://posta:Tr0ub4dor-AndFour@prod-db.internal:5432/posta';

/** Builds a real CaptureEvent through the real capture.ts pipeline,
 * carrying distinctive, greppable signal values plus a distinctive IP
 * feeding visitor_hash — see this file's header for why a hand-typed
 * literal would prove less. */
function buildDistinctivePayload(): CaptureEvent {
  const headers: IncomingHttpHeaders = {
    'user-agent': DISTINCTIVE_USER_AGENT,
    referer: DISTINCTIVE_REFERER,
    'accept-language': DISTINCTIVE_ACCEPT_LANGUAGE,
    'cf-connecting-ip': DISTINCTIVE_IP,
  };
  const signals = readSignals({ method: 'GET', headers });
  const ip = readClientIp(headers);
  const visitorHash = ip ? computeVisitorHash(ip, signals.user_agent, WORKING_SALT) : null;

  return buildCapturePayload({
    tenantId: 'tenant-1',
    linkId: 'link-1',
    slug: 'promo',
    signals,
    visitorHash,
    asn: 15169,
    country: 'AR',
  });
}

/** Derives the ONLY thing middleware.ts's real `.catch()` call site ever
 * hands logEnqueueFailure — mirrors that call site's own object-literal
 * shape (apps/api/src/redirect/middleware.ts's handleLinkTarget)
 * verbatim, so a drift between the two would be visible in a diff. */
function contextFor(payload: CaptureEvent): EnqueueFailureContext {
  return {
    eventId: payload.event_id,
    tenantId: payload.tenant_id,
    slug: payload.slug,
  };
}

// ── Output-channel capture ────────────────────────────────────────────
//
// [S2.4 fan-out fix round] captureAllOutputChannels/createRecordingLogger
// and their supporting types used to be defined here AND, independently,
// in capture-privacy.test.ts — ~77 duplicated lines that a story-level
// review found had already drifted apart (stringifyLoggable's Error
// handling differed between the two copies — this file's own version
// dropped the stack). Both moved to output-channel-test-support.ts; see
// that file's own header for the full reasoning.
// `createRecordingLogger`'s return type there (`RecordingLoggerLike`) is
// structurally identical to `EnqueueFailureLogger` (enqueue.ts), so it
// satisfies every call site here with no cast needed.

/** A logger that records but never forwards to console — for the
 * `@ts-expect-error` test below ONLY. That test's whole point is a
 * COMPILE-TIME rejection; `@ts-expect-error` only suppresses `tsc`, so
 * `vitest run` (esbuild, no type-checking) still executes the call for
 * real, and a brand only stops the accidental path at the type level —
 * see EnqueueFailureContext's own comment. Passing the WHOLE payload
 * this way genuinely spreads it into `logEnqueueFailure`'s meta object
 * at runtime; a console-forwarding logger would print every distinctive
 * signal value straight to this test run's real stderr, which is noise
 * this suite should not produce even inside a test. */
function createSilentLogger(calls: RecordedLogCall[]): EnqueueFailureLogger {
  return {
    error(message, meta) {
      calls.push(meta !== undefined ? { message, meta } : { message });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logEnqueueFailure — [security] redacted, structurally payload-free logging', () => {
  it('[security] a Redis connection error embedding REDIS_URL: logs event_id, redacts the password, keeps host:port, leaks no capture-signal value and no IP', () => {
    const payload = buildDistinctivePayload();
    const calls: RecordedLogCall[] = [];
    const logger = createRecordingLogger(calls);
    const logEnqueueFailure = createLogEnqueueFailure(logger);
    const error = new Error(REDIS_CREDENTIAL_MESSAGE);

    const channels = captureAllOutputChannels();
    try {
      logEnqueueFailure(error, contextFor(payload));
    } finally {
      channels.restore();
    }
    const output = `${channels.getOutput()}\n${JSON.stringify(calls)}`;

    // The one thing that MUST be there.
    expect(output).toContain(payload.event_id);

    // The password must be gone.
    expect(output).not.toContain('s3cret');

    // The connection must stay diagnosable: host and port survive.
    expect(output).toContain('host:6379');
    expect(output).toContain('redis://');

    // No capture-signal value anywhere in the log.
    expect(output).not.toContain(DISTINCTIVE_USER_AGENT);
    expect(output).not.toContain(DISTINCTIVE_REFERER);
    expect(output).not.toContain(DISTINCTIVE_ACCEPT_LANGUAGE);

    // Invariant 6 applies to this error-handler path specifically — the
    // raw IP must be absent too, even encoded (mirrors capture-privacy.test.ts's
    // own encoding sweep for the identical property).
    expect(output).not.toContain(DISTINCTIVE_IP);
    expect(output).not.toContain(Buffer.from(DISTINCTIVE_IP, 'utf8').toString('hex'));
    expect(output).not.toContain(Buffer.from(DISTINCTIVE_IP, 'utf8').toString('base64'));

    // visitor_hash itself (a DERIVED value, not the IP) is also never
    // logged — EnqueueFailureContext has no slot for it either.
    expect(payload.visitor_hash).not.toBeNull();
    expect(output).not.toContain(payload.visitor_hash as string);
  });

  it('[security] a Postgres connection error embedding DATABASE_URL is redacted too (shared redactor) — proven, not assumed — while host:port survive', () => {
    const payload = buildDistinctivePayload();
    const calls: RecordedLogCall[] = [];
    const logger = createRecordingLogger(calls);
    const logEnqueueFailure = createLogEnqueueFailure(logger);
    const error = new Error(POSTGRES_CREDENTIAL_MESSAGE);

    const channels = captureAllOutputChannels();
    try {
      logEnqueueFailure(error, contextFor(payload));
    } finally {
      channels.restore();
    }
    const output = `${channels.getOutput()}\n${JSON.stringify(calls)}`;

    expect(output).toContain(payload.event_id);
    expect(output).not.toContain('Tr0ub4dor-AndFour');
    expect(output).not.toContain('posta:Tr0ub4dor-AndFour');
    expect(output).toContain('prod-db.internal:5432/posta');
  });

  it('logs exactly five fields — eventId, tenantId, slug, errorName, errorMessage — and nothing else', () => {
    const calls: RecordedLogCall[] = [];
    const logger = createRecordingLogger(calls);
    const logEnqueueFailure = createLogEnqueueFailure(logger);
    const eventId = newId();

    logEnqueueFailure(new Error(REDIS_CREDENTIAL_MESSAGE), {
      eventId,
      tenantId: 'tenant-1',
      slug: 'promo',
    });

    expect(calls).toHaveLength(1);
    const meta = calls[0]?.meta;
    expect(meta).toBeDefined();
    expect(Object.keys(meta as Record<string, unknown>).sort()).toEqual(
      ['eventId', 'errorMessage', 'errorName', 'slug', 'tenantId'].sort(),
    );
    expect(meta).toMatchObject({ eventId, tenantId: 'tenant-1', slug: 'promo', errorName: 'Error' });
  });

  it('never logs the stack, even though the Error carries one', () => {
    const calls: RecordedLogCall[] = [];
    const logger = createRecordingLogger(calls);
    const logEnqueueFailure = createLogEnqueueFailure(logger);
    const error = new Error('queue add failed');
    error.stack = 'DISTINCTIVE_STACK_MARKER_7f3c\n    at somewhere (secret/internal/path.ts:1:1)';

    const channels = captureAllOutputChannels();
    try {
      logEnqueueFailure(error, { eventId: newId(), tenantId: 'tenant-1', slug: 'promo' });
    } finally {
      channels.restore();
    }
    const output = `${channels.getOutput()}\n${JSON.stringify(calls)}`;

    expect(output).not.toContain('DISTINCTIVE_STACK_MARKER_7f3c');
    expect(output).not.toContain('secret/internal/path.ts');
  });

  it('never logs .cause, even when the Error carries one', () => {
    const calls: RecordedLogCall[] = [];
    const logger = createRecordingLogger(calls);
    const logEnqueueFailure = createLogEnqueueFailure(logger);
    const error = new Error('queue add failed', { cause: 'DISTINCTIVE_CAUSE_MARKER_7f3c' });

    logEnqueueFailure(error, { eventId: newId(), tenantId: 'tenant-1', slug: 'promo' });

    expect(JSON.stringify(calls)).not.toContain('DISTINCTIVE_CAUSE_MARKER_7f3c');
  });

  it('a non-Error rejection (a thrown string) still produces a safe, redacted line', () => {
    const calls: RecordedLogCall[] = [];
    const logger = createRecordingLogger(calls);
    const logEnqueueFailure = createLogEnqueueFailure(logger);

    logEnqueueFailure(REDIS_CREDENTIAL_MESSAGE, {
      eventId: newId(),
      tenantId: 'tenant-1',
      slug: 'promo',
    });

    const meta = calls[0]?.meta;
    expect(meta?.errorName).toBe('string');
    expect(meta?.errorMessage).not.toContain('s3cret');
    expect(meta?.errorMessage).toContain('host:6379');
  });

  it('never throws itself, regardless of what error value it is handed', () => {
    const logger = createRecordingLogger([]);
    const logEnqueueFailure = createLogEnqueueFailure(logger);
    const context: EnqueueFailureContext = { eventId: newId(), tenantId: 'tenant-1', slug: 'promo' };

    expect(() => logEnqueueFailure(undefined, context)).not.toThrow();
    expect(() => logEnqueueFailure(null, context)).not.toThrow();
    expect(() => logEnqueueFailure({ weird: 'object' }, context)).not.toThrow();
  });

  it('rejects passing the whole CaptureEvent payload as ctx at COMPILE TIME — EnqueueFailureContext has no eventId/tenantId slot a CaptureEvent structurally fills', () => {
    const payload = buildDistinctivePayload();
    const logger = createSilentLogger([]);
    const logEnqueueFailure = createLogEnqueueFailure(logger);

    // @ts-expect-error — EnqueueFailureContext requires `eventId`/`tenantId`/
    // `slug` (camelCase); CaptureEvent's own fields are `event_id`/
    // `tenant_id`/`slug` (snake_case, packages/contracts/src/capture.ts) —
    // a CaptureEvent value has no `eventId`/`tenantId` property, so passing
    // the whole payload here fails to typecheck instead of silently
    // widening what this log line carries. Checked by `pnpm typecheck:tests`
    // (tsconfig.test.json), which includes this file — NOT by `vitest run`,
    // which transpiles test files with esbuild and never type-checks them.
    // Verified by hand: renaming EnqueueFailureContext's fields to
    // event_id/tenant_id/slug makes `pnpm typecheck:tests` fail here with
    // "Unused '@ts-expect-error' directive" — the payload then satisfies
    // the context type with no error left to suppress, proving this line
    // genuinely depends on the naming difference rather than passing
    // vacuously.
    logEnqueueFailure(new Error('boom'), payload);
  });
});
