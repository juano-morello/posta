import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import type { CaptureEvent } from '@posta/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCapturePayload,
  computeVisitorHash,
  readClientIp,
  readSignals,
  type CapturePayloadInput,
  type CaptureRequest,
  type ClientIp,
  type VisitorHash,
} from './capture';
import { captureAllOutputChannels, createRecordingLogger, type RecordedLogCall } from './output-channel-test-support';

// T2.3.8 [INV-6][security] — adversarial coverage for the IP-discard
// boundary T2.3.7 built. This is NOT a restatement of capture.test.ts's
// own tests (which already prove readClientIp/computeVisitorHash/
// buildCapturePayload behave correctly on their happy paths). The gap
// this file closes is named explicitly in the dispatch: "Error handlers
// are the specific gap this closes — the usual way an IP leaks is a
// `catch` that logs the whole request."
//
// `apps/api/src/redirect/capture.ts` has NO try/catch and NO logger
// today — confirmed below by findRequestLoggingCatchBlocks against the
// real file, not assumed. The composition site that WOULD catch a thrown
// geoip/salt/payload-build failure is T2.4.3 (middleware wiring), not yet
// built. So this file builds a small, test-LOCAL fixture — a
// `runCapturePipeline(req, deps)` function with an injectable error
// handler — standing in for what T2.4.3 will eventually assemble. It is
// deliberately not real production code (constraint: no production code
// changes this task).
//
// Two properties, both required by the dispatch:
//   1. When a dependency throws, the distinctive IP escapes nowhere: not
//      a thrown error's message/stack, not any console/stdout/stderr
//      output, not an injected logger's own call log, not a built
//      payload's serialised form.
//   2. The absence of a request-logging catch is VERIFIED, not assumed —
//      a static scan of the real capture.ts (and middleware.ts) source,
//      proven to actually detect the bug pattern via a planted-violation
//      test, mirroring tests/conventions/no-literal-domain.test.ts's own
//      "plant it, assert the detector finds it" shape.
//
// Every test below that claims "no leak" is paired with, or covered by,
// a "detector proof" test that plants the leaky bug pattern
// (`log.error({ req })`, verbatim from the dispatch) and asserts the SAME
// detection method (grep the captured output for the IP) DOES fire. The
// dispatch's required negative proof — "the test must fail when a
// fixture handler is patched to log.error({ req })" — is demonstrated by
// hand in this task's report (patch the SAFE-handler tests' default
// handler to the leaky one, observe them go red, revert) rather than
// committed as a permanently-failing test; the detector-proof tests below
// are the PERMANENT, always-green regression guard that the detection
// method itself still works.

const DISTINCTIVE_IP = '203.0.113.77'; // RFC 5737 TEST-NET-3 — never a real host.
// String.fromCharCode(0), not a '\u0000' literal in this file's own source: some editing
// paths write that escape sequence as a raw control byte on disk instead of the six-character
// escape (capture.test.ts hit this; documented in its own header). Constructing it at runtime
// avoids the risk entirely.
const NUL = String.fromCharCode(0);
const HOST = 'juano.example.test';

// ── Fixture: a stand-in for the future capture-composition site ──────────

/** Mirrors GeoLookupLogger/DailySaltLogger/RedirectMiddlewareLogger
 * (packages/core/src/geoip/lookup.ts, packages/core/src/redis/salt.ts,
 * apps/api/src/redirect/middleware.ts) — the one logger shape this
 * codebase actually has anywhere (no pino instance is wired up yet). */
interface CapturePipelineLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

interface NetworkLookupResult {
  readonly asn: number | null;
  readonly country: string | null;
}

type LookupNetworkFn = (ip: ClientIp | null, cfCountry: string | null) => NetworkLookupResult;
type GetDailySaltFn = () => Promise<string>;
type ComputeVisitorHashFn = (ip: ClientIp, userAgent: string | null, salt: string) => VisitorHash;
type BuildCapturePayloadFn = (input: CapturePayloadInput) => CaptureEvent;

