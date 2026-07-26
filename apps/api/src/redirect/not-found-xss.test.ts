import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { JSDOM } from 'jsdom';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { makeUrlBuilders, resolveReservedHandles } from '@posta/contracts';
import { escapeHtml } from './escape-html';
import { createEnqueueCapture, createEnqueueDroppedCounter, type EnqueueQueue } from './enqueue';
import { makeRequestTargetParser } from './host';
import {
  consoleErrorLogger,
  createHandleRootHitsCounter,
  createOpenRedirectRejectedCounter,
  createRedirectMiddleware,
} from './middleware';
import { makeNotFoundRenderer } from './not-found';
import type { ResolveTenant } from './resolve-tenant';

// T2.5.4 [security] — attacks what T2.5.1 (escapeHtml), T2.5.2
// (renderNotFound) and T2.5.3 (wiring) built, END TO END through a real
// HTTP request/response round trip rather than by calling renderNotFound
// directly. not-found.test.ts (T2.5.2) already proves escapeHtml is
// correct in isolation — that is a unit-level backstop. The risk THIS
// file exists for is different: a future refactor that reflects
// `req.path`, a query param, or anything else attacker-controlled
// somewhere the escaper does not cover, without ever touching
// renderNotFound's own call site. Only a request-level test — a real
// Express app, a real Node HTTP server, a real socket — can catch that,
// because a unit test on renderNotFound cannot see code that never calls
// it.
//
// Why this matters here specifically: the 404 is served from
// `<tenant>.<domain>` — the SAME origin as every tenant's own bio page.
// A reflected XSS here executes in an origin that matters (session
// cookies, if this product ever adds first-party auth to that surface;
// today, at minimum, the visitor's trust in the tenant's brand), and
// anyone can trigger it by sending a victim a link to a nonexistent slug
// on a legitimate tenant's subdomain — no phishing infrastructure of
// their own required.
//
// [decision 1] Parsed with jsdom, never regexed. A regex for `<script`
// is defeated by exactly the encoding tricks this suite tests for (a
// `<ScRiPt>`, a null byte spliced into the tag name, ...); jsdom is what
// a browser's own HTML parser approximates, so it is asked the same
// question a real attacker would need answered: does this text become a
// <script> element, or an on* attribute, once parsed? `scanForInjectedMarkup`
// below never calls `.window.eval` or sets `runScripts` — jsdom's own
// default (scripts never execute) is left untouched, since this suite
// only ever needs the PARSED TREE, never a live execution.
//
// [decision 2] Every payload test also asserts the payload's own
// dangerous substring never appears verbatim in the raw response text,
// in addition to the structural scan. Structural absence and textual
// absence catch different failures: a payload could be neutralised as
// markup (no <script> element forms) yet still leak into an HTML
// comment or a future attribute value verbatim, which a
// structure-only check would miss.
//
// [decision 3] Sent through a REAL request — never by calling
// renderNotFound directly — using Node's own http client (mirroring
// not-found-routing.test.ts's requestPath helper) so each payload
// travels exactly as an attacker's browser or curl invocation would send
// it. Two of the five required payloads cannot survive completely
// unencoded on the wire; this file percent-encodes ONLY the bytes that
// must be encoded to survive, and proves — rather than assumes — which
// ones those are:
//
//   | payload                        | reaches the app as...                          | branch        |
//   |---------------------------------|------------------------------------------------|---------------|
//   | `<script>alert(1)</script>`     | byte-for-byte, unencoded                        | invalid-path  |
//   | `"><svg onload=alert(1)>`       | unencoded except its one space -> `%20`         | invalid-path  |
//   | `%00` (the null byte payload)   | only reachable percent-encoded; RAW is rejected | invalid-path  |
//   | `%3Cscript%3E`                  | byte-for-byte, unencoded (already encoded text) | invalid-path  |
//   | a 4 KB `<script>...` slug       | byte-for-byte, unencoded                        | invalid-path  |
//
// The raw SPACE and raw NULL BYTE are not data characters in an HTTP
// request-target (RFC 7230 §3.1.1 uses a bare space as the field
// separator between the method, the target and the HTTP version) —
// confirmed twice below, at BOTH layers that could have let one through:
// Node's own http client refuses to even open the request
// (`http.request` throws synchronously, "Request path contains
// unescaped characters"), and — bypassing that client-side guard
// entirely with a raw `net.Socket` — the SERVER's own HTTP parser
// answers with a bare 400 Bad Request before Express, this application's
// middleware, or renderNotFound ever run. A payload rejected at that
// layer is not a test of the escaper; the "cannot reach the app at all"
// describe block below proves that rejection directly rather than just
// asserting it in a comment.
//
// [decision 4] More than one terminal branch is covered. `host.ts`'s
// SLUG_PATTERN (`[a-z0-9]` plus `-`, packages/contracts/src/links.ts)
// makes every one of the five required payloads fail `isValidSlug` — so
// none of them can EVER become the 'link' RequestTarget kind, and every
// one of them lands on 'invalid-path' instead, which reflects the RAW
// `req.path` (middleware.ts's `describeRequestedPath`), never a decoded
// slug. That is not an assumption this file makes about host.ts's
// internals; the final describe block proves it two ways: a payload test
// asserting `resolveLink` is called zero times (so the app never even
// attempted to treat the payload as a slug lookup), and a companion test
// showing an ordinary, charset-valid, attacker-CHOSEN slug DOES reach
// the 'link' branch's own decoded-slug reflection and is protected by
// the exact same `escapeHtml` pipeline there.
//
// [S2.5 fan-out review, corrected] 'reserved-path' is NOT tested
// separately from 'invalid-path' — but NOT because 'invalid-path' is the
// only branch that ever reflects attacker-controlled markup, which an
// earlier version of this comment (and a prior review) implied. It is
// not: `isReservedPath` (packages/contracts/src/reserved.ts) matches
// `RESERVED_PATH_PREFIXES` (`/.well-known/`) with a plain `startsWith` on
// a lowercased copy and validates nothing about what follows that prefix
// — so `/.well-known/<script>alert(1)</script>` classifies as
// 'reserved-path', not 'invalid-path', and reflects that exact payload
// identically. BOTH branches carry attacker-controlled markup; they are
// deliberately merged into one `case 'reserved-path': case 'invalid-path':`
// block in middleware.ts precisely so that fact never has to be
// rediscovered branch-by-branch — same code, same
// `describeRequestedPath(req.path)` call, same `escapeHtml` guarantee,
// for both. A test exercising `/.well-known/<script>...</script>`
// separately would prove nothing the `/<script>...</script>` payload
// already tested above doesn't — the "looks thorough, cannot fail" shape
// this epic's own review process has already flagged once
// (not-found.test.ts's own fix-round comment) — because the identical
// line of code answers both inputs. 'handle-root' and 'reserved-handle'
// are skipped for a genuinely different reason: both always reflect a
// fixed empty string (middleware.ts, decision 2 of T2.5.3's own
// dispatch) — there is no attacker-controlled CONTENT in that value to
// attack, unlike 'reserved-path'/'invalid-path', which both carry the
// real, attacker-influenced request path.

