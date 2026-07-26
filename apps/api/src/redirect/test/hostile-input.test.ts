import http from 'node:http';
import net from 'node:net';
import { SLUG_MAX_LENGTH } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escapeHtml } from '../escape-html';
import { CONTAINER_TEST_TIMEOUT_MS } from '../resolve-test-support';
import {
  HARNESS_DOMAIN,
  HARNESS_HANDLE,
  HARNESS_SLUG,
  startHotPathHarness,
  type HotPathHarness,
} from './hot-path-harness';

// T2.6.8 [security] — "one table, one job": every hostile input the brief
// names must answer 4xx, never 5xx, never throw, and never reflect its own
// raw bytes unescaped in a response body. escape-html.test.ts (T2.5.1)
// already proves the escaper is correct in isolation, and not-found-xss.test.ts
// (T2.5.4) already proves the SAME guarantee end to end through a real
// Express+http round trip — but both of those run against a lightweight,
// stubbed server (no containers, resolveTenant/resolveLink are plain
// closures). This file proves the identical guarantee through the REAL
// production composition (T2.6.1's startHotPathHarness: real Postgres, real
// Redis, the real cache/tombstone ladders) — the only place a regression in
// how those real tiers hand a value back to the middleware could ever show
// up. Reuses the harness rather than rebuilding a stack (this file's own
// dispatch is explicit about that).
//
// Two mechanisms send input a well-behaved HTTP client refuses to construct:
//   - `sendViaClient` (Node's own `http.request`) for every case that is
//     hostile at the SEMANTIC level (a bad slug, a bad handle, a port
//     suffix) but perfectly well-formed as HTTP bytes.
//   - `sendRaw` (a bare `net.Socket`) for every case that is hostile at the
//     WIRE level itself: two `Host` header lines, no `Host` header at all, a
//     literal null byte in the request-target, and a genuinely empty
//     request-target. `http.request` either refuses these synchronously
//     (a raw null byte: "Request path contains unescaped characters") or
//     silently normalizes them into something else entirely (an empty
//     `path` option is sent as `/`, and `options.headers.host` must be a
//     `string`, not an array) — bypassing it is the only way to prove what
//     the SERVER does with the malformed bytes, not what the client
//     tolerates constructing. Verified by hand before writing this table
//     (see this file's own PR notes): a genuinely empty target and a
//     missing `Host` header are both rejected by Node's OWN HTTP parser
//     with a bare 400 before Express, this application's middleware, or
//     `host.ts` ever run — proving the hot path is safe here means proving
//     the SERVER holds, not merely that curl would have refused to send it.
//
// [proof case, beyond the brief's literal 11] One row —
// "a malformed percent-encoding" (`%zz`) — is not one of the eleven cases
// the brief names verbatim. It is added because this task's own dispatch
// requires demonstrating the RED state directly: removing extractSlug's
// `try/catch` around `decodeURIComponent` (host.ts) turns exactly this
// input into an uncaught `URIError` — a real 500, not a 404. None of the
// eleven named cases exercises that throw (`%2e%2e%2f` is a WELL-FORMED
// escape; it decodes cleanly to `../`), so proving the guard's failure mode
// needs this one additional, deliberately malformed row. See this task's
// own report for the RED output.

const PORT_SUFFIX_UNKNOWN_SLUG = 'hostile-input-nonexistent-slug';
const UNREGISTERED_PUNYCODE_HANDLE = 'xn--unregistered-punycode';
// RFC 2606 §2 reserves `.invalid` for exactly this: a domain guaranteed to
// never resolve to anything real. Not one of the two domains
// tests/conventions/no-literal-domain.test.ts forbids (posta.lat,
// lbt.works) — see that file for the exact allowlist.
const FOREIGN_HOST = 'attacker.invalid';
const XSS_PAYLOAD = '<script>alert(1)</script>';
const TRAVERSAL_PATH = '../../etc/passwd';
const ENCODED_TRAVERSAL = '%2e%2e%2f';
const MALFORMED_PERCENT_ENCODING = '%zz';
// Comfortably larger than MAX_ENCODED_SLUG_LENGTH (SLUG_MAX_LENGTH * 3 =
// 192, host.ts) — the point is proving oversized input is rejected BEFORE
// any decode is attempted, not that it happens to become a valid slug.
const FOUR_KB_SLUG = 'a'.repeat(4096);

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/** A well-formed HTTP request via Node's own `http.request` — every case in
 * this file's table that is hostile at the semantic level only. Mirrors
 * every other T2.6.x test file's own small, file-local request helper
 * (hot-path-harness.test.ts's `requestSeededLink`, reserved.test.ts's
 * `requestHost`) rather than centralizing this in the harness itself. */