interface CaptureFailureContext {
  readonly req: CaptureRequest;
}
type CaptureErrorHandler = (error: unknown, context: CaptureFailureContext) => void;

interface CapturePipelineDeps {
  readonly lookupNetwork: LookupNetworkFn;
  readonly getDailySalt: GetDailySaltFn;
  readonly computeVisitorHash: ComputeVisitorHashFn;
  readonly buildCapturePayload: BuildCapturePayloadFn;
  readonly onError: CaptureErrorHandler;
}

/**
 * The pipeline every test below drives: readClientIp -> readSignals ->
 * lookupNetwork -> getDailySalt -> computeVisitorHash -> buildCapturePayload,
 * wrapped in one try/catch that calls `deps.onError(error, { req })` and
 * returns `null` — mirroring invariant 1 (a capture failure must never
 * propagate and cost the redirect). Never rejects: every failure path is
 * caught internally, same discipline getDailySalt's own
 * fetchOrGenerateSalt uses (packages/core/src/redis/salt.ts).
 */
async function runCapturePipeline(
  req: CaptureRequest,
  deps: CapturePipelineDeps,
): Promise<CaptureEvent | null> {
  try {
    const ip = readClientIp(req.headers);
    const signals = readSignals(req);
    const cfCountryHeader = req.headers['cf-ipcountry'];
    const cfCountry = typeof cfCountryHeader === 'string' ? cfCountryHeader : null;

    const { asn, country } = deps.lookupNetwork(ip, cfCountry);
    const salt = await deps.getDailySalt();
    const visitorHash = ip ? deps.computeVisitorHash(ip, signals.user_agent, salt) : null;

    return deps.buildCapturePayload({
      tenantId: 'tenant-1',
      linkId: 'link-1',
      slug: 'promo',
      signals,
      visitorHash,
      asn,
      country,
    });
  } catch (error) {
    deps.onError(error, { req });
    return null;
  }
}

function buildRequest(headerOverrides: IncomingHttpHeaders = {}): CaptureRequest {
  return {
    method: 'GET',
    headers: {
      host: HOST,
      'cf-connecting-ip': DISTINCTIVE_IP,
      'user-agent': 'Mozilla/5.0 (capture-privacy-test)',
      ...headerOverrides,
    },
  };
}

const WORKING_SALT = 'deterministic-test-salt-value-not-a-real-secret';

const workingLookupNetwork: LookupNetworkFn = () => ({ asn: 15169, country: 'AR' });
const workingGetDailySalt: GetDailySaltFn = () => Promise.resolve(WORKING_SALT);

/** The SAFE handler — what T2.4.3 SHOULD build: logs only the error's
 * constructor name, stashes the raw error for direct inspection (never
 * logged, never re-thrown), never touches `context.req`. */
function createSafeErrorHandler(
  logger: CapturePipelineLogger,
  capturedErrors: unknown[],
): CaptureErrorHandler {
  return (error) => {
    capturedErrors.push(error);
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    logger.error('Capture failed; redirect proceeds without analytics for this request', {
      errorType,
    });
  };
}

/** The LEAKY handler — the exact bug pattern named in the dispatch:
 * `catch (e) { log.error({ req, e }) }`. `context.req.headers` carries
 * `cf-connecting-ip`/`x-forwarded-for` verbatim, so logging the whole
 * request object leaks the visitor's IP straight into whatever this
 * logger writes to. */
function createLeakyErrorHandler(logger: CapturePipelineLogger): CaptureErrorHandler {
  return (_error, context) => {
    logger.error('Capture failed', { req: context.req });
  };
}

function safeDeps(logger: CapturePipelineLogger, capturedErrors: unknown[]): CapturePipelineDeps {
  return {
    lookupNetwork: workingLookupNetwork,
    getDailySalt: workingGetDailySalt,
    computeVisitorHash,
    buildCapturePayload,
    onError: createSafeErrorHandler(logger, capturedErrors),
  };
}

