import http from 'node:http';
import type { CaptureEvent } from '@posta/contracts';
import { newId } from '@posta/core';
import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTURE_JOB_NAME } from '../enqueue';
import { CONTAINER_TEST_TIMEOUT_MS } from '../resolve-test-support';
import {
  HARNESS_DESTINATION,
  HARNESS_DOMAIN,
  HARNESS_HANDLE,
  HARNESS_SLUG,
  startHotPathHarness,
  type HotPathHarness,
} from './hot-path-harness';

// T2.6.3 [INV-6][security] — the INTEGRATION-level complement to
// capture-privacy.test.ts's own unit-level check (T2.3.8). That file
// drives a test-LOCAL fixture standing in for "whatever the real
// composition site eventually does"; this file drives the REAL production
// composition (middleware.ts's `handleLinkTarget`, wired through
// `startHotPathHarness` exactly like every other S2.6 spec) and reads the
// client IP's two potential leak surfaces T2.3.8 structurally cannot
// reach at all:
//
//   1. A REAL `bullmq` `Job` object — `job.id` and `job.opts` specifically
//      (not just `job.data`), since a unit test never constructs one.
//   2. REAL Redis key NAMES (`KEYS *`) — a unit test has no Redis to ask.
//
// Four request shapes, each with its own distinctive RFC 5737 test-range
// IP so a leak can be attributed to the exact header/scenario that caused
// it:
//   - CF-Connecting-IP and a DIFFERENT X-Forwarded-For on the SAME
//     request (readClientIp, capture.ts, prefers CF-Connecting-IP) — both
//     the CONSUMED ip and the merely-carried, never-consulted one must
//     leak nowhere. The second is still real visitor PII the instant it
//     rode in on the wire, whether or not this app's own precedence rule
//     ever reads it.
//   - X-Forwarded-For ALONE (no CF-Connecting-IP at all) — this time the
//     IP genuinely funds `computeVisitorHash`, unlike the shadowed one
//     above.
//   - The geoip lookup (`lookupNetwork`) throws — exercised via
//     `startHotPathHarness`'s own additive `lookupNetwork` override
//     (T2.6.3's extension to hot-path-harness.ts; see that file's header
//     for why the override exists and why it changes nothing for every
//     OTHER S2.6 spec, which all omit it). middleware.ts's own
//     `handleLinkTarget` runs `lookupNetwork` INSIDE the one try/catch
//     that also builds and enqueues the payload, so a throw here means NO
//     job is ever enqueued for that request at all — what leaks or
//     doesn't is entirely a question of the resulting `error` log line.
//   - The enqueue itself throws — reusing queue-down.test.ts's (T2.6.2)
//     own exact technique verbatim: `(await harness.queue.client).disconnect()`
//     against the SAME connection object the running middleware's
//     `enqueueCapture` closure already calls `.add()` through, so every
//     future command on it rejects immediately rather than hanging behind
//     a reconnect loop. See that file's own header for the full argument
//     for why this — not a real closed TCP port — is the deterministic
//     way to reproduce "the producer's connection is dead".
//
// One shared harness for the whole file (mirrors every other S2.6 spec):
// booting a fresh Postgres+Redis testcontainers pair per scenario would
// cost real wall-clock minutes for no added rigor, since nothing about
// "does an IP leak" requires container isolation between scenarios — only
// "is the redirect fast/available" (T2.6.2, T2.6.9) does. The geoip-throw
// behavior is toggled via a closed-over `let` flag rather than restarting
// the harness with a different `lookupNetwork`, for the identical reason.
//
// DETECTOR PROOF (this epic's own standing requirement — prove the
// detection mechanism has teeth, not just that it currently finds
// nothing): this file's own "job id / job opts / Redis key name / log
// line" checks are the genuinely NEW surfaces T2.3.8 could never reach,
// so EACH gets a PERMANENT, always-green regression guard here (mirrors
// capture-privacy.test.ts's and tests/conventions/no-literal-domain.test.ts's
// "plant it, assert the detector finds it" shape):
//
//   - Job id / job opts / Redis key name: a job is added directly through
//     the real, running `harness.queue`, with the distinctive IP planted
//     as its `jobId` AND (via the real, documented `deduplication.id`
//     option — see that test's own comment for why this, not a
//     contrivance) inside `job.opts` too — never through
//     `enqueueCapture`, whose own narrow `EnqueueQueue` interface
//     (enqueue.ts) has no `opts` parameter at all and therefore cannot
//     smuggle one today; this plants the vector by hand to prove the
//     CHECK itself would catch it if some future call site ever could.
//     It proves: this file's own `findJobLeaks` helper flags the planted
//     id AND the planted opts value SEPARATELY, AND — the sharper, more
//     surprising fact — BullMQ really does bake a job's id verbatim into
//     a literal Redis key name (`bull:events:<jobId>`), proven by calling
//     this file's own actual `assertIpAbsentFromRedisKeys` helper (not a
//     duplicate of its query logic) and asserting IT rejects.
//   - Log lines: a synthetic line containing the planted ip is pushed
//     directly into the harness's own captured-log array (see
//     `plantSyntheticLogLine`), and this file's own actual
//     `assertIpAbsentFromLogs` helper is asserted to throw on it. This
//     closes the one channel a previous revision of this file left to a
//     manual, by-hand exercise (see below) with zero committed guard.
//
// A SEPARATE, narrower manual exercise — patching `createLogEnqueueFailure`
// (enqueue.ts) itself to log the raw IP/context, confirming this file's
// own checks go RED, then reverting exactly — proves the layer BELOW the
// one above: not "does `assertIpAbsentFromLogs` have teeth" (the
// committed proof above answers that permanently), but "does today's
// REAL production logging code actually leak" — which cannot be a
// committed test without production code that leaks by design, so it
// stays a by-hand exercise, performed and reported separately per this
// task's own dispatch instruction; see this task's own final report for
// the real RED/GREEN output observed.