function sendViaClient(port: number, host: string, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Writes `requestText` byte-for-byte onto a raw `net.Socket`, bypassing
 * Node's http client (and its own request-target/header validation)
 * entirely — mirrors not-found-xss.test.ts's own `sendRawRequestLine`,
 * widened to also capture the BODY (that file only ever needed a status
 * code; every case here also needs the body, to prove no raw payload
 * survives unescaped even when Node's own parser answers before the app
 * ever runs). `Connection: close` is on every caller's own request text,
 * so the server closes the socket once its one response is fully sent,
 * which is what makes `'end'` a reliable signal that the whole response —
 * not merely its first chunk — has arrived. */
function sendRaw(port: number, requestText: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(requestText, 'binary');
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('binary');
      const statusMatch = /^HTTP\/1\.\d (\d{3})/.exec(raw);
      const headerEnd = raw.indexOf('\r\n\r\n');
      resolve({
        status: statusMatch?.[1] ? Number(statusMatch[1]) : 0,
        body: headerEnd === -1 ? '' : raw.slice(headerEnd + 4),
      });
    });
    socket.on('error', reject);
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error(`socket timed out waiting for a response to: ${requestText}`));
    });
  });
}

interface HostileCase {
  readonly name: string;
  /** The exact status this case's own mechanism produces, verified by hand
   * against the real code path (see this file's own header and the task
   * report) — never a loose "4xx" guess. The shared assertion below still
   * re-checks the 400-or-404 acceptance bar independently of this field. */
  readonly expectedStatus: 400 | 404;
  send(port: number): Promise<RawResponse>;
  /** Raw substrings that must never appear verbatim anywhere in the
   * response body. Empty for a case whose mechanism never reaches an
   * app-level branch that reflects anything at all (rejected by Node's own
   * HTTP parser, or Express's generic not-ours fallback). */
  readonly forbiddenSubstrings: readonly string[];
  /** The EXACT escaped fragment renderNotFound must produce for this case,
   * or `null` when this case never reaches renderNotFound at all. Proves
   * the input was reflected SAFELY, not merely dropped — a case that
   * silently discarded its input would trivially "never reflect the raw
   * payload" too, which is the "looks thorough, cannot fail" shape this
   * epic's own review process has flagged before (see not-found-xss.test.ts's
   * identical convention, which this mirrors). */
  readonly expectedReflection: string | null;
}