// Deliberately generic, non-request-shaped messages — mirrors how the
// REAL geoip/salt code already behaves (logLookupFailure /
// fetchOrGenerateSalt log only an error TYPE, never a message or the
// input that caused it). These stubs stand in for "a dependency threw",
// not for "a dependency threw an IP-laced message" — the interesting
// question this file asks is whether the SURROUNDING handler leaks via
// `req`, not whether these fixtures were written carelessly.
const STUB_FAILURE_SUFFIX = 'stub: forced failure for capture-privacy.test.ts';

const throwingLookupNetwork: LookupNetworkFn = () => {
  throw new Error(`lookupNetwork ${STUB_FAILURE_SUFFIX}`);
};
const throwingGetDailySalt: GetDailySaltFn = () =>
  Promise.reject(new Error(`getDailySalt ${STUB_FAILURE_SUFFIX}`));
const throwingComputeVisitorHash: ComputeVisitorHashFn = () => {
  throw new Error(`computeVisitorHash ${STUB_FAILURE_SUFFIX}`);
};
const throwingBuildCapturePayload: BuildCapturePayloadFn = () => {
  throw new Error(`buildCapturePayload ${STUB_FAILURE_SUFFIX}`);
};

interface ThrowScenario {
  readonly name: string;
  readonly deps: Partial<CapturePipelineDeps>;
}

// The dispatch names three ("a geoip lookup that throws, a salt fetch
// that throws, and a payload-build that throws") and separately says to
// drive "computeVisitorHash, lookupNetwork and buildCapturePayload" with
// throwing stubs. The two lists only partially overlap (getDailySalt vs.
// computeVisitorHash) — covering the union of both is more thorough, not
// scope creep: every scenario below exercises the SAME property (a
// dependency of the capture pipeline throwing must never leak the IP).
const THROW_SCENARIOS: ThrowScenario[] = [
  { name: 'geoip lookup (lookupNetwork) throws', deps: { lookupNetwork: throwingLookupNetwork } },
  { name: 'daily salt fetch (getDailySalt) throws', deps: { getDailySalt: throwingGetDailySalt } },
  {
    name: 'visitor hash computation (computeVisitorHash) throws',
    deps: { computeVisitorHash: throwingComputeVisitorHash },
  },
  {
    name: 'payload assembly (buildCapturePayload) throws',
    deps: { buildCapturePayload: throwingBuildCapturePayload },
  },
];

// ── Output-channel capture ────────────────────────────────────────────
//
// [S2.4 fan-out fix round] captureAllOutputChannels/createRecordingLogger
// and their supporting types used to be defined here AND, independently,
// in enqueue-logging.test.ts — ~77 duplicated lines that a story-level
// review found had already drifted apart (stringifyLoggable's Error
// handling differed between the two copies). Both moved to
// output-channel-test-support.ts; see that file's own header for the full
// reasoning. `createRecordingLogger`'s return type there
// (`RecordingLoggerLike`) is structurally identical to this file's own
// `CapturePipelineLogger` below, so it satisfies every call site here
// with no cast needed.

// ── IP-leak assertions ────────────────────────────────────────────────

interface IpEncoding {
  readonly label: string;
  readonly value: string;
}

/**
 * The distinctive IP in every form considered that could still identify
 * the visitor in captured output:
 *   - raw octet string
 *   - hex-encoded bytes (a stray `buf.toString('hex')` debug dump)
 *   - base64-encoded bytes (same idea, a different encoding)
 *   - URL-encoded — checked, but `encodeURIComponent('203.0.113.77')` is
 *     BYTE-IDENTICAL to the raw string (digits and '.' are never
 *     percent-escaped), so it collapses into the 'raw' check and is only
 *     added here as a distinct entry when it actually differs. Recorded
 *     so a future reader knows this was considered, not skipped.
 *
 * Deliberately NOT covered: numeric/integer IP encodings (e.g. IPv4 as a
 * uint32) or arbitrary further transforms (rot13, gzip, ...) — nothing in
 * this codebase ever converts an IP that way, and chasing every possible
 * encoding has no natural stopping point. Pragmatic, not exhaustive.
 */