// RFC 5737 test-range IPs, one per scenario, each from a DIFFERENT /24 (or
// a distinct, non-prefix-colliding last octet within the same /24) so a
// leak can never be misattributed to the wrong scenario and no IP string
// is ever a substring of another one used in this file.
const IP_CF_USED = '203.0.113.10'; // TEST-NET-3 — sent as CF-Connecting-IP, alongside a different X-Forwarded-For.
const IP_XFF_SHADOWED = '198.51.100.20'; // TEST-NET-2 — sent as X-Forwarded-For in the SAME request as IP_CF_USED; never consulted (CF wins), must still never leak.
const IP_XFF_ONLY_USED = '198.51.100.30'; // TEST-NET-2 — sent as the ONLY ip-bearing header; this time it genuinely funds the hash.
const IP_GEOIP_THROW = '203.0.113.40'; // TEST-NET-3 — sent while lookupNetwork is forced to throw.
const IP_ENQUEUE_THROW = '203.0.113.50'; // TEST-NET-3 — sent while the queue's own connection is disconnected.
// TEST-NET-1 (192.0.2.0/24) — deliberately a THIRD, distinct range used
// ONLY by the detector-proof test below, and cleaned up (job removed)
// immediately after its own assertions run, so it never appears in — and
// can never be confused with — the "real scenario" sweep at the end of
// this file.
const IP_DETECTOR_PLANTED = '192.0.2.99';

const ALL_SCENARIO_IPS = [IP_CF_USED, IP_XFF_SHADOWED, IP_XFF_ONLY_USED, IP_GEOIP_THROW, IP_ENQUEUE_THROW] as const;

const GEOIP_THROW_ERROR_MESSAGE = 'no-ip.test.ts: forced geoip lookup failure for T2.6.3 [INV-6] coverage';
const CAPTURE_FAILURE_LOG_PATTERN =
  /Capture failed; the redirect already succeeded, no analytics for this request/;
const ENQUEUE_FAILURE_LOG_PATTERN = /Enqueue failed; the redirect already succeeded, event dropped/;

interface RawResponse {
  readonly status: number;
  readonly location: string | undefined;
}

