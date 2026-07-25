import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendLinkRedirect } from './middleware';

// T2.4.1 [INV-3] — the response half of S2.4, exercised in isolation
// from resolution and enqueueing (T2.4.2-T2.4.5, dispatched separately,
// none of which this file touches). sendLinkRedirect is the seam T2.4.3
// will call once resolveLink (resolve-link.ts) returns a hit:
// `sendLinkRedirect(res, link.destination)`, immediately before
// `void enqueueCapture(payload).catch(logEnqueueFailure)` — see
// middleware.ts's own doc comment on the function for the full seam
// contract and why it is not wired into the middleware's switch yet
// (that composition is T2.4.3's job, not this task's).

/**
 * A minimal Express Response double. Mirrors middleware.test.ts's own
 * makeRes() in shape (statusCode / set / status / end / headers), plus
 * two additions this file's assertions specifically need:
 *
 * - `calls`: an ordered log of every set()/status()/end() invocation, so
 *   "headers are set before the response ends" is an assertion about
 *   observed call ORDER, not just final header values a caller could
 *   satisfy by calling set() after end() and getting away with it here.
 * - set()/status() throw if called after end() — a real Node
 *   ServerResponse throws ERR_HTTP_HEADERS_SENT under the identical
 *   condition, so this is not a test-only invention: it exists so an
 *   implementation that reorders end() ahead of the headers fails LOUDLY
 *   in this suite instead of silently passing a mock that never noticed.
 */
function makeRes() {
  const headers: Record<string, string> = {};
  const calls: string[] = [];
  const res = {
    statusCode: undefined as number | undefined,
    ended: false,
    set(name: string, value: string) {
      if (res.ended) {
        throw new Error(`set('${name}') called after end() — headers already sent`);
      }
      headers[name] = value;
      calls.push(`set:${name}`);
      return res;
    },
    status(code: number) {
      if (res.ended) {
        throw new Error('status() called after end() — headers already sent');
      }
      res.statusCode = code;
      calls.push('status');
      return res;
    },
    end() {
      res.ended = true;
      calls.push('end');
      return res;
    },
    headers,
    calls,
  };
  return res;
}

const DESTINATION_WITH_QUERY_AND_FRAGMENT = 'https://example.test/promo?a=1&b=2#frag';