function ipEncodings(ip: string): IpEncoding[] {
  const urlEncoded = encodeURIComponent(ip);
  const encodings: IpEncoding[] = [
    { label: 'raw', value: ip },
    { label: 'hex', value: Buffer.from(ip, 'utf8').toString('hex') },
    { label: 'base64', value: Buffer.from(ip, 'utf8').toString('base64') },
  ];
  if (urlEncoded !== ip) encodings.push({ label: 'url-encoded', value: urlEncoded });
  return encodings;
}

function leakedEncodings(output: string, ip: string): IpEncoding[] {
  return ipEncodings(ip).filter(({ value }) => output.includes(value));
}

/** Asserts NONE of the IP's known encodings appear in `output`. An empty
 * array on failure names exactly which encoding(s) leaked. */
function assertNoIpLeak(output: string, ip: string = DISTINCTIVE_IP): void {
  expect(leakedEncodings(output, ip)).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Happy path ─────────────────────────────────────────────────────────

describe('capture-privacy — happy path (no throw)', () => {
  it('builds a payload with no distinctive IP anywhere, no suspicious runtime key, and logs nothing at all', async () => {
    const calls: RecordedLogCall[] = [];
    const capturedErrors: unknown[] = [];
    const logger = createRecordingLogger(calls);
    const channels = captureAllOutputChannels();
    const req = buildRequest();

    let payload: CaptureEvent | null;
    try {
      payload = await runCapturePipeline(req, safeDeps(logger, capturedErrors));
    } finally {
      channels.restore();
    }

    expect(payload).not.toBeNull();
    expect(capturedErrors).toEqual([]);
    // Nothing should log at all on a clean run — the strongest form of
    // "no leak" for the success path.
    expect(channels.getOutput()).toBe('');
    expect(calls).toEqual([]);

    const serialized = JSON.stringify(payload);
    assertNoIpLeak(serialized);

    const suspiciousKeys = Object.keys(payload as CaptureEvent).filter((key) =>
      /ip|addr|forwarded|cookie/i.test(key),
    );
    expect(suspiciousKeys).toEqual([]);
  });
});

// ── Adversarial: each dependency throws, SAFE handler — nothing leaks ──

describe.each(THROW_SCENARIOS)('capture-privacy — $name, SAFE handler', (scenario) => {
  it('leaks the distinctive IP nowhere: not the thrown error, not any output channel, not the logger', async () => {
    const calls: RecordedLogCall[] = [];
    const capturedErrors: unknown[] = [];
    const logger = createRecordingLogger(calls);
    const channels = captureAllOutputChannels();
    const req = buildRequest();

    let result: CaptureEvent | null;
    try {
      result = await runCapturePipeline(req, {
        ...safeDeps(logger, capturedErrors),
        ...scenario.deps,
      });
    } finally {
      channels.restore();
    }

    // The pipeline caught the throw and degraded to "no capture" —
    // mirroring invariant 1's shape (a redirect never blocks on
    // analytics; here, a capture failure never blocks the redirect
    // either, and never surfaces a thrown error to its caller).
    expect(result).toBeNull();
    expect(capturedErrors).toHaveLength(1);

    // Property 1a: the thrown error's own message/stack carry no IP.
    const [error] = capturedErrors;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    assertNoIpLeak(message);
    assertNoIpLeak(stack);

    // Property 1b: nothing observable — console/stdout/stderr, or the
    // logger's own call log — carries the IP either.
    assertNoIpLeak(channels.getOutput());
    assertNoIpLeak(JSON.stringify(calls));
  });
});

// ── Adversarial: a REAL throw, not a stub ───────────────────────────────

describe('capture-privacy — a REAL throw (not a stub): computeVisitorHash rejects a poisoned ip', () => {
  // computeVisitorHash's own assertNoHashDelimiter (capture.ts) throws
  // when its ip/userAgent/salt inputs contain the internal NUL delimiter
  // — a genuine, documented production throw path (T2.3.7), unlike the
  // stubs above. Poisoning the ip header directly (bypassing the real
  // HTTP layer, which would reject a literal NUL in a header before any
  // handler runs — see capture.ts's own comment) is how capture.test.ts
  // itself drives this path; reused here to prove the SAME property
  // through the full adversarial pipeline + injectable handler, not just
  // in isolation.
  const poisonedIp = `${DISTINCTIVE_IP}${NUL}evil-appended-fragment`;

  it('the thrown message and every output channel carry no distinctive IP, under the SAFE handler', async () => {
    const calls: RecordedLogCall[] = [];
    const capturedErrors: unknown[] = [];
    const logger = createRecordingLogger(calls);
    const channels = captureAllOutputChannels();
    const req = buildRequest({ 'cf-connecting-ip': poisonedIp });

    let result: CaptureEvent | null;
    try {
      result = await runCapturePipeline(req, safeDeps(logger, capturedErrors));
    } finally {
      channels.restore();
    }

    expect(result).toBeNull();
    expect(capturedErrors).toHaveLength(1);

    const [error] = capturedErrors;
    const message = error instanceof Error ? error.message : String(error);
    assertNoIpLeak(message);
    assertNoIpLeak(channels.getOutput());
    assertNoIpLeak(JSON.stringify(calls));
  });
});

// ── Detector proof: the LEAKY handler DOES leak ─────────────────────────
//
// Permanent, always-green regression guard — mirrors
// tests/conventions/no-literal-domain.test.ts's "detects a planted
// violation" shape. This is NOT the "this build is broken" kind of test:
// it plants the exact bug pattern the dispatch names
// (`catch (e) { log.error({ req }) }`) inside a throwaway handler and
// asserts the SAME detection method used above (grep captured output for
// the IP) fires positive. If this ever started passing with an EMPTY
// `leakedEncodings` result, it would mean the fixture's leaky handler
// stopped leaking — i.e. that the detection method itself had gone blind
// — which is exactly the failure mode a leak-detection test suite must
// never have silently.

describe.each(THROW_SCENARIOS)(
  'capture-privacy detector proof — $name, LEAKY handler (log.error({ req }))',
  (scenario) => {
    it('the distinctive IP appears in captured output — proving the leak-detection method above would have failed here', async () => {
      const calls: RecordedLogCall[] = [];
      const capturedErrors: unknown[] = [];
      const logger = createRecordingLogger(calls);
      const channels = captureAllOutputChannels();
      const req = buildRequest();

      try {
        await runCapturePipeline(req, {
          ...safeDeps(logger, capturedErrors),
          ...scenario.deps,
          onError: createLeakyErrorHandler(logger),
        });
      } finally {
        channels.restore();
      }

      const observedOutput = `${channels.getOutput()}\n${JSON.stringify(calls)}`;
      expect(leakedEncodings(observedOutput, DISTINCTIVE_IP).length).toBeGreaterThan(0);
    });
  },
);

describe('capture-privacy detector proof — REAL throw + LEAKY handler', () => {
  it('the poisoned header value (which contains the distinctive IP) leaks into captured output', async () => {
    const poisonedIp = `${DISTINCTIVE_IP}${NUL}evil-appended-fragment`;
    const calls: RecordedLogCall[] = [];
    const capturedErrors: unknown[] = [];
    const logger = createRecordingLogger(calls);
    const channels = captureAllOutputChannels();
    const req = buildRequest({ 'cf-connecting-ip': poisonedIp });

    try {
      await runCapturePipeline(req, {
        ...safeDeps(logger, capturedErrors),
        onError: createLeakyErrorHandler(logger),
      });
    } finally {
      channels.restore();
    }

    const observedOutput = `${channels.getOutput()}\n${JSON.stringify(calls)}`;
    expect(leakedEncodings(observedOutput, DISTINCTIVE_IP).length).toBeGreaterThan(0);
  });
});

// ── Static scan: "no request-logging catch" verified, not assumed ──────

interface CatchBlockHit {
  readonly line: number;
  readonly snippet: string;
}

function findMatchingBraceIndex(source: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/**
 * A pragmatic, non-AST scan for the specific bug pattern this task
 * exists to catch — `catch (...) { ... req ... }` — NOT a full parser
 * (this repo's own tests/conventions/no-literal-domain.test.ts takes the
 * same pragmatic text-scanning approach for its own guard, rather than
 * pulling in a parser dependency neither test file otherwise needs).
 *
 * `(?<!\.)\bcatch\b` excludes `promise.catch(fn)` — a negative lookbehind
 * for a preceding `.`, since a real `catch` KEYWORD is never preceded by
 * a dot the way a Promise method call always is. The parens around a
 * caught error are optional (`catch { ... }` is valid since ES2019).
 * Brace-depth matching (not a regex) finds the block's real end, so a
 * nested object literal or a nested try/catch inside the block doesn't
 * truncate the scan early.
 *
 * A hit requires the catch body to mention `req` as a whole word — this
 * is deliberately loose (it would also flag a catch block that merely
 * MENTIONS `req` in a comment, or a variable named exactly `req` used
 * safely) rather than tight: a scanner for this specific, high-cost bug
 * class should err toward a false positive a human reviews, never toward
 * a false negative that ships a leak.
 */
function findRequestLoggingCatchBlocks(source: string): CatchBlockHit[] {
  const hits: CatchBlockHit[] = [];
  const catchPattern = /(?<!\.)\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = catchPattern.exec(source)) !== null) {
    const openBraceIndex = match.index + match[0].length - 1;
    const closeBraceIndex = findMatchingBraceIndex(source, openBraceIndex);
    const body = source.slice(openBraceIndex + 1, closeBraceIndex);

    if (/\breq\b/.test(body)) {
      const line = source.slice(0, match.index).split('\n').length;
      hits.push({ line, snippet: body.trim().slice(0, 160) });
    }
  }

  return hits;
}

