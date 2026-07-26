import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RESERVED_HANDLES, RESERVED_PATHS } from '@posta/contracts';
import { CONTAINER_TEST_TIMEOUT_MS } from '../resolve-test-support';
import {
  HARNESS_DESTINATION,
  HARNESS_DOMAIN,
  HARNESS_HANDLE,
  HARNESS_SLUG,
  startHotPathHarness,
  type HotPathHarness,
} from './hot-path-harness';

// T2.6.5 — proves the acceptance criterion is "does zero work", not merely
// "answers 404". A reserved handle or reserved path is decided entirely
// inside host.ts's PURE parseRequestTarget (see that file's own header:
// "trivially table-testable... discovered HERE rather than after a wasted
// round trip") — middleware.ts's own switch routes 'reserved-handle',
// 'reserved-path' and 'invalid-path' straight to sendNotFound with no call
// to resolveTenant/resolveLink at all. A response-only assertion ("status
// is 404") would still pass if a future edit accidentally ran the lookup
// FIRST and simply discarded its answer — exactly the regression this file
// exists to catch, by spying on the REAL Redis client and the REAL pg Pool
// the T2.6.1 harness wires the production composition to (see that file's
// own header: `harness.pool` is the exact Pool `@posta/core`'s
// `drizzle(pool)` wraps, so a spy on it catches every Drizzle-issued query
// too, and `harness.redis` is the real ioredis client every resolve tier
// reads/writes).
//
// 14 cases, never hardcoded: RESERVED_HANDLES (11 handles) and
// RESERVED_PATHS (imported from @posta/contracts, the SAME lists host.ts's
// isReservedHandle/isReservedPath check) minus RESERVED_PATHS' own '/'
// entry, which is a DIFFERENT RequestTarget kind ('handle-root', the
// Origin-Rule alarm — see host.ts) and not one of this task's 14 cases,
// plus one literal for a `/.well-known/acme-challenge/*` probe — a
// synthetic CHILD of RESERVED_PATH_PREFIXES ('/.well-known/'), which
// matches a PREFIX rather than a finite set of exact strings (an ACME
// token is unpredictable), so there is no array entry to import for it.
// Hardcoding a copy of RESERVED_HANDLES here would silently stop covering
// any handle added to that list later — exactly the drift the shared
// module exists to prevent.
//
// [subtlety, verified by hand — see this task's own report] The three
// reserved-PATH cases are structurally DOUBLE-guarded: even a disabled
// isReservedPath would still never reach a lookup for '/favicon.ico' or
// '/robots.txt' (both contain a '.', which SLUG_PATTERN rejects
// regardless — packages/contracts/src/links.ts) or for the well-known
// probe (multiple path segments, which host.ts's own extractSlug rejects
// before isValidSlug is ever consulted). This redundancy is deliberate and
// already covered at the unit level (packages/contracts/src/reserved.test.ts,
// "pre-decode matching stays safe"). The reserved-HANDLE half has no such
// second guard: isReservedHandle is the ONLY thing standing between a
// reserved handle and a real resolveTenant call.
//
// [positive control] Every "zero calls" assertion below would pass
// vacuously if a spy were somehow never wired to the call it claims to
// intercept — a broken assertion mechanism proves nothing by itself. The
// final case in this file makes one more request, against the REAL seeded
// link, and asserts the SAME spies now show at least one call each.

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
}

/** A plain `http.request` against the harness's own ephemeral port, with
 * an arbitrary Host + path — generalizes hot-path-harness.test.ts's own
 * `requestSeededLink` (which fixes both) to this file's actual need: every
 * one of the 14 cases below varies EITHER the host (the 11 reserved-handle
 * cases, against a fixed path) OR the path (the 3 reserved-path cases,
 * against a fixed, valid handle host), never both from one hardcoded
 * pair. */
function requestHost(baseUrl: string, host: string, path: string): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A normally-valid slug shape — the SAME slug the harness's own seeded
// link uses — deliberately, rather than e.g. '/' or an empty path: host.ts's
// own isReservedHandle check runs BEFORE any path is ever examined (its own
// header: "Before any path work..."), so a broken guard tested against a
// path that could never reach a lookup for some OTHER reason would still
// look "correct". Requesting a path that WOULD be a legitimate lookup if
// the host weren't reserved is what makes "the handle guard alone stopped
// this" true rather than merely likely.
const RESERVED_HANDLE_REQUEST_PATH = `/${HARNESS_SLUG}`;

