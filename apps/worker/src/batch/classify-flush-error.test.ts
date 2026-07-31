import { newId } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { FlushBatch } from './flush';
import { retryWithSplit, sendPoisonEventsToDlq, type PoisonDlqSink, type Sleep } from './split-retry';
import { classifyFlushError, extractSqlState, type FlushErrorClassification } from './classify-flush-error';

// T3.7.2 [E3, S3.7] — `classifyFlushError`'s own suite. See
// classify-flush-error.ts's own header for the full closed-allowlist
// design rationale this file proves against real SQLSTATEs.
//
// DRIZZLE-STYLE NESTED `cause` CHAINS, NOT A FLAT `.code` — every SQLSTATE
// case below is wrapped via the standard ES2022 `Error` `cause` option,
// the IDENTICAL mechanism drizzle-orm's own `DrizzleQueryError` uses
// (verified against the installed drizzle-orm@0.45.2 source, `errors.cjs`:
// `this.cause = cause`) to wrap the raw `pg` error it received — NOT a
// direct `import { DrizzleQueryError } from 'drizzle-orm'`, matching
// flush.ts's/idempotency.test.ts's own established "apps/worker never
// imports drizzle-orm directly" boundary (`apps/worker/package.json` has
// no `drizzle-orm` dependency at all; only `packages/core` does). A flat
// `.code` on the outer error alone would prove nothing about the
// `cause`-walk `extractSqlState` actually performs.

/** Builds a bare, `pg`-shaped `DatabaseError` stand-in: a plain `Error`
 * carrying a string `.code` and nothing else `extractSqlState` looks at. */
function buildPgStyleError(code: string): Error {
  const error = new Error(`simulated pg error ${code}`) as Error & { code?: string };
  error.code = code;
  return error;
}

/** Wraps a raw `pg`-shaped error in a drizzle-style outer `Error`, via the
 * standard `cause` option — the SAME wrapping mechanism a real
 * `DrizzleQueryError` uses (see this file's own header), without this
 * apps/worker-side test importing `drizzle-orm` itself. */
function buildDrizzleWrappedError(code: string): Error {
  return new Error('Failed query: insert into "events" ...', { cause: buildPgStyleError(code) });
}

describe('classifyFlushError — table-driven over real SQLSTATEs, read through a drizzle-style cause chain', () => {
  it.each([
    ['22003', 'numeric_value_out_of_range'],
    ['22021', 'character_not_in_repertoire'],
    ['23505', 'unique_violation'],
  ])('classifies SQLSTATE %s (%s) as row-fault', (sqlstate) => {
    const error = buildDrizzleWrappedError(sqlstate);
    expect(classifyFlushError(error)).toBe<FlushErrorClassification>('row-fault');
  });

  it.each([
    ['08006', 'connection_failure'],
    ['08003', 'connection_does_not_exist'],
    ['57P03', 'cannot_connect_now'],
    ['53100', 'disk_full'],
    ['42703', 'undefined_column'],
    ['42501', 'insufficient_privilege'],
    ['40001', 'serialization_failure'],
    ['XX000', 'unrecognised/internal_error'],
  ])('classifies SQLSTATE %s (%s) as infrastructure', (sqlstate) => {
    const error = buildDrizzleWrappedError(sqlstate);
    expect(classifyFlushError(error)).toBe<FlushErrorClassification>('infrastructure');
  });

  it('classifies a bare Error with no .code at all as infrastructure', () => {
    const error = new Error('accumulator write failed forever');
    expect(classifyFlushError(error)).toBe<FlushErrorClassification>('infrastructure');
  });

  it('classifies a non-Error rejection as infrastructure', () => {
    expect(classifyFlushError('a rejected string, not an Error')).toBe<FlushErrorClassification>('infrastructure');
    expect(classifyFlushError(undefined)).toBe<FlushErrorClassification>('infrastructure');
  });

  // THE DISCRIMINATING OUTAGE CASE — proves the default is deny-by-default
  // rather than "SQLSTATE-prefix lookup falls through to row-fault on no
  // match": ECONNREFUSED is a Node SYSTEM-ERROR code (the real shape `pg`
  // rejects with when the server is unreachable), not a SQLSTATE, and it
  // sits at the exact same `.code` property `extractSqlState` reads.
  it('classifies an Error carrying code: "ECONNREFUSED" (a Node system-error code, not a SQLSTATE) as infrastructure', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:5432') as Error & { code?: string };
    error.code = 'ECONNREFUSED';
    expect(classifyFlushError(error)).toBe<FlushErrorClassification>('infrastructure');
  });

  it('classifies ECONNREFUSED as infrastructure even wrapped in a DrizzleQueryError cause chain', () => {
    const error = buildDrizzleWrappedError('ECONNREFUSED');
    expect(classifyFlushError(error)).toBe<FlushErrorClassification>('infrastructure');
  });
});