describe('sendLinkRedirect', () => {
  it('responds with exactly status 307', () => {
    const res = makeRes();

    sendLinkRedirect(res as never, DESTINATION_WITH_QUERY_AND_FRAGMENT);

    expect(res.statusCode).toBe(307);
  });

  it('never responds with 301, 302 or 308 — 307 is the whole invariant [INV-3]', () => {
    const res = makeRes();

    sendLinkRedirect(res as never, DESTINATION_WITH_QUERY_AND_FRAGMENT);

    expect(res.statusCode).not.toBe(301);
    expect(res.statusCode).not.toBe(302);
    expect(res.statusCode).not.toBe(308);
  });

  it('sets Location byte-identical to a destination with multiple query params and a fragment', () => {
    const res = makeRes();

    sendLinkRedirect(res as never, DESTINATION_WITH_QUERY_AND_FRAGMENT);

    expect(res.headers['Location']).toBe(DESTINATION_WITH_QUERY_AND_FRAGMENT);
  });

  it('sets Cache-Control to no-store', () => {
    const res = makeRes();

    sendLinkRedirect(res as never, DESTINATION_WITH_QUERY_AND_FRAGMENT);

    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  // Guards against res.redirect()/res.location(): both run the URL
  // through Express's `encodeurl` dependency before writing the Location
  // header, and encodeurl re-escapes a `%` that is NOT part of a valid
  // `%XX` escape sequence — verified by hand against encodeurl's own
  // source and against a live Express server. This destination's `%zz`
  // is deliberately NOT a valid escape (`z` isn't a hex digit), so it is
  // what actually discriminates res.set() from res.redirect(): encodeurl
  // turns it into `%25zz`, while an ALREADY-valid escape like `%2F`
  // passes through encodeurl completely untouched and would prove
  // nothing about which one sendLinkRedirect uses (an earlier version of
  // this test used `%2F` and did not, in fact, discriminate — see the
  // T2.4.1 fix-round-1 report for how that was caught).
  it('preserves a destination containing an invalid percent escape byte-identical — no re-encoding', () => {
    const destination = 'https://example.test/50%zz-off?a=1&b=2#frag';
    const res = makeRes();

    sendLinkRedirect(res as never, destination);

    expect(res.headers['Location']).toBe(destination);
  });

  // Same encodeurl concern as above, from the other direction: a raw
  // (not pre-encoded) non-ASCII byte. Verified by hand that
  // res.redirect()/res.location() turn "promoción" into
  // "promoci%C3%B3n" via encodeurl — res.set() does not, which is why
  // sendLinkRedirect uses it.
  it('preserves a destination containing a non-ASCII character byte-identical — no re-normalisation', () => {
    const destination = 'https://example.test/promoción?a=1&b=2#frag';
    const res = makeRes();

    sendLinkRedirect(res as never, destination);

    expect(res.headers['Location']).toBe(destination);
  });

  it('sets Cache-Control and Location before ending the response, and ends exactly once', () => {
    const res = makeRes();

    sendLinkRedirect(res as never, DESTINATION_WITH_QUERY_AND_FRAGMENT);

    expect(res.calls.filter((call) => call === 'end')).toHaveLength(1);
    expect(res.calls.indexOf('end')).toBe(res.calls.length - 1);
    expect(res.calls).toContain('set:Cache-Control');
    expect(res.calls).toContain('set:Location');
  });
});

// [T2.4.1 fix round 1, CRITICAL] `zDestination` (packages/contracts/src/links.ts)
// accepts an absolute http(s) URL containing any Unicode character —
// confirmed by hand: `https://example.test/日本語` parses successfully.
// Node's raw HTTP header writer does not: it throws `ERR_INVALID_CHAR`
// synchronously for any code point above the Latin-1 supplement block
// (0xFF) — confirmed by sweeping every code point 0x00-0xFF one at a
// time against a real `http.ServerResponse`. Left uncaught, that turns a
// legitimately-created link into a PERMANENT per-slug outage: every
// future request for that slug throws.
//
// makeRes() (the describe block above) CANNOT reproduce this: its set()
// is a plain object method with no header validation at all, so it
// would silently accept a destination that crashes a real server — this
// is exactly why the original submission's tests didn't catch the bug.
// This block boots an ACTUAL Express app (this repo's own Express
// 5.2.1) on a real port and drives it with a real node:http request —
// mirroring middleware.test.ts's own real-server describe block — so a
// regression here fails for real, not just in a mock that never
// noticed.
describe('sendLinkRedirect — destinations outside the Latin-1 range, against a real Express server', () => {
  let server: http.Server;
  let port: number;
  let destination = '';

  beforeAll(async () => {
    const app = express();
    app.get('/redirect', (_req, res) => {
      sendLinkRedirect(res, destination);
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function requestRedirect(): Promise<{ status: number; location: string | undefined }> {
    return new Promise((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port, path: '/redirect' }, (res) => {
          res.resume();
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, location: res.headers.location });
          });
        })
        .on('error', reject);
    });
  }

  it('percent-encodes a CJK destination instead of crashing the request with ERR_INVALID_CHAR', async () => {
    destination = 'https://example.test/日本語?a=1&b=2#frag';

    const response = await requestRedirect();

    expect(response.status).toBe(307);
    expect(response.location).toBe('https://example.test/%E6%97%A5%E6%9C%AC%E8%AA%9E?a=1&b=2#frag');
  });

  // A surrogate-pair character (astral plane, represented as TWO UTF-16
  // code units) — proves encodeDestinationForHeader reads by Unicode
  // code point, not by code unit, so this doesn't come back as two
  // broken half-encodings.
  it('percent-encodes a surrogate-pair emoji destination instead of crashing the request', async () => {
    destination = 'https://example.test/🎉?a=1&b=2#frag';

    const response = await requestRedirect();

    expect(response.status).toBe(307);
    expect(response.location).toBe(`https://example.test/${encodeURIComponent('🎉')}?a=1&b=2#frag`);
  });

  it('still redirects a plain ASCII destination byte-identical through the same real server', async () => {
    destination = DESTINATION_WITH_QUERY_AND_FRAGMENT;

    const response = await requestRedirect();

    expect(response.status).toBe(307);
    expect(response.location).toBe(DESTINATION_WITH_QUERY_AND_FRAGMENT);
  });

  it('still redirects a Latin-1 accented destination byte-identical through the same real server', async () => {
    destination = 'https://example.test/promoción?a=1&b=2#frag';

    const response = await requestRedirect();

    expect(response.status).toBe(307);
    expect(response.location).toBe(destination);
  });

  // [T2.4.1 fix round 2, CRITICAL] `zDestination` (`z.url()`) accepts a
  // destination containing a LONE, unpaired UTF-16 surrogate — confirmed
  // by hand: `String.fromCharCode(0xd800)` embedded mid-URL parses
  // successfully. That single code unit is not a valid Unicode character
  // on its own, so `encodeURIComponent` throws `URIError: URI malformed`
  // when asked to encode it — the identical "permanent per-slug outage"
  // shape as the CJK/emoji case above, just arriving through a different
  // exception type that a try/catch around `res.setHeader` alone would
  // not have caught. There is no valid Location this destination can
  // ever produce, so sendLinkRedirect must 404 — the same terminal
  // branch an unresolvable link already takes — rather than let the
  // exception escape and crash the request.
  it('responds 404, not a crash, when the destination contains a lone unpaired surrogate that cannot be encoded', async () => {
    destination = `https://example.test/x${String.fromCharCode(0xd800)}x?a=1&b=2#frag`;

    const response = await requestRedirect();

    expect(response.status).toBe(404);
    expect(response.location).toBeUndefined();
  });
});