// RESERVED_PATHS' one entry that is NOT one of this task's 14 cases — see
// this file's own header.
const EXACT_RESERVED_PATHS = RESERVED_PATHS.filter((path) => path !== '/');

// A synthetic CHILD of RESERVED_PATH_PREFIXES, not itself a member of any
// exported array — see this file's own header for why.
const WELL_KNOWN_PROBE_PATH = '/.well-known/acme-challenge/x';

const RESERVED_PATH_CASES: readonly string[] = [...EXACT_RESERVED_PATHS, WELL_KNOWN_PROBE_PATH];

describe('reserved handles and paths never reach slug lookup (T2.6.5)', () => {
  let harness: HotPathHarness;

  beforeAll(async () => {
    harness = await startHotPathHarness();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  // Two of these eleven — 'app' and 'api' — never actually reach host.ts's
  // 'reserved-handle' RequestTarget at all: parseHandleFromHost refuses
  // them as handles in the first place (they ARE this deployment's own
  // app/api subdomains), so they arrive as 'not-ours' and fall through to
  // Nest's own router (see host.ts's own comment on RequestTarget's
  // 'reserved-handle' member). AppModule is still an empty `@Module({})`
  // at this epic (see app.module.ts), so there is no controller for either
  // host to match — Express's own default handler answers 404. The
  // assertion below is identical either way: no Redis GET, no Postgres
  // query, a 404 — proving BOTH routes to "this handle can never own a
  // link" cost zero lookups, not only the nine that go through
  // sendNotFound directly.
  it.each(RESERVED_HANDLES)(
    'reserved handle "%s" answers 404 with zero Redis GETs and zero Postgres queries',
    async (handle) => {
      const getSpy = vi.spyOn(harness.redis, 'get');
      const querySpy = vi.spyOn(harness.pool, 'query');

      try {
        const response = await requestHost(
          harness.baseUrl,
          `${handle}.${HARNESS_DOMAIN}`,
          RESERVED_HANDLE_REQUEST_PATH,
        );

        expect(response.status).toBe(404);
        expect(getSpy).not.toHaveBeenCalled();
        expect(querySpy).not.toHaveBeenCalled();
      } finally {
        getSpy.mockRestore();
        querySpy.mockRestore();
      }
    },
  );

  // Requested against HARNESS_HANDLE — a REAL, seeded, non-reserved handle
  // — so a broken isReservedPath guard would have a genuine tenant to
  // resolve and a genuine (if unknown) slug to look up: the same "give the
  // guard something real to fail open to" reasoning as
  // RESERVED_HANDLE_REQUEST_PATH above, applied to the other half of this
  // file's 14 cases.
  it.each(RESERVED_PATH_CASES)(
    'reserved path "%s" answers 404 with zero Redis GETs and zero Postgres queries',
    async (path) => {
      const getSpy = vi.spyOn(harness.redis, 'get');
      const querySpy = vi.spyOn(harness.pool, 'query');

      try {
        const response = await requestHost(harness.baseUrl, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, path);

        expect(response.status).toBe(404);
        expect(getSpy).not.toHaveBeenCalled();
        expect(querySpy).not.toHaveBeenCalled();
      } finally {
        getSpy.mockRestore();
        querySpy.mockRestore();
      }
    },
  );

  it('positive control: the real seeded link DOES trigger a Redis GET and a Postgres query', async () => {
    const getSpy = vi.spyOn(harness.redis, 'get');
    const querySpy = vi.spyOn(harness.pool, 'query');

    try {
      const response = await requestHost(harness.baseUrl, `${HARNESS_HANDLE}.${HARNESS_DOMAIN}`, `/${HARNESS_SLUG}`);

      expect(response.status).toBe(307);
      expect(response.headers.location).toBe(HARNESS_DESTINATION);
      // Neither tier has been touched by any earlier case in this file (no
      // reserved handle/path case ever calls resolveTenant/resolveLink),
      // so this is a genuinely cold cache: BOTH the handle tier and the
      // link tier miss Redis and fall through to Postgres, exercising both
      // spies for real rather than one alone.
      expect(getSpy).toHaveBeenCalled();
      expect(querySpy).toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      querySpy.mockRestore();
    }
  });
});