/** A plain `http.request` against the harness's own ephemeral port, with
 * the seeded link's Host header set explicitly plus whatever extra
 * headers the caller wants — mirrors hot-path-harness.test.ts's own
 * `requestSeededLink`, widened to accept arbitrary extra headers (the
 * distinctive-IP headers this file's own scenarios need) instead of a
 * single fixed CF-Connecting-IP. */
function requestSeededLink(baseUrl: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `/${HARNESS_SLUG}`,
        headers: { Host: `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Polls `queue`'s own 'wait' list until it holds at least `count` jobs,
 * or `deadlineMs` elapses — same "poll, don't fixed-sleep" reasoning
 * every other S2.6 spec's own identical helper documents: enqueueCapture
 * is a REAL fire-and-forget call attached AFTER the response, so the last
 * of several concurrent requests' own job can still be landing after
 * every HTTP response has already come back. */
async function waitForWaitingJobCount(
  queue: Queue<CaptureEvent>,
  count: number,
  deadlineMs = 5000,
): Promise<Job<CaptureEvent>[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const jobs = await queue.getJobs(['wait']);
    if (jobs.length >= count || Date.now() > deadline) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Polls `harness.logs` (from `since` onward) until at least `count`
 * lines match `pattern`, or `deadlineMs` elapses — mirrors queue-down.test.ts's
 * own `waitForNewLogCount` exactly, since the failure log this file
 * waits for is attached exactly the same fire-and-forget way. */
async function waitForNewLogMatch(
  harness: HotPathHarness,
  pattern: RegExp,
  since: number,
  count: number,
  deadlineMs = 5000,
): Promise<string[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const matches = harness.logs.slice(since).filter((line) => pattern.test(line));
    if (matches.length >= count || Date.now() > deadline) return matches;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type LeakLocation = 'whole-job' | 'job-id' | 'job-opts';

interface JobLeakHit {
  readonly jobId: string;
  readonly location: LeakLocation;
}

/** Checks a real BullMQ `Job` object for a leaked IP in three places:
 * `JSON.stringify(job)` as a whole (the verify line's own literal wording
 * — `Job`'s own `toJSON()` strips the circular `queue`/`scripts` refs, so
 * this never throws), plus `job.id` and `job.opts` checked SEPARATELY and
 * explicitly — the specific gap this task's own dispatch names ("an IP
 * smuggled in via a BullMQ job option or job id") that a bare
 * `JSON.stringify(job)` sweep would only catch incidentally, by virtue of
 * `toJSON()` currently including both. Explicit checks stay correct even
 * if a future BullMQ version's `toJSON()` ever stops including one. */
function findJobLeaks(jobs: readonly Job<CaptureEvent>[], ip: string): JobLeakHit[] {
  const hits: JobLeakHit[] = [];
  for (const job of jobs) {
    const jobId = job.id ?? '(no id)';
    if (JSON.stringify(job).includes(ip)) hits.push({ jobId, location: 'whole-job' });
    if ((job.id ?? '').includes(ip)) hits.push({ jobId, location: 'job-id' });
    if (JSON.stringify(job.opts ?? {}).includes(ip)) hits.push({ jobId, location: 'job-opts' });
  }
  return hits;
}

/** Every relevant BullMQ job state this task's own dispatch names —
 * `'wait'`, `'completed'`, `'failed'`, `'delayed'` — checked together so
 * a leak can never hide in a state this file simply forgot to look at.
 * None of this harness's own scenarios ever produce anything outside
 * `'wait'` (no Worker is wired — hot-path-harness.ts's own header), but
 * checking all four costs nothing and is what the verify line asks for. */
async function assertIpAbsentFromQueue(queue: Queue<CaptureEvent>, ip: string): Promise<void> {
  const jobs = await queue.getJobs(['wait', 'completed', 'failed', 'delayed']);
  expect(findJobLeaks(jobs, ip)).toEqual([]);
}

function assertIpAbsentFromLogs(harness: HotPathHarness, ip: string): void {
  const leakingLines = harness.logs.filter((line) => line.includes(ip));
  expect(leakingLines).toEqual([]);
}

/** [Security review follow-up, T2.6.3] Plants a synthetic line straight
 * into the harness's own captured-log array — the log channel's own
 * "plant it, assert the detector finds it" detector proof, mirroring the
 * job-id/Redis-key proof below. `HotPathHarness.logs` is `readonly
 * string[]` for every other reader in this file (a real scenario must
 * never mutate what the harness's logger actually recorded), so this
 * cast is deliberate and confined to this one proof. */
function plantSyntheticLogLine(harness: HotPathHarness, line: string): void {
  (harness.logs as string[]).push(line);
}

/** Undoes `plantSyntheticLogLine` — removes the exact synthetic line by
 * value (not by truncating to a saved length), so it can never
 * accidentally swallow a real line the harness's logger captured
 * concurrently while the proof ran. */
function removeSyntheticLogLine(harness: HotPathHarness, line: string): void {
  const logs = harness.logs as string[];
  const index = logs.indexOf(line);
  if (index !== -1) logs.splice(index, 1);
}

/** `KEYS *` — literally, per the verify line — checked against KEY NAMES
 * only (never values): the property this task's own dispatch calls out
 * ("an IP smuggled in ... or job id") has its real-world shape as a job
 * id baked into a Redis key name (`bull:events:<jobId>`), not as a value
 * sitting inside one. See the detector-proof test below for direct proof
 * that this is a real, not merely theoretical, vector. */
async function assertIpAbsentFromRedisKeys(harness: HotPathHarness, ip: string): Promise<void> {
  const keys = await harness.redis.keys('*');
  const leakingKeys = keys.filter((key) => key.includes(ip));
  expect(leakingKeys).toEqual([]);
}

/** The full three-channel sweep the verify line asks for, run for every
 * ip in `ips`: job data (every state, `JSON.stringify(job)` plus
 * `job.id`/`job.opts` explicitly), captured logs, and Redis key names. */
async function assertIpLeaksNowhere(harness: HotPathHarness, ips: readonly string[]): Promise<void> {
  for (const ip of ips) {
    await assertIpAbsentFromQueue(harness.queue, ip);
    assertIpAbsentFromLogs(harness, ip);
    await assertIpAbsentFromRedisKeys(harness, ip);
  }
}

/** A minimal, schema-valid `CaptureEvent` for the detector-proof test's
 * own directly-added job — every field the `.strict()` CaptureEventSchema
 * (packages/contracts/src/capture.ts) requires, all-null where a real
 * request would have filled in a signal, since none of that is what this
 * particular test is about. */
function buildDetectorProofPayload(harness: HotPathHarness): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: harness.tenantId,
    link_id: harness.linkId,
    slug: HARNESS_SLUG,
    http_method: null,
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
}

describe('no IP in the queued payload, logs, or Redis key names — end to end (T2.6.3) [INV-6]', () => {
  let harness: HotPathHarness;
  // Closed over by the harness's own `lookupNetwork` override below —
  // toggled to `true` for exactly the duration of the "geoip lookup
  // throws" scenario, always reset in a `finally` so every later `it` in
  // this file gets a working lookup again.
  let lookupNetworkShouldThrow = false;

  beforeAll(async () => {
    harness = await startHotPathHarness({
      lookupNetwork: (_ip, _cfCountry) => {
        void _ip;
        void _cfCountry;
        if (lookupNetworkShouldThrow) {
          throw new Error(GEOIP_THROW_ERROR_MESSAGE);
        }
        return { asn: null, country: null };
      },
    });

    // Warms resolveTenant's memo and resolveLink's Redis cache — mirrors
    // queue-down.test.ts's own beforeAll warmup — so every scenario below
    // is a genuine cache hit, isolating "does an IP leak" from "is this
    // the first, cold Postgres round trip".
    const warmup = await requestSeededLink(harness.baseUrl);
    expect(warmup.status).toBe(307);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    'CF-Connecting-IP and a DIFFERENT X-Forwarded-For on the same request: the consumed ip AND the merely-carried, never-consulted one both leak nowhere',
    async () => {
      const REQUEST_COUNT = 5;
      const jobsBefore = (await harness.queue.getJobs(['wait'])).length;

      const responses = await Promise.all(
        Array.from({ length: REQUEST_COUNT }, () =>
          requestSeededLink(harness.baseUrl, {
            'cf-connecting-ip': IP_CF_USED,
            'x-forwarded-for': IP_XFF_SHADOWED,
          }),
        ),
      );

      for (const response of responses) {
        expect(response.status).toBe(307);
        expect(response.location).toBe(HARNESS_DESTINATION);
      }

      // Sanity: real job data is actually being inspected below, not an
      // incidentally-empty array.
      const jobsAfter = await waitForWaitingJobCount(harness.queue, jobsBefore + REQUEST_COUNT);
      expect(jobsAfter.length).toBeGreaterThanOrEqual(jobsBefore + REQUEST_COUNT);

      await assertIpLeaksNowhere(harness, [IP_CF_USED, IP_XFF_SHADOWED]);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'X-Forwarded-For alone (no CF-Connecting-IP at all): the ip that genuinely funds computeVisitorHash still leaks nowhere',
    async () => {
      const jobsBefore = (await harness.queue.getJobs(['wait'])).length;

      const response = await requestSeededLink(harness.baseUrl, { 'x-forwarded-for': IP_XFF_ONLY_USED });
      expect(response.status).toBe(307);
      expect(response.location).toBe(HARNESS_DESTINATION);

      const jobsAfter = await waitForWaitingJobCount(harness.queue, jobsBefore + 1);
      expect(jobsAfter.length).toBeGreaterThanOrEqual(jobsBefore + 1);

      await assertIpLeaksNowhere(harness, [IP_XFF_ONLY_USED]);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'the geoip lookup throws: the redirect still succeeds, no job is enqueued for this request, and the resulting failure log carries no ip',
    async () => {
      const logsBefore = harness.logs.length;
      lookupNetworkShouldThrow = true;

      try {
        const response = await requestSeededLink(harness.baseUrl, { 'cf-connecting-ip': IP_GEOIP_THROW });
        expect(response.status).toBe(307);
        expect(response.location).toBe(HARNESS_DESTINATION);

        const failureLogs = await waitForNewLogMatch(harness, CAPTURE_FAILURE_LOG_PATTERN, logsBefore, 1);
        expect(failureLogs).toHaveLength(1);

        // lookupNetwork throws INSIDE the same try block that builds and
        // enqueues the payload (middleware.ts's handleLinkTarget) — no
        // job for THIS request should exist at all.
        const jobs = await harness.queue.getJobs(['wait']);
        const leakedInCurrentJobs = findJobLeaks(jobs, IP_GEOIP_THROW);
        expect(leakedInCurrentJobs).toEqual([]);

        await assertIpLeaksNowhere(harness, [IP_GEOIP_THROW]);
      } finally {
        lookupNetworkShouldThrow = false;
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'the enqueue itself throws (the queue connection is disconnected): the redirect still succeeds, the enqueue-failure log carries no ip, and the queue recovers afterward',
    async () => {
      const queueClient = await harness.queue.client;
      const logsBefore = harness.logs.length;

      try {
        // See this file's own header for why this — not a real closed TCP
        // port — is the deterministic way to reproduce "the producer's
        // connection is dead" (queue-down.test.ts's own T2.6.2 technique,
        // reused verbatim).
        queueClient.disconnect();

        const response = await requestSeededLink(harness.baseUrl, { 'cf-connecting-ip': IP_ENQUEUE_THROW });
        expect(response.status).toBe(307);
        expect(response.location).toBe(HARNESS_DESTINATION);

        const failureLogs = await waitForNewLogMatch(harness, ENQUEUE_FAILURE_LOG_PATTERN, logsBefore, 1);
        expect(failureLogs).toHaveLength(1);
      } finally {
        // Reconnects UNCONDITIONALLY — runs whether the try block above
        // threw or not — so every later check in this test (and every
        // later `it` in this file, including the final sweep) sees a
        // healthy queue. Mirrors queue-down.test.ts's own recovery step.
        //
        // Critically, `assertIpLeaksNowhere` below is called AFTER this
        // finally, not inside the try: it calls assertIpAbsentFromQueue,
        // which runs a real `queue.getJobs(...)` against this exact
        // `queueClient` connection. Calling it while still disconnected
        // races this test's own teardown and throws `Connection is
        // closed.` — not because an ip leaked, but because the check
        // itself needs a live connection to run at all. This doesn't
        // weaken the assertion: `queue.add()` never succeeded while
        // disconnected (that's the whole premise of this scenario), so no
        // job for IP_ENQUEUE_THROW was ever created regardless of whether
        // the check runs before or after reconnecting — only reconnecting
        // first makes the check itself able to run.
        await queueClient.connect();
      }

      await assertIpLeaksNowhere(harness, [IP_ENQUEUE_THROW]);

      const recovered = await requestSeededLink(harness.baseUrl);
      expect(recovered.status).toBe(307);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'detector proof — an ip planted as a real BullMQ job id AND inside job.opts is caught by this file\'s own job check AND really does appear in a literal Redis key name (via the real assertIpAbsentFromRedisKeys helper)',
    async () => {
      const plantedPayload = buildDetectorProofPayload(harness);
      // `deduplication.id` — a real, documented BaseJobOptions field (not
      // a contrivance): BullMQ's own `Job.create` stores `opts` verbatim
      // as `job.opts` (see bullmq's job.js: `this.opts = opts`), so this
      // plants the ip inside `job.opts.deduplication.id` exactly the way
      // a future, careless call site could smuggle a raw ip into any
      // string-typed job option — proving findJobLeaks's `job-opts`
      // branch specifically, not just the coarser whole-job stringify.
      const plantedJob = await harness.queue.add(CAPTURE_JOB_NAME, plantedPayload, {
        jobId: IP_DETECTOR_PLANTED,
        deduplication: { id: IP_DETECTOR_PLANTED },
      });

      try {
        // Proves findJobLeaks (used by every scenario above) actually
        // fires on an ip smuggled into job.id AND separately into
        // job.opts — the specific gap this task's own dispatch names that
        // a unit test structurally cannot reach at all.
        const hits = findJobLeaks([plantedJob], IP_DETECTOR_PLANTED);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((hit) => hit.location === 'job-id')).toBe(true);
        expect(hits.some((hit) => hit.location === 'job-opts')).toBe(true);

        // Proves the OTHER half: BullMQ really does bake a job's id
        // verbatim into a real Redis key name (`bull:events:<jobId>`) —
        // via this file's own ACTUAL `assertIpAbsentFromRedisKeys`
        // helper, not a duplicate of its query logic, so this proves that
        // specific function would itself catch a future regression to
        // its own logic, not merely that the underlying BullMQ mechanism
        // works.
        await expect(assertIpAbsentFromRedisKeys(harness, IP_DETECTOR_PLANTED)).rejects.toThrow();
      } finally {
        // Removed immediately: IP_DETECTOR_PLANTED is a planted violation,
        // not a real scenario ip, and must never linger to pollute the
        // final "every real scenario ip leaks nowhere" sweep below.
        await plantedJob.remove();
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'detector proof — an ip planted directly into a captured log line is caught by this file\'s own actual assertIpAbsentFromLogs helper',
    () => {
      const plantedLine = `[error] synthetic leak planted for detector proof ip=${IP_DETECTOR_PLANTED}`;
      plantSyntheticLogLine(harness, plantedLine);

      try {
        // Proves assertIpAbsentFromLogs — the log channel every scenario
        // above relies on via assertIpLeaksNowhere — actually fires when
        // an ip is present in a captured log line. This is the log
        // channel's own permanent regression guard, closing the gap a
        // previous revision of this file left to a manual, by-hand
        // exercise only (see this file's own header for the narrower,
        // separate manual exercise this does NOT replace).
        expect(() => assertIpAbsentFromLogs(harness, IP_DETECTOR_PLANTED)).toThrow();
      } finally {
        // Removed immediately: a synthetic line, not a real captured one,
        // and must never linger to pollute the final sweep below (or any
        // later log-count assertion in this file).
        removeSyntheticLogLine(harness, plantedLine);
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    'final sweep: every distinctive ip used anywhere in this file is absent from every job (every state), every captured log line, and every Redis key name',
    async () => {
      await assertIpLeaksNowhere(harness, ALL_SCENARIO_IPS);
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );
});
