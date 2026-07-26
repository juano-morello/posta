import http from 'node:http';
import type { CaptureEvent } from '@posta/contracts';
import { isUlid } from '@posta/core';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_TEST_TIMEOUT_MS } from '../resolve-test-support';
import {
  HARNESS_DOMAIN,
  HARNESS_HANDLE,
  HARNESS_SLUG,
  startHotPathHarness,
  type HotPathHarness,
} from './hot-path-harness';

// T2.6.4 [INV-3][INV-8] — every response branch this hot path can
// plausibly acquire its own status-code decision must answer with EXACTLY
// 307, never 301 (invariant 3: a 301 gets cached by the visitor's browser
// and silently kills both analytics and future destination edits — see
// CLAUDE.md). And every request that DOES redirect must enqueue exactly
// one capture job carrying a freshly-minted 26-char ULID `event_id` —
// assigned ONCE, at capture, inside buildCapturePayload (capture.ts), and
// never reused or regenerated downstream (invariant 8).
//
// Reuses T2.6.1's own `startHotPathHarness()` — the REAL production
// redirect composition (main.ts's own wiring) against real Postgres +
// Redis testcontainers — rather than building a second stack; see that
// file's own header for exactly what it wires and what it stubs
// (lookupNetwork only).

interface RawResponse {
  readonly status: number;
}

interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

/** A plain `http.request` against the harness's own ephemeral port, with
 * the seeded link's Host header set explicitly and an optional method/
 * extra-headers override. Mirrors hot-path-harness.test.ts's own
 * `requestSeededLink`, widened to cover this file's own HEAD and
 * prefetch-header cases — kept file-local rather than moved into the
 * harness itself, which (per that file's own header) has no opinion on
 * what any ONE test wants to request. */
function requestSeededLink(baseUrl: string, options: RequestOptions = {}): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `/${HARNESS_SLUG}`,
        method: options.method ?? 'GET',
        headers: { Host: `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, ...options.headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Polls `harness.queue`'s own 'wait' list until it holds at least `count`
 * jobs, or `deadlineMs` elapses — the same "poll, don't fixed-sleep"
 * reasoning hot-path-harness.test.ts's own `waitForWaitingJobs`
 * documents: enqueueCapture is a REAL fire-and-forget call
 * (redirect-response.ts's own comment — the response is sent before the
 * capture pipeline even starts running), so the job for the LAST of N
 * concurrent requests can still be mid-flight after every HTTP response
 * has already come back. Nothing in this harness ever consumes a job (no
 * Worker is wired — see hot-path-harness.ts's own header), so a job that
 * reaches 'wait' stays there for this poll to find. */
async function waitForWaitingJobCount(
  harness: HotPathHarness,
  count: number,
  deadlineMs = 10_000,
): Promise<Job<CaptureEvent>[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const jobs = await harness.queue.getJobs(['wait']);
    if (jobs.length >= count || Date.now() > deadline) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('status-and-event-id (T2.6.4)', () => {
  let harness: HotPathHarness;

  beforeAll(async () => {
    harness = await startHotPathHarness();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  // [INV-3] Every response branch that could plausibly acquire its own
  // status-code decision, exercised in the order a freshly-booted harness
  // actually produces them: this file's very first request against
  // HARNESS_SLUG is necessarily a cold Postgres backfill (a cache MISS —
  // resolve-link.ts's own cache key is `link:{tenant}:{slug}`, and nothing
  // has written it yet), and only the SECOND request onward is a Redis
  // cache HIT. Split into separate `it`s — rather than one asserting
  // both — so a regression in either tier alone names itself in the
  // failing test's own title, not just its assertion message.

  it('answers exactly 307 on a cache miss (first request against the seeded link)', async () => {
    const response = await requestSeededLink(harness.baseUrl);
    expect(response.status).toBe(307);
  });

  it('answers exactly 307 on a cache hit (second request against the same slug)', async () => {
    const response = await requestSeededLink(harness.baseUrl);
    expect(response.status).toBe(307);
  });

  it('answers exactly 307 on a HEAD request', async () => {
    const response = await requestSeededLink(harness.baseUrl, { method: 'HEAD' });
    expect(response.status).toBe(307);
  });

  it('answers exactly 307 on a request carrying a prefetch header', async () => {
    // 'sec-purpose: prefetch' is one of the four prefetch tells capture.ts's
    // own readPrefetchTells reads (sec-purpose, purpose, x-purpose, x-moz).
    // Per invariants 4/5, human-vs-bot-vs-prefetch classification is a
    // READ-TIME SQL view, never computed on the redirect hot path — so this
    // header must change NOTHING about the status code, only what a later
    // query over the raw signal (which this test does not touch) goes on to
    // classify the resulting row as.
    const response = await requestSeededLink(harness.baseUrl, {
      headers: { 'sec-purpose': 'prefetch' },
    });
    expect(response.status).toBe(307);
  });

  // [INV-8] event_id is a ULID minted once, inside buildCapturePayload
  // (capture.ts), per successfully-redirected request — never reused,
  // never regenerated downstream. 100 concurrent requests against the same
  // already-cached link is the sharpest test of that: if event_id were
  // ever memoized or hardcoded, every one of the 100 jobs below would
  // collide on the SAME id instead of producing 100 distinct ones.
  it('produces exactly one job with a fresh 26-char ULID event_id per request — 100 requests, 100 distinct ids', async () => {
    // Drains whatever the four `it`s above already enqueued (this harness
    // wires no Worker — see hot-path-harness.ts's own header — so every
    // prior job is still sitting in 'wait'), so the count asserted below is
    // exactly this test's OWN 100 requests, not theirs plus 100.
    await harness.queue.drain(true);

    const REQUEST_COUNT = 100;
    const responses = await Promise.all(
      Array.from({ length: REQUEST_COUNT }, () => requestSeededLink(harness.baseUrl)),
    );
    for (const response of responses) {
      expect(response.status).toBe(307);
    }

    const jobs = await waitForWaitingJobCount(harness, REQUEST_COUNT);
    expect(jobs.length).toBe(REQUEST_COUNT);

    const eventIds = jobs.map((job) => job.data.event_id);
    for (const eventId of eventIds) {
      expect(eventId).toHaveLength(26);
      expect(isUlid(eventId)).toBe(true);
    }

    // Distinctness IS the invariant-8 assertion: a memoized/hardcoded
    // event_id collapses this Set to size 1 no matter how many requests ran.
    expect(new Set(eventIds).size).toBe(REQUEST_COUNT);
  });
});