// The redirect-hot-path files that exist TODAY. T2.4.3 (middleware
// wiring — the actual composition site that will call capture) is not
// built yet; once it lands, its file must be added to this list, or this
// guard silently stops covering the place the real bug would appear.
const REDIRECT_HOT_PATH_FILES = [
  path.join('apps', 'api', 'src', 'redirect', 'capture.ts'),
  path.join('apps', 'api', 'src', 'redirect', 'middleware.ts'),
] as const;

describe('static scan — no request-logging catch block on the redirect hot path today', () => {
  it.each(REDIRECT_HOT_PATH_FILES)('%s has zero catch-blocks-that-mention-req today', (relativePath) => {
    const source = readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    expect(findRequestLoggingCatchBlocks(source)).toEqual([]);
  });

  it('detects a planted catch block that logs { req } — proving the scanner actually works (mirrors no-literal-domain.test.ts)', () => {
    const plantedSource = `
      async function futureComposition(req) {
        try {
          await doCapture(req);
        } catch (e) {
          logger.error('capture failed', { req, e });
        }
      }
    `;

    const hits = findRequestLoggingCatchBlocks(plantedSource);

    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not false-positive on an unrelated catch block that never mentions req', () => {
    const cleanSource = `
      try {
        doSomething();
      } catch (error) {
        logger.error('failed', { errorType: error.constructor.name });
      }
    `;

    expect(findRequestLoggingCatchBlocks(cleanSource)).toEqual([]);
  });

  it('does not false-positive on a Promise .catch(...) call, even one whose callback mentions req', () => {
    // The negative lookbehind (?<!\.) is what distinguishes this from a
    // real catch clause — without it, `.catch(callback => { ... req ... })`
    // would be indistinguishable from `catch (e) { ... req ... }` to a
    // naive regex.
    const promiseCatchSource = `
      bootstrap(req).catch((error) => {
        console.error('fatal', { req, error });
      });
    `;

    expect(findRequestLoggingCatchBlocks(promiseCatchSource)).toEqual([]);
  });

  it('handles the parameterless catch form (catch { ... }, valid since ES2019)', () => {
    const parameterlessSource = `
      try {
        doSomething(req);
      } catch {
        logger.error('failed', { req });
      }
    `;

    expect(findRequestLoggingCatchBlocks(parameterlessSource).length).toBeGreaterThan(0);
  });
});
