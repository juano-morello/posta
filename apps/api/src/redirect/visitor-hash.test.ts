import type { CaptureEvent } from '@posta/contracts';
import { createDailySalt, type DailySaltLogger, type DailySaltRedis } from '@posta/core';
import { withPinnedTz } from '@posta/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeVisitorHash, readClientIp, type ClientIp } from './capture';

// T2.3.9 — the test that makes the dashboard's "únicos hoy" claim true
// rather than aspirational (story S2.3's closing line). This is
// deliberately NOT a repeat of capture.test.ts's own computeVisitorHash
// cases, which drive the hash with hand-picked literal salt strings
// ('salt-a', 'salt-b') to prove the HASH MATH is correct in isolation.
// This file proves the thing a step further up the chain: that
// createDailySalt (T2.3.6, packages/core/src/redis/salt.ts) — the REAL
// salt manager the redirect hot path will actually call — produces one
// salt per UTC calendar day and a genuinely different one after
// rotation, and that computeVisitorHash's stability/instability
// properties hold when driven by THAT salt, not a stand-in string. A
// regression that broke the WIRING between getDailySalt()'s output and
// computeVisitorHash's salt parameter (e.g. a stale memo reused across a
// rotation, or a per-request salt that never converges) would pass every
// test in capture.test.ts and only be caught here.
//
// ── Controller-ruled adaptation of the brief's "a real Redis for the
// salt" ──
//
// Docker is unresponsive in this environment (`docker info` hangs past
// 180s — confirmed directly, not assumed), so every testcontainer suite
// is unrunnable right now; that is environmental, not something this
// task caused. The controller's ruling for T2.3.9: use the REAL
// createDailySalt from packages/core/src/redis/salt.ts, driven by an
// in-memory Redis double (below) that implements just the two commands
// createDailySalt issues — `SET key value EX seconds NX` and `GET key`
// — with genuine NX semantics (only writes when the key is absent).
// That is stronger than stubbing getDailySalt() outright: it still
// exercises the real SET-NX-then-GET convergence path, the real
// formatUtcDate-based UTC date keying (keys.ts), and the real
// process-local memo (salt.ts's own `memo` Map) — everything this file's
// four properties actually depend on. What it does NOT prove is real
// Redis WIRE behaviour (network round trips, real TTL replies, real
// concurrent-process convergence over an actual socket) — that is
// already covered by T2.3.6's own salt.test.ts, which runs the identical
// createDailySalt against a real Redis testcontainer. This file's own
// scope is narrower and one level up the stack: given a salt manager
// that behaves correctly (proven there), does visitor_hash stay stable
// within a day and rotate across one (proven here)?
//
// ── withPinnedTz: imported from @posta/core/testing ──
//
// Previously a byte-identical local copy (this file couldn't reach
// packages/core/src/redis/test-support.ts via a relative import across the
// api->core package boundary). A code-reviewer finding on the S2.3
// story-level fan-out caught that the copy's docstring had already drifted
// from the original — the "call once per instant, never once around
// multiple vi.setSystemTime() instants" rule this file's own rotation
// tests below depend on lived only in the original, not here. Fixed by
// promoting withPinnedTz onto @posta/core's TEST-ONLY subpath
// (packages/core/src/test/pinned-tz.ts, exported via
// packages/core/src/test/index.ts's "@posta/core/testing" barrel — see
// that file's own header for why the subpath exists), so every caller
// shares the one definition and its one docstring instead of a copy that
// can silently fall behind it.

/** Matches salt.test.ts's own LoggerErrorFn workaround: an untyped
 * `vi.fn()` infers `(...args: any[]) => any`, which is not structurally
 * assignable to DailySaltLogger under `pnpm typecheck:tests`. */
type LoggerErrorFn = (message: string, meta?: Record<string, unknown>) => void;