describe('extractSqlState — bounded Error.cause walk, moved from dlq.service.ts', () => {
  it('reads .code off the outer error directly when present', () => {
    expect(extractSqlState(buildPgStyleError('23505'))).toBe('23505');
  });

  it('walks a nested cause chain to find the first .code', () => {
    expect(extractSqlState(buildDrizzleWrappedError('22003'))).toBe('22003');
  });

  it('returns null when no error in the chain carries a string .code', () => {
    expect(extractSqlState(new Error('plain failure'))).toBeNull();
  });
});

// ---------------------------------------------------------------------
// End-to-end: classifyFlushError wired into retryWithSplit's own DEFAULT
// classifier (split-retry.ts). This is the integration proof the plan's
// own verify wording asks for — deliberately living here, not in
// split-retry.test.ts (this task's own file list does not touch that
// file), since it exercises the composition of BOTH modules together.
// ---------------------------------------------------------------------

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

function createRecordingSleep(): Sleep {
  return async () => undefined;
}

describe('retryWithSplit — an infrastructure-classified failure never splits, retries its budget once then rejects', () => {
  it('a 100-event batch whose flushBatch ALWAYS rejects with an infrastructure error makes exactly maxAttemptsPerBatch total calls, rejects, and never reaches the DLQ sink', async () => {
    const events = Array.from({ length: 100 }, () => buildCaptureEvent());
    let calls = 0;
    const flushBatch: FlushBatch = async () => {
      calls += 1;
      throw buildDrizzleWrappedError('08006'); // connection_failure — infrastructure
    };
    const dlqSend = vi.fn(async () => undefined);
    const dlqSink: PoisonDlqSink = { send: dlqSend };

    const maxAttemptsPerBatch = 5;

    const runFlushAndDlq = async (): Promise<void> => {
      const result = await retryWithSplit(events, flushBatch, {
        maxAttemptsPerBatch,
        initialDelayMs: 0,
        sleep: createRecordingSleep(),
      });
      await sendPoisonEventsToDlq(result.poisonEvents, dlqSink, {
        batchId: 'infra-outage-batch',
        maxAttemptsPerBatch,
      });
    };

    await expect(runFlushAndDlq()).rejects.toThrow();

    // Never the 199 calls a full binary split of 100 events would make —
    // exactly one sub-batch's (the whole batch's) retry budget, spent
    // once, then rejected.
    expect(calls).toBe(maxAttemptsPerBatch);
    expect(dlqSend).not.toHaveBeenCalled();
  });

  it('a row-fault error still splits and isolates poison exactly as before this task', async () => {
    const poisonEvent = buildCaptureEvent();
    const events = [poisonEvent, buildCaptureEvent(), buildCaptureEvent()];

    const flushBatch: FlushBatch = async (batch) => {
      if (batch.some((event) => event.event_id === poisonEvent.event_id)) {
        throw buildDrizzleWrappedError('23505'); // unique_violation — row-fault
      }
    };

    const result = await retryWithSplit(events, flushBatch, {
      maxAttemptsPerBatch: 1,
      initialDelayMs: 0,
      sleep: createRecordingSleep(),
    });

    expect(result.poisonEvents).toHaveLength(1);
    expect(result.poisonEvents[0]?.event.event_id).toBe(poisonEvent.event_id);
    expect(result.committedEvents).toHaveLength(2);
  });

  it('an injected classifyFlushError override lets a caller substitute a synthetic classification without a real SQLSTATE', async () => {
    const events = [buildCaptureEvent(), buildCaptureEvent()];
    let calls = 0;
    const flushBatch: FlushBatch = async () => {
      calls += 1;
      throw new Error('generic rejection, no SQLSTATE');
    };

    await expect(
      retryWithSplit(events, flushBatch, {
        maxAttemptsPerBatch: 1,
        initialDelayMs: 0,
        sleep: createRecordingSleep(),
        classifyFlushError: () => 'row-fault',
      }),
    ).resolves.toMatchObject({
      poisonEvents: [
        { event: expect.objectContaining({ event_id: events[0]!.event_id }) },
        { event: expect.objectContaining({ event_id: events[1]!.event_id }) },
      ],
    });
    // 1 attempt at the pair, splits, 1 attempt each singleton -> 3 calls.
    expect(calls).toBe(3);
  });
});
