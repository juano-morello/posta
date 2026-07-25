import { describe, expect, it } from 'vitest';
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
  // header, which would silently rewrite an already-percent-encoded
  // sequence's `%` into `%25` (double-encoding) — verified by hand
  // against a live Express server before choosing res.set() instead. A
  // destination already carrying percent-encoding must reach the visitor
  // exactly as stored, not re-escaped a second time.
  it('preserves an already percent-encoded destination byte-identical — no re-encoding', () => {
    const destination = 'https://example.test/%2Falready%2Fencoded?a=1&b=2#frag';
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