function makeSpyLogger(): DailySaltLogger & { error: ReturnType<typeof vi.fn<LoggerErrorFn>> } {
  return { error: vi.fn<LoggerErrorFn>() };
}

/**
 * The in-memory DailySaltRedis double this file's controller ruling
 * calls for: genuine `SET key value EX seconds NX` semantics (a key is
 * only ever written the FIRST time it is set; every later SET for the
 * same key is a no-op that returns `null`, exactly like real Redis NX)
 * plus a plain `GET`. No TTL bookkeeping — nothing in this file reads a
 * TTL, and T2.3.6's own salt.test.ts already proves the real TTL against
 * a real Redis container. No failure injection either — this file never
 * exercises the outage-fallback path (also already covered, by
 * salt.test.ts's own in-memory double); the properties under test here
 * are entirely about correct convergence and rotation on the happy path.
 */
function createInMemoryDailySaltRedis(): DailySaltRedis {
  const store = new Map<string, string>();

  return {
    async set(key, value) {
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      return store.get(key) ?? null;
    },
  };
}

// RFC 5737 TEST-NET-3 addresses — never real hosts, and distinguishable
// from one another at a glance in a failing assertion's diff without
// this file ever needing to print a real visitor's IP (invariant 6 still
// applies to a test file: no IP belonging to a real visitor is ever
// constructed here, and this file never logs — via console or an
// injected logger — the ip, the salt, or the hash inputs; only booleans
// and the derived hash strings themselves ever reach an `expect()`).
const IP_A = '203.0.113.10';
const IP_B = '203.0.113.20';
const UA_A = 'Mozilla/5.0 (visitor-hash-test A)';
const UA_B = 'Mozilla/5.0 (visitor-hash-test B)';

function clientIp(ip: string): ClientIp {
  const parsed = readClientIp({ 'cf-connecting-ip': ip });
  if (parsed === null) throw new Error('test setup: readClientIp returned null for a literal IP');
  return parsed;
}

/** Fetches today's salt from the REAL createDailySalt and computes the
 * visitor hash from it in one step — the exact two-call sequence the
 * eventual redirect hot path (T2.4.x) will make. Returns the salt
 * alongside the hash so a test can assert the CAUSAL chain (the hash
 * changed because the salt did) rather than trusting a bare hash
 * inequality — see the rotation test below. */