const DOMAIN = 'example.test';
const HANDLE = 'juano';
const TENANT_ID = 'tenant-1';

const urls = makeUrlBuilders({
  domain: DOMAIN,
  protocol: 'http',
  appSubdomain: 'app',
  apiSubdomain: 'api',
});
const renderNotFound = makeNotFoundRenderer({ urls });

const resolveTenantStub: ResolveTenant = async (handle) => (handle === HANDLE ? TENANT_ID : null);

interface TestServer {
  readonly port: number;
  readonly addCalls: number;
  readonly resolveLinkCalls: number;
  close(): Promise<void>;
}

/** Same shape as not-found-routing.test.ts's own buildServer (T2.5.3) —
 * a real Express + http server, no containers: nothing here needs real
 * Postgres/Redis correctness, only the middleware's own routing and
 * response-writing behavior. `resolveLinkCalls` is this file's one
 * addition, load-bearing for decision 4 above: it is the proof that a
 * payload never reached the 'link' branch's own resolution logic at
 * all, not merely that its OUTPUT looked safe. */
function buildServer(): Promise<TestServer> {
  let addCalls = 0;
  let resolveLinkCalls = 0;

  const app = express();
  const parseRequestTarget = makeRequestTargetParser({
    urls,
    reservedHandles: resolveReservedHandles(),
  });

  const queue: EnqueueQueue = {
    add: () => {
      addCalls += 1;
      return Promise.resolve('job-id');
    },
  };
  const droppedCounter = createEnqueueDroppedCounter(new Registry());
  const enqueueCapture = createEnqueueCapture({ queue, droppedCounter });

  // Always a miss: every slug this suite can legitimately reach the
  // 'link' branch with is, by construction, one nobody registered.
  const resolveLinkStub = () => {
    resolveLinkCalls += 1;
    return Promise.resolve(null);
  };

  app.use(
    createRedirectMiddleware({
      parseRequestTarget,
      logger: consoleErrorLogger,
      handleRootHitsCounter: createHandleRootHitsCounter(new Registry()),
      openRedirectRejectedCounter: createOpenRedirectRejectedCounter(new Registry()),
      resolveTenant: resolveTenantStub,
      resolveLink: resolveLinkStub,
      lookupNetwork: () => ({ asn: null, country: null }),
      getDailySalt: async () => 'not-found-xss-test-salt-not-a-real-secret',
      enqueueCapture,
      renderNotFound,
    }),
  );

  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        get addCalls() {
          return addCalls;
        },
        get resolveLinkCalls() {
          return resolveLinkCalls;
        },
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.once('error', reject);
  });
}

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Sends `path` to the server EXACTLY as given, via Node's own http
 * client — mirrors not-found-routing.test.ts's identical helper. Every
 * payload test below decides its OWN wire encoding deliberately (see the
 * file header's table); this helper must never second-guess that choice
 * by encoding or normalizing anything itself.
 */
function requestPath(port: number, host: string, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Writes a request line with `target` byte-for-byte onto a raw
 * `net.Socket`, bypassing Node's http client (and its own request-target
 * validation) entirely. Used ONLY by the "cannot reach the app at all"
 * tests below, to prove a payload is rejected by the SERVER's own HTTP
 * parser — not merely by the client library — before this application's
 * middleware, or renderNotFound, ever runs.
 */
function sendRawRequestLine(port: number, target: string): Promise<{ status: number | null }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${HANDLE}.${DOMAIN}\r\nConnection: close\r\n\r\n`, 'binary');
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('binary');
    });
    socket.on('end', () => {
      const statusLine = /^HTTP\/1\.\d (\d{3})/.exec(data);
      resolve({ status: statusLine?.[1] ? Number(statusLine[1]) : null });
    });
    socket.on('error', reject);
  });
}

interface StructuralScan {
  readonly scriptElementCount: number;
  readonly eventHandlerAttributes: readonly string[];
}

/**
 * Parses `html` with jsdom (T2.5.4's own dispatch, decision 1) rather
 * than regexing it. `runScripts` is left at jsdom's own default (never
 * executes embedded scripts) — this suite only ever needs the PARSED
 * TREE to answer "did this become a real element/attribute", never a
 * live execution of whatever a payload produced.
 */
function scanForInjectedMarkup(html: string): StructuralScan {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const scriptElementCount = document.querySelectorAll('script').length;

  const eventHandlerAttributes: string[] = [];
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('on')) {
        eventHandlerAttributes.push(`<${element.tagName.toLowerCase()} ${attribute.name}>`);
      }
    }
  }

  return { scriptElementCount, eventHandlerAttributes };
}

/**
 * The safety assertion every payload test below shares: zero `<script>`
 * elements, zero `on*` attributes (decision 1), and none of
 * `dangerousSubstrings` appears verbatim, unescaped, anywhere in the raw
 * response text (decision 2) — checked independently of the structural
 * scan, since a payload could be neutralised as markup while still
 * leaking into a comment or an attribute value as inert-looking text.
 */
function assertPayloadNeverExecutes(body: string, dangerousSubstrings: readonly string[]): void {
  const scan = scanForInjectedMarkup(body);
  expect(scan.scriptElementCount).toBe(0);
  expect(scan.eventHandlerAttributes).toEqual([]);

  for (const dangerous of dangerousSubstrings) {
    expect(body).not.toContain(dangerous);
  }
}

const openServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

// A fixed grace period after each 404, mirroring not-found-routing.test.ts's
// own identical wait: gives a wrongly-added fire-and-forget continuation
// (an enqueue, a resolveLink call) a moment it would need to run before
// this file asserts it never did.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('bytes this suite could not deliver intact — proven, not assumed', () => {
  it('a raw space in the request line: Node\'s own http client refuses to even send it', () => {
    // Documents WHY the "><svg onload=alert(1)> payload below percent-
    // encodes its one space: this is not this application's behavior at
    // all, it is Node's http client validating the request-target before
    // it opens a socket.
    expect(() => {
      http.request({ hostname: '127.0.0.1', port: 1, path: '/"><svg onload=alert(1)>' });
    }).toThrow(/unescaped characters/i);
  });

  it('a raw space in the request line is also rejected by the server\'s own HTTP parser — this application never runs', async () => {
    const server = await buildServer();
    openServers.push(server);

    const result = await sendRawRequestLine(server.port, '/"><svg onload=alert(1)>');

    // 400 from Node's own HTTP parser (llhttp), before Express or
    // createRedirectMiddleware ever see the request — there is no
    // application branch to protect here at all.
    expect(result.status).toBe(400);
  });

  it('a raw null byte in the request line is rejected the same way, by both layers', async () => {
    const server = await buildServer();
    openServers.push(server);
    const rawNullTarget = '/' + String.fromCharCode(0) + 'null-byte';

    expect(() => {
      http.request({ hostname: '127.0.0.1', port: 1, path: rawNullTarget });
    }).toThrow(/unescaped characters/i);

    const result = await sendRawRequestLine(server.port, rawNullTarget);
    expect(result.status).toBe(400);
  });
});

describe('required payload: <script>alert(1)</script>', () => {
  it('survives the request line byte-for-byte and is reflected, escaped, on the invalid-path branch', async () => {
    const server = await buildServer();
    openServers.push(server);

    const payload = '<script>alert(1)</script>';
    // No space, no control byte — sent completely unencoded, exactly as
    // typed into a browser's address bar. The embedded '/' in
    // '</script>' means host.ts's extractSlug rejects this as a
    // multi-segment path before it ever tries to decode anything, so
    // this lands on 'invalid-path', which reflects the RAW req.path
    // (middleware.ts's describeRequestedPath), not a decoded slug.
    const response = await requestPath(server.port, `${HANDLE}.${DOMAIN}`, `/${payload}`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');

    assertPayloadNeverExecutes(response.body, [payload]);
    // Reflected, not silently dropped: the ESCAPED form must actually
    // appear, matching not-found.test.ts's own "prove reflection, not
    // deletion" convention.
    expect(response.body).toContain(`cd /${escapeHtml(payload)}`);

    await settle();
    expect(server.addCalls).toBe(0);
    expect(server.resolveLinkCalls).toBe(0);
  });
});

describe('required payload: "><svg onload=alert(1)>', () => {
  it('needs only its one space percent-encoded to survive the request line', async () => {
    const server = await buildServer();
    openServers.push(server);

    const decodedPayload = '"><svg onload=alert(1)>';
    // Every character here OTHER than the space — '"', '<', '>', '(',
    // ')', '=' — is not special to the request-line grammar and reaches
    // the application completely unencoded (proven by the payload
    // above). Encoding ONLY the space is therefore the minimal change
    // needed to deliver this exact payload intact; describeRequestedPath
    // (middleware.ts) never decodes req.path, so what actually reaches
    // escapeHtml is this wire form, '%20' and all — never a real space.
    const wireForm = '"><svg%20onload=alert(1)>';
    const response = await requestPath(server.port, `${HANDLE}.${DOMAIN}`, `/${wireForm}`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');

    assertPayloadNeverExecutes(response.body, [decodedPayload, wireForm]);
    expect(response.body).toContain(`cd /${escapeHtml(wireForm)}`);

    await settle();
    expect(server.addCalls).toBe(0);
    expect(server.resolveLinkCalls).toBe(0);
  });
});

describe('required payload: %3Cscript%3E (asserting the DECODED form is escaped too)', () => {
  it('reaches the app as literal percent-encoded text; the decoded "<script>" never appears anywhere in the response', async () => {
    const server = await buildServer();
    openServers.push(server);

    const encodedPayload = '%3Cscript%3E';
    const decodedPayload = '<script>';

    const response = await requestPath(server.port, `${HANDLE}.${DOMAIN}`, `/${encodedPayload}`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');

    // host.ts's extractSlug DOES decodeURIComponent this segment — but
    // only to ask isValidSlug whether it could be a real slug. It fails
    // (SLUG_PATTERN excludes '<'/'>' entirely), so that decoded value is
    // discarded right there and never reaches this response:
    // describeRequestedPath reflects req.path AS SENT, still
    // percent-encoded. The assertion below does not lean on that
    // implementation detail, though — it locks in the OUTCOME regardless
    // of mechanism: however this branch is ever wired in the future, the
    // literal decoded string "<script>" must never appear unescaped.
    assertPayloadNeverExecutes(response.body, [decodedPayload]);
    // Reflected, not dropped — the raw percent-encoded text (inert on
    // its own; it contains no HTML metacharacter at all) must actually
    // appear.
    expect(response.body).toContain(`cd /${escapeHtml(encodedPayload)}`);

    await settle();
    expect(server.addCalls).toBe(0);
    expect(server.resolveLinkCalls).toBe(0);
  });
});

describe('required payload: a null byte', () => {
  it('is only reachable percent-encoded (%00); decoded internally for validation, discarded, and never appears raw in the response', async () => {
    const server = await buildServer();
    openServers.push(server);

    const encodedPayload = '%00';
    const response = await requestPath(server.port, `${HANDLE}.${DOMAIN}`, `/${encodedPayload}`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');

    assertPayloadNeverExecutes(response.body, []);
    // No literal null byte anywhere in the response — the decoded value
    // (a real \0 character) is discarded the same way the %3Cscript%3E
    // payload's decoded form is, above.
    expect(response.body).not.toContain(String.fromCharCode(0));
    expect(response.body).toContain(`cd /${escapeHtml(encodedPayload)}`);

    await settle();
    expect(server.addCalls).toBe(0);
    expect(server.resolveLinkCalls).toBe(0);
  });
});

describe('required payload: a 4 KB slug', () => {
  it('an oversized, script-shaped path is rejected before decoding, and the reflected prefix stays fully escaped', async () => {
    const server = await buildServer();
    openServers.push(server);

    const unit = '<script>alert(1)</script>';
    const fourKbPayload = unit.repeat(Math.ceil(4096 / unit.length)).slice(0, 4096);
    expect(fourKbPayload).toHaveLength(4096);

    const response = await requestPath(server.port, `${HANDLE}.${DOMAIN}`, `/${fourKbPayload}`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');

    // host.ts's own MAX_ENCODED_SLUG_LENGTH check (3x SLUG_MAX_LENGTH =
    // 192 chars) rejects a path this long before decodeURIComponent ever
    // runs on it, and escape-html.ts's own MAX_INPUT_LENGTH (128 chars)
    // truncates it again before escaping — both clamps T2.5.1/T2.5.2
    // already test in isolation, exercised here through a REAL,
    // oversized request instead.
    assertPayloadNeverExecutes(response.body, [unit]);
    expect(response.body).toContain(`cd /${escapeHtml(fourKbPayload)}`);
    // Ties back to S2.5's own whole-document acceptance criterion.
    expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThan(4096);

    await settle();
    expect(server.addCalls).toBe(0);
    expect(server.resolveLinkCalls).toBe(0);
  });
});

describe('the link branch: structurally unreachable by these payloads, equally protected when legitimately reached', () => {
  it('a syntactically valid, attacker-chosen slug DOES reach the link branch, and its decoded reflection is escaped like every other branch', async () => {
    const server = await buildServer();
    openServers.push(server);

    // The only kind of value that can ever reach the 'link' branch's own
    // decoded-slug reflection: attacker-CHOSEN (nobody registered this
    // slug), but charset-constrained to [a-z0-9-] by isValidSlug /
    // SLUG_PATTERN — exactly why none of the five required payloads
    // above could ever land here instead of on 'invalid-path'. This test
    // exists so that claim is demonstrated, not merely inferred: the
    // SAME escapeHtml pipeline every other branch uses is proven to run
    // on THIS branch's differently-sourced value too. An ordinary safe
    // slug has nothing to escape, so this is a wiring/structure check,
    // not a bypass attempt.
    const attackerChosenSlug = 'attacker-chosen-slug-that-does-not-exist';
    const response = await requestPath(server.port, `${HANDLE}.${DOMAIN}`, `/${attackerChosenSlug}`);

    expect(response.status).toBe(404);
    assertPayloadNeverExecutes(response.body, []);
    expect(response.body).toContain(`cd /${escapeHtml(attackerChosenSlug)}`);

    await settle();
    expect(server.addCalls).toBe(0);
    // The decisive counterpart to every "resolveLinkCalls === 0" assertion
    // above: a genuinely slug-shaped request DOES reach resolveLink,
    // proving those zero-counts were about the PAYLOADS being rejected
    // upstream, not about this stub or server never wiring resolveLink
    // at all.
    expect(server.resolveLinkCalls).toBe(1);
  });
});