const HOSTILE_CASES: readonly HostileCase[] = [
  {
    name: 'an XSS payload as the slug',
    expectedStatus: 404,
    // The embedded '/' in '</script>' makes this multi-segment before any
    // decode is attempted (host.ts's own extractSlug) — this can never
    // become the 'link' RequestTarget kind, only 'invalid-path', which
    // reflects the RAW req.path (middleware.ts's describeRequestedPath).
    send: (port) => sendViaClient(port, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, `/${XSS_PAYLOAD}`),
    forbiddenSubstrings: [XSS_PAYLOAD],
    expectedReflection: `cd /${escapeHtml(XSS_PAYLOAD)}`,
  },
  {
    name: '../../etc/passwd path traversal',
    expectedStatus: 404,
    send: (port) => sendViaClient(port, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, `/${TRAVERSAL_PATH}`),
    // 'root:' is the canary: this hot path has no filesystem read anywhere
    // on it, but if one were ever added by mistake, an actual traversal
    // read of /etc/passwd would surface its first line here.
    forbiddenSubstrings: ['root:', TRAVERSAL_PATH],
    expectedReflection: `cd /${escapeHtml(TRAVERSAL_PATH)}`,
  },
  {
    name: '%2e%2e%2f encoded traversal',
    expectedStatus: 404,
    // Well-formed percent-encoding: decodeURIComponent succeeds and yields
    // '../' — extractSlug's SECOND '/' check (post-decode) is what actually
    // rejects this, not a decode failure. See host.ts's own header comment.
    send: (port) => sendViaClient(port, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, `/${ENCODED_TRAVERSAL}`),
    forbiddenSubstrings: ['root:'],
    expectedReflection: `cd /${escapeHtml(ENCODED_TRAVERSAL)}`,
  },
  {
    name: 'a malformed percent-encoding (%zz) that must not crash decodeURIComponent',
    expectedStatus: 404,
    send: (port) => sendViaClient(port, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, `/${MALFORMED_PERCENT_ENCODING}`),
    forbiddenSubstrings: [],
    expectedReflection: `cd /${escapeHtml(MALFORMED_PERCENT_ENCODING)}`,
  },
  {
    name: 'a 4 KB slug',
    expectedStatus: 404,
    // Rejected by host.ts's MAX_ENCODED_SLUG_LENGTH check BEFORE decoding —
    // the point is a clean reject, not that 4096 'a's happen to decode.
    send: (port) => sendViaClient(port, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, `/${FOUR_KB_SLUG}`),
    // The full 4096-char slug must never survive into the body — escape-html.ts's
    // own MAX_INPUT_LENGTH (SLUG_MAX_LENGTH * 2) truncates it long before
    // that, which is what the negative check below actually proves.
    forbiddenSubstrings: [FOUR_KB_SLUG],
    expectedReflection: `cd /${escapeHtml(FOUR_KB_SLUG)}`,
  },
  {
    name: 'a null byte in the request-target (raw socket — no HTTP client can send this)',
    expectedStatus: 400,
    // Node's own HTTP parser rejects a literal null byte in the
    // request-target before Express, this application's middleware, or
    // host.ts ever run — verified by hand (see this file's own header).
    send: (port) =>
      sendRaw(
        port,
        `GET /${String.fromCharCode(0)}null-byte HTTP/1.1\r\nHost: ${HARNESS_HANDLE}.${HARNESS_DOMAIN}\r\nConnection: close\r\n\r\n`,
      ),
    forbiddenSubstrings: [String.fromCharCode(0)],
    expectedReflection: null,
  },
  {
    name: 'a missing Host header (raw socket — http.request always injects one)',
    expectedStatus: 400,
    // HTTP/1.1 requires exactly one Host header (RFC 7230 §5.4); Node's own
    // HTTP parser enforces this and answers 400 before the request ever
    // reaches Express or host.ts.
    send: (port) => sendRaw(port, `GET /${HARNESS_SLUG} HTTP/1.1\r\nConnection: close\r\n\r\n`),
    forbiddenSubstrings: [],
    expectedReflection: null,
  },
  {
    name: 'two Host headers (raw socket — the header object rejects an array Host value)',
    expectedStatus: 404,
    // Node's own parser does NOT reject a duplicate Host header at the
    // protocol level (verified by hand) — it hands the FIRST value to
    // req.headers.host and silently drops the rest. This is the load-bearing
    // security proof: the SECOND header names the REAL seeded handle+slug,
    // so if this middleware ever misused the wrong header, this exact case
    // would silently redirect (307) to HARNESS_DESTINATION instead of 404 —
    // a request-smuggling-shaped bug this row exists to catch.
    send: (port) =>
      sendRaw(
        port,
        `GET /${HARNESS_SLUG} HTTP/1.1\r\nHost: ${FOREIGN_HOST}\r\nHost: ${HARNESS_HANDLE}.${HARNESS_DOMAIN}\r\nConnection: close\r\n\r\n`,
      ),
    forbiddenSubstrings: [],
    expectedReflection: null,
  },
  {
    name: 'a Host header carrying a port, on an unregistered slug',
    expectedStatus: 404,
    // Host.ts's stripPort() correctly removes ':5555' and resolves the REAL
    // seeded handle — proving the port suffix does not confuse handle
    // parsing — but the requested slug does not exist, so this still 404s
    // via the ordinary link-miss branch (never the parser breaking).
    send: (port) =>
      sendViaClient(port, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}:5555`, `/${PORT_SUFFIX_UNKNOWN_SLUG}`),
    forbiddenSubstrings: [],
    expectedReflection: `cd /${escapeHtml(PORT_SUFFIX_UNKNOWN_SLUG)}`,
  },
  {
    name: 'an unregistered punycode handle',
    expectedStatus: 404,
    // A syntactically valid handle label (matches HANDLE_PATTERN just like
    // any other) that nobody has claimed — resolveTenant's real Postgres
    // lookup genuinely misses, proving parseHandleFromHost never throws on
    // an "xn--" prefix and the miss is handled the same as any other.
    send: (port) => sendViaClient(port, `${UNREGISTERED_PUNYCODE_HANDLE}.${HARNESS_DOMAIN}`, `/${HARNESS_SLUG}`),
    forbiddenSubstrings: [],
    expectedReflection: `cd /${escapeHtml(HARNESS_SLUG)}`,
  },
  {
    name: 'a genuinely empty request-target (raw socket — http.request normalizes "" to "/")',
    expectedStatus: 400,
    // A bare `GET  HTTP/1.1` (nothing between the method and the version)
    // is malformed at the grammar level — Node's own HTTP parser rejects it
    // before Express, this application's middleware, or host.ts ever run.
    // Confirmed by hand that http.request's own `path: ''` option is
    // silently normalized to '/' on the wire, which is NOT this case at
    // all — hence the raw socket.
    send: (port) => sendRaw(port, `GET  HTTP/1.1\r\nHost: ${HARNESS_HANDLE}.${HARNESS_DOMAIN}\r\nConnection: close\r\n\r\n`),
    forbiddenSubstrings: [],
    expectedReflection: null,
  },
  {
    name: 'a slug of only slashes',
    expectedStatus: 404,
    // host.ts's own ONLY_SLASHES guard, checked ahead of isReservedPath —
    // see that file's own header for why '//' must not fold into '/'.
    send: (port) => sendViaClient(port, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, '//'),
    forbiddenSubstrings: [],
    // describeRequestedPath('//') strips only the ONE leading slash,
    // leaving '/' — which escapeHtml (the '/' entity) still escapes.
    expectedReflection: `cd /${escapeHtml('/')}`,
  },
];

describe('hostile input suite for the hot path (T2.6.8)', () => {
  let harness: HotPathHarness;
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeAll(async () => {
    // Attached BEFORE the harness boots and never detached until every
    // case in this file has run — the whole point is a process-wide net
    // catching a rejection from ANY of the twelve requests below, not just
    // the one the assertion happens to be looking at.
    process.on('unhandledRejection', onUnhandledRejection);
    harness = await startHotPathHarness();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandledRejection);
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it.each(HOSTILE_CASES)('$name', async (testCase) => {
    const response = await testCase.send(harness.port);

    // The acceptance bar, independent of this row's own specific expected
    // value: 4xx, never 5xx.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.status).toBe(testCase.expectedStatus);

    for (const forbidden of testCase.forbiddenSubstrings) {
      expect(response.body).not.toContain(forbidden);
    }

    if (testCase.expectedReflection !== null) {
      expect(response.body).toContain(testCase.expectedReflection);
    }
  });

  // A fixed grace period, mirroring not-found-xss.test.ts's own identical
  // wait: gives any straggling fire-and-forget continuation from the two
  // cases above that DO reach the real 'link' branch (the port-suffix and
  // punycode-handle cases) a moment it would need to surface a rejection
  // before this file's own final assertion checks for one.
  it('produced zero unhandled rejections across all twelve cases above', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandledRejections).toEqual([]);
  });

  it('sanity: the 4 KB slug case is comfortably larger than every length bound this codebase enforces', () => {
    expect(FOUR_KB_SLUG.length).toBeGreaterThan(SLUG_MAX_LENGTH * 3);
  });
});
