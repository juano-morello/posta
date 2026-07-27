import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureEventSchema, type CaptureEvent } from '@posta/contracts';
import { newId } from '../ulid';
import { EVENTS_DLQ_QUEUE, EVENTS_JOB_OPTIONS, EVENTS_QUEUE, eventJobSchema } from './events-queue';

// T3.1.1 [E3, S3.1] — three things this file has to prove, matching the
// task's own verify command:
//   1. EVENTS_JOB_OPTIONS carries the exact retry policy the plan text
//      specifies (attempts: 5, exponential backoff from 1000ms) AND the
//      general property that policy is an instance of ("a real retry
//      policy", not merely these exact numbers) — so a future tuning
//      pass that changes the numbers doesn't also have to touch this
//      second assertion's *shape*.
//   2. eventJobSchema inherits CaptureEventSchema's `.strict()` — a
//      payload carrying an `ip` key (invariant 6: the raw IP is never
//      stored OR QUEUED) must fail validation, proven here rather than
//      assumed from reading capture.ts.
//   3. No file under apps/ declares EVENTS_QUEUE's or EVENTS_DLQ_QUEUE's
//      literal string value — the enforcement mechanism for "core is the
//      only place these names are spelled out", mirroring
//      tests/conventions/no-literal-domain.test.ts's own grep-based
//      pattern for POSTA_LINK_DOMAIN (CLAUDE.md: "No literal domain may
//      appear in code — a grep test enforces it").

const VALID_EVENT: CaptureEvent = {
  event_id: newId(),
  occurred_at: new Date().toISOString(),
  tenant_id: 'tenant-1',
  link_id: 'link-1',
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
};

describe('EVENTS_QUEUE / EVENTS_DLQ_QUEUE', () => {
  it('are distinct, non-empty queue names', () => {
    expect(EVENTS_QUEUE).toBe('events');
    expect(EVENTS_DLQ_QUEUE).toBe('events-dlq');
    expect(EVENTS_QUEUE).not.toBe(EVENTS_DLQ_QUEUE);
  });
});

describe('EVENTS_JOB_OPTIONS', () => {
  it('matches the T3.1.1 spec literally: attempts 5, exponential backoff from 1000ms', () => {
    expect(EVENTS_JOB_OPTIONS.attempts).toBe(5);
    expect(EVENTS_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('holds the general retry-policy property (>= 3 attempts, exponential backoff) independent of the exact numbers', () => {
    expect(EVENTS_JOB_OPTIONS.attempts).toBeGreaterThanOrEqual(3);

    const backoff = EVENTS_JOB_OPTIONS.backoff;
    expect(typeof backoff).toBe('object');
    expect(backoff && typeof backoff === 'object' ? backoff.type : undefined).toBe('exponential');
  });

  it('bounds removeOnComplete and never auto-removes a failed job', () => {
    // removeOnFail: false is deliberate, not an oversight — see
    // events-queue.ts's own header for why this supersedes T2.4.2's
    // bounded removeOnFail: 500 now that a failed job has somewhere to
    // go (EVENTS_DLQ_QUEUE, T3.1.4/T3.1.5).
    expect(EVENTS_JOB_OPTIONS.removeOnComplete).toBe(1000);
    expect(EVENTS_JOB_OPTIONS.removeOnFail).toBe(false);
  });
});

describe('eventJobSchema', () => {
  it('accepts a valid CaptureEvent payload', () => {
    expect(eventJobSchema.safeParse(VALID_EVENT).success).toBe(true);
  });

  it('rejects a payload carrying an ip key [INV-6]', () => {
    const result = eventJobSchema.safeParse({ ...VALID_EVENT, ip: '203.0.113.5' });
    expect(result.success).toBe(false);
  });

  it('rejects any other unrecognized key, not just ip', () => {
    const result = eventJobSchema.safeParse({ ...VALID_EVENT, extra_field: 'anything' });
    expect(result.success).toBe(false);
  });

  it('IS CaptureEventSchema — same reference, so its .strict() enforcement can never drift out of sync', () => {
    expect(eventJobSchema).toBe(CaptureEventSchema);
  });
});

describe('no literal queue-name string under apps/', () => {
  // Scope: apps/**/*.ts only (per the task brief) — packages/core is
  // where EVENTS_QUEUE/EVENTS_DLQ_QUEUE are DEFINED, so scanning it too
  // would make this test fail on its own source. *.test.ts files are
  // excluded: a test file's job is to describe queue behavior in prose
  // (e.g. "builds a queue named 'events'"), which is not the producer/
  // consumer name-mismatch bug this guard exists to catch.
  const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.next', '.turbo', '.git', 'coverage']);

  /** Matches an EXACT quoted string literal — 'events' or "events", not
   * a substring match. A bare `.includes('events')` would false-positive
   * on every legitimate identifier or comment containing that common
   * English word (`eventsQueue`, `events_default`, "writes events to
   * Postgres", ...) — all of which are real, current, non-violating
   * content under apps/. Only an actual quoted STRING LITERAL equal to
   * the queue name is the thing this guard is for. */
  function containsLiteralAsQuotedString(line: string, literal: string): boolean {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(['"])${escaped}\\1`);
    return pattern.test(line);
  }

  function walk(dir: string, hits: string[]): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new Error(
        `Failed to read directory "${dir}" while scanning for literal queue names: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, hits);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;

      const content = readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (
          containsLiteralAsQuotedString(line, EVENTS_QUEUE) ||
          containsLiteralAsQuotedString(line, EVENTS_DLQ_QUEUE)
        ) {
          hits.push(`${path.relative(process.cwd(), fullPath)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }

  it('finds no quoted "events" / "events-dlq" string literal under apps/', () => {
    const hits: string[] = [];
    walk(path.join(process.cwd(), 'apps'), hits);

    expect(hits).toEqual([]);
  });
});