async function visitorHashNow(
  getDailySalt: () => Promise<string>,
  ip: ClientIp,
  userAgent: string,
): Promise<{ salt: string; hash: string }> {
  const salt = await getDailySalt();
  const hash = computeVisitorHash(ip, userAgent, salt);
  return { salt, hash };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('visitor_hash — stability within a day (T2.3.9)', () => {
  it('two requests from the same IP + UA, hours apart on the SAME UTC day, produce ONE identical visitor_hash', async () => {
    const getDailySalt = createDailySalt({ redis: createInMemoryDailySaltRedis(), logger: makeSpyLogger() });
    const ip = clientIp(IP_A);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T08:00:00.000Z'));
    const morning = await visitorHashNow(getDailySalt, ip, UA_A);

    vi.setSystemTime(new Date('2026-03-10T20:00:00.000Z'));
    const evening = await visitorHashNow(getDailySalt, ip, UA_A);

    // Same salt (the causal reason), therefore the same hash — not just
    // an incidental equality.
    expect(morning.salt === evening.salt).toBe(true);
    expect(morning.hash).toBe(evening.hash);
  });
});

describe('visitor_hash — rotation across the UTC midnight boundary (T2.3.9)', () => {
  // Pinned to a POSITIVE UTC offset, same reasoning as
  // packages/core/src/redis/{keys,salt}.test.ts's own rotation cases
  // (see withPinnedTz's doc comment above): this repo's CI runs UTC and
  // this repo's dev sandbox runs America/Buenos_Aires (UTC-3) — a
  // negative or zero offset. 23:30 UTC and the following 00:30 UTC are
  // still the SAME calendar day in both of those environments whether
  // read via getUTC*() or the local getFullYear()/getMonth()/getDate()
  // equivalents, so a test that only relies on the host's ambient
  // timezone could pass identically against a formatUtcDate regressed to
  // local getters. This epic already shipped exactly that mistake once
  // (keys.test.ts's own history, per this task's dispatch) — Europe/
  // Berlin is what actually forces UTC and local to disagree at this
  // instant: 23:30 UTC on Jan 5 is already 00:30 CET on Jan 6.
  it('the same visitor, requesting just before and just after UTC midnight, gets a DIFFERENT visitor_hash — because the salt itself rotated', async () => {
    const getDailySalt = createDailySalt({ redis: createInMemoryDailySaltRedis(), logger: makeSpyLogger() });
    const ip = clientIp(IP_A);

    // Each read is wrapped in its OWN withPinnedTz call — not one call
    // wrapping both — DELIBERATELY, not merely for symmetry. Investigated
    // by hand while building this test's RED proof (see T2.3.9-report.md):
    // reading local-time getters twice against two different
    // vi.setSystemTime() instants, under ONE unchanged TZ pin held for
    // both reads, produces a STALE/WRONG local date on the SECOND read in
    // this Vitest/@sinonjs-fake-timers/Node combination (repros with
    // plain Date.prototype.getDate(), nothing specific to this file's own
    // code) — even across a vi.useRealTimers()/vi.useFakeTimers()
    // reinstall in between. Re-asserting `process.env.TZ` between the two
    // reads (which is exactly what a second withPinnedTz call does, even
    // pinning the IDENTICAL zone) reliably clears it. Only relevant here
    // because this test's whole point is exercising local-vs-UTC date
    // math; every OTHER test in this file reads real UTC-based salts and
    // never local getters, so it never hits this.
    const beforeMidnightUtc = await withPinnedTz('Europe/Berlin', () => {
      vi.useFakeTimers({ now: new Date('2026-01-05T23:30:00.000Z') });
      const result = visitorHashNow(getDailySalt, ip, UA_A);
      return result.finally(() => vi.useRealTimers());
    });

    const afterMidnightUtc = await withPinnedTz('Europe/Berlin', () => {
      vi.useFakeTimers({ now: new Date('2026-01-06T00:30:00.000Z') });
      const result = visitorHashNow(getDailySalt, ip, UA_A);
      return result.finally(() => vi.useRealTimers());
    });

    // Property under test: the SALT rotated (the cause) ...
    expect(beforeMidnightUtc.salt === afterMidnightUtc.salt).toBe(false);
    // [code-reviewer, S2.3 fan-out] The two lines below do NOT recompute
    // either side's hash from the OTHER side's salt — each recomputes its
    // OWN hash from its OWN salt. That is a determinism check
    // (computeVisitorHash is pure: the same ip/userAgent/salt triple
    // always yields the same hash), already covered more directly by
    // capture.test.ts's own hash-math tests, not a cross-side proof. The
    // actual causal proof that the hash changed BECAUSE the salt did is
    // the pairing of the salt-inequality assertion above with the
    // hash-inequality assertion below — ip/userAgent held fixed
    // throughout, so nothing else could account for either difference.
    expect(computeVisitorHash(ip, UA_A, afterMidnightUtc.salt)).toBe(afterMidnightUtc.hash);
    expect(computeVisitorHash(ip, UA_A, beforeMidnightUtc.salt)).toBe(beforeMidnightUtc.hash);
    expect(beforeMidnightUtc.hash).not.toBe(afterMidnightUtc.hash);
  });

  // Privacy consequence (spec §5.3, restated in this task's dispatch):
  // because the salt rotates daily and is never reused, yesterday's
  // hash for a visitor cannot be linked forward to today's — there is no
  // cross-day unique-visitor metric, ever. That is the same rotation
  // property as the test above, restated from the privacy side: the
  // pre-rotation hash gives no information that would let it be
  // recognised again after rotation.
  it("yesterday's hash is not recoverable from, or equal to, today's — the privacy bound 'únicos hoy' rests on", async () => {
    const getDailySalt = createDailySalt({ redis: createInMemoryDailySaltRedis(), logger: makeSpyLogger() });
    const ip = clientIp(IP_A);

    // Same "one withPinnedTz call PER read" structure as the test above,
    // for the same reason — see that test's own comment.
    const yesterday = await withPinnedTz('Europe/Berlin', () => {
      vi.useFakeTimers({ now: new Date('2026-01-05T23:30:00.000Z') });
      const result = visitorHashNow(getDailySalt, ip, UA_A);
      return result.finally(() => vi.useRealTimers());
    });

    const today = await withPinnedTz('Europe/Berlin', () => {
      vi.useFakeTimers({ now: new Date('2026-01-06T00:30:00.000Z') });
      const result = visitorHashNow(getDailySalt, ip, UA_A);
      return result.finally(() => vi.useRealTimers());
    });

    expect(today.hash).not.toBe(yesterday.hash);
  });
});

describe('visitor_hash — discriminates between visitors on the SAME UTC day (T2.3.9)', () => {
  it('two different user agents from ONE ip produce DIFFERENT visitor_hash values under the same daily salt', async () => {
    const getDailySalt = createDailySalt({ redis: createInMemoryDailySaltRedis(), logger: makeSpyLogger() });
    const ip = clientIp(IP_A);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    const forUaA = await visitorHashNow(getDailySalt, ip, UA_A);
    const forUaB = await visitorHashNow(getDailySalt, ip, UA_B);

    // Same salt (both calls land in the same UTC day, same memo entry) —
    // the difference below is attributable to the user agent alone.
    expect(forUaA.salt === forUaB.salt).toBe(true);
    expect(forUaA.hash).not.toBe(forUaB.hash);
  });

  it('two different IPs sharing ONE user agent produce DIFFERENT visitor_hash values under the same daily salt', async () => {
    const getDailySalt = createDailySalt({ redis: createInMemoryDailySaltRedis(), logger: makeSpyLogger() });
    const ipA = clientIp(IP_A);
    const ipB = clientIp(IP_B);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
    const forIpA = await visitorHashNow(getDailySalt, ipA, UA_A);
    const forIpB = await visitorHashNow(getDailySalt, ipB, UA_A);

    expect(forIpA.salt === forIpB.salt).toBe(true);
    expect(forIpA.hash).not.toBe(forIpB.hash);
  });
});

// Sanity check that this file's own fixtures produce a schema-valid
// visitor_hash shape (32 lowercase hex chars) — not a new property, just
// confirmation that the real getDailySalt()-driven pipeline this file
// exercises still yields what capture.test.ts's isolated hash-math tests
// already prove the FORMULA produces. [code-reviewer, S2.3 fan-out] The
// real check here is the toMatch() regex below. The `sampleField`
// assignment two lines down is near-vacuous as a runtime assertion:
// CaptureEvent['visitor_hash'] is plain `string | null`, so any string —
// correct shape or not — is assignable to it. It's kept only as a
// compile-time confirmation that this file's `hash` variable stays
// assignable to the contract's field type at all (catching a future
// widening of that field to something incompatible), not as evidence
// about the hash's actual shape.
describe('visitor_hash — shape sanity, driven through the real salt manager', () => {
  it('is a 32-character lowercase hex string, matching CaptureEvent\'s own visitor_hash field shape', async () => {
    const getDailySalt = createDailySalt({ redis: createInMemoryDailySaltRedis(), logger: makeSpyLogger() });
    const ip = clientIp(IP_A);

    const { hash } = await visitorHashNow(getDailySalt, ip, UA_A);

    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    const sampleField: CaptureEvent['visitor_hash'] = hash;
    expect(sampleField).toBe(hash);
  });
});
