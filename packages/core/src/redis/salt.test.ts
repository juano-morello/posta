import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRedisContainer, type RedisContainerHandle } from '../test/redis-container';
import { saltKey } from './keys';
import { createDailySalt, type DailySaltLogger, type DailySaltRedis } from './salt';
import { withPinnedTz } from './test-support';

// T2.3.6 — the daily visitor-hash salt (invariant 6, story S2.3). Split
// deliberately across two Redis doubles, mirroring resolve-tenant.test.ts's
// own split (a REAL Postgres for the tier whose correctness a mock could
// paper over, a recording double for call-count assertions):
//
//   - REAL Redis (testcontainers, ../test/redis-container.ts) for the two
//     assertions that are genuinely Redis semantics — SET NX's atomicity
//     under real concurrency, and a real TTL reply — which a double cannot
//     prove, only assert its own fake implementation of.
//   - A fake DailySaltRedis (an in-memory Map, actually implementing NX
//     semantics) for every other case: call-count assertions, the outage
//     fallback, and hex-format/rotation checks are all about THIS file's
//     own logic, not Redis's.
//
// Fake-timer discipline: vi.useFakeTimers() is used ONLY around the
// rotation test below, which runs entirely against the in-memory fake —
// never while a real container test is awaiting actual network I/O. This
// codebase carries an explicit warning about that combination
// (apps/api/src/redirect/resolve-tenant.test.ts's memo-expiry test,
// resolve-link-tombstone.test.ts's TTL-wait test): fake timers must never
// be active while a real Postgres/Redis call is in flight.

const CONTAINER_TEST_TIMEOUT_MS = 120_000;

/**
 * The exact shape of DailySaltLogger#error, spelled out so
 * `vi.fn<LoggerErrorFn>()` produces a Mock whose call signature is
 * structurally assignable to DailySaltLogger — an untyped `vi.fn()` infers
 * `(...args: any[]) => any`, which typechecks at the call site but fails
 * `tsc --noEmit -p tsconfig.test.json` (the separate, stricter typecheck
 * pass) when assigned to the interface. Mirrors
 * apps/api/src/redirect/resolve-test-support.ts's identical LoggerWarnFn
 * fix for ResolveLogger#warn.
 */
type LoggerErrorFn = (message: string, meta?: Record<string, unknown>) => void;

function makeSpyLogger(): DailySaltLogger & { error: ReturnType<typeof vi.fn<LoggerErrorFn>> } {
  return { error: vi.fn<LoggerErrorFn>() };
}

/**
 * An in-memory double for DailySaltRedis that actually implements SET NX
 * semantics (only writes when the key is absent) — not just a recording
 * Map, since this file's own convergence logic (memoizing the in-flight
 * promise) is exercised in-process by several cases below and needs a
 * double that behaves like Redis would, not one that always overwrites.
 * `failSet`/`failGet` make the NEXT call to that command reject, for the
 * outage-fallback cases.
 */
function makeFakeSaltRedis(): DailySaltRedis & {
  readonly setCalls: ReadonlyArray<{ key: string; value: string }>;
  readonly getCalls: readonly string[];
  failNextSet(): void;
  failNextGet(): void;
} {
  const store = new Map<string, string>();
  const setCalls: Array<{ key: string; value: string }> = [];
  const getCalls: string[] = [];
  let shouldFailNextSet = false;
  let shouldFailNextGet = false;

  return {
    setCalls,
    getCalls,
    failNextSet() {
      shouldFailNextSet = true;
    },
    failNextGet() {
      shouldFailNextGet = true;
    },
    // Fewer params than DailySaltRedis#set declares — TypeScript allows a
    // function with fewer parameters to satisfy a wider function type (the
    // caller always passes all five; this double just never needs to
    // inspect the EX/seconds/NX arguments beyond hard-coding NX semantics
    // below), so there is nothing here for @typescript-eslint/no-unused-vars
    // to flag.
    async set(key, value) {
      setCalls.push({ key, value });
      if (shouldFailNextSet) {
        shouldFailNextSet = false;
        throw new Error('simulated Redis SET failure');
      }
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      getCalls.push(key);
      if (shouldFailNextGet) {
        shouldFailNextGet = false;
        throw new Error('simulated Redis GET failure');
      }
      return store.get(key) ?? null;
    },
  };
}

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

describe('createDailySalt — in-process behaviour (T2.3.6)', () => {
  it('returns a 64-character lowercase hex salt', async () => {
    const getDailySalt = createDailySalt({ redis: makeFakeSaltRedis(), logger: makeSpyLogger() });

    const salt = await getDailySalt();

    expect(salt).toMatch(HEX_64_PATTERN);
  });

  it('a second call issues no Redis command at all — the memo serves it', async () => {
    const redis = makeFakeSaltRedis();
    const getDailySalt = createDailySalt({ redis, logger: makeSpyLogger() });

    const first = await getDailySalt();
    const setCallsAfterFirst = redis.setCalls.length;
    const getCallsAfterFirst = redis.getCalls.length;

    const second = await getDailySalt();

    expect(second).toBe(first);
    expect(redis.setCalls.length).toBe(setCallsAfterFirst);
    expect(redis.getCalls.length).toBe(getCallsAfterFirst);
  });

  it('two different UTC days produce different salts', async () => {
    const redis = makeFakeSaltRedis();
    const getDailySalt = createDailySalt({ redis, logger: makeSpyLogger() });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
      const day1 = await getDailySalt();

      vi.setSystemTime(new Date('2026-03-02T12:00:00.000Z'));
      const day2 = await getDailySalt();

      expect(day1).not.toBe(day2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rotates across the UTC midnight boundary even under a positive-offset local timezone', async () => {
    // Pinned to Europe/Berlin, same reasoning as keys.test.ts's own
    // formatUtcDate/saltKey UTC-vs-local cases (see withPinnedTz's own doc
    // comment): 23:30 UTC on Jan 5 is already Jan 6 in Berlin, so this is
    // the instant that actually distinguishes a UTC formatter from a local
    // one — a broken implementation using getFullYear()/getMonth()/getDate()
    // would report Jan 5 and Jan 6 (Berlin-local) as the SAME UTC day here
    // and wrongly reuse one salt across the real UTC boundary.
    //
    // [T2.3.9 fan-out finding] Each instant gets its OWN withPinnedTz call
    // below — do NOT hoist one pin around both setSystemTime()/read pairs.
    // An earlier draft held a SINGLE withPinnedTz around both reads and
    // passed unchanged against a deliberately broken (local-getter)
    // formatUtcDate: a @sinonjs/fake-timers/Node interaction makes a
    // SECOND local-getter read inside one held pin silently return a stale
    // result instead of reflecting the new vi.setSystemTime() instant, even
    // though process.env.TZ itself never changed in between. Calling
    // withPinnedTz again per instant forces a genuine reassignment of
    // process.env.TZ immediately before each read, which is what clears
    // the staleness — see withPinnedTz's own doc comment (test-support.ts)
    // for the fuller account.
    const redis = makeFakeSaltRedis();
    const getDailySalt = createDailySalt({ redis, logger: makeSpyLogger() });

    vi.useFakeTimers();
    try {
      const beforeMidnightUtc = await withPinnedTz('Europe/Berlin', () => {
        vi.setSystemTime(new Date('2026-01-05T23:30:00.000Z'));
        return getDailySalt();
      });

      const afterMidnightUtc = await withPinnedTz('Europe/Berlin', () => {
        vi.setSystemTime(new Date('2026-01-06T00:30:00.000Z'));
        return getDailySalt();
      });

      expect(beforeMidnightUtc).not.toBe(afterMidnightUtc);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('when Redis is unreachable', () => {
    it('still returns a 64-char salt, falling back to a process-local one and logging once', async () => {
      const redis = makeFakeSaltRedis();
      redis.failNextSet();
      const logger = makeSpyLogger();
      const getDailySalt = createDailySalt({ redis, logger });

      const first = await getDailySalt();
      expect(first).toMatch(HEX_64_PATTERN);
      expect(logger.error).toHaveBeenCalledTimes(1);

      // A second call the SAME day must reuse the memoised fallback rather
      // than retrying Redis (and logging again) on every request — the
      // brief's own "logging once" language is about this, not just about
      // one SET failure logging one line instead of two.
      const second = await getDailySalt();
      expect(second).toBe(first);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('never logs the generated salt itself', async () => {
      const redis = makeFakeSaltRedis();
      redis.failNextSet();
      const logger = makeSpyLogger();
      const getDailySalt = createDailySalt({ redis, logger });

      const salt = await getDailySalt();

      const loggedText = JSON.stringify(logger.error.mock.calls);
      expect(loggedText).not.toContain(salt);
    });

    it('a GET failure after a successful SET also falls back, logging exactly once', async () => {
      const redis = makeFakeSaltRedis();
      redis.failNextGet();
      const logger = makeSpyLogger();
      const getDailySalt = createDailySalt({ redis, logger });

      const salt = await getDailySalt();

      expect(salt).toMatch(HEX_64_PATTERN);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createDailySalt — real Redis (T2.3.6)', () => {
  let handle: RedisContainerHandle;

  beforeAll(async () => {
    handle = await startRedisContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    await handle.client.flushdb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('50 concurrent calls converge on one identical salt with exactly one SET NX issued', async () => {
    const logger = makeSpyLogger();
    const getDailySalt = createDailySalt({ redis: handle.client, logger });
    const setSpy = vi.spyOn(handle.client, 'set');

    const results = await Promise.all(Array.from({ length: 50 }, () => getDailySalt()));

    const distinctSalts = new Set(results);
    expect(distinctSalts.size).toBe(1);
    expect([...distinctSalts][0]).toMatch(HEX_64_PATTERN);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("the key's TTL is within 60 seconds of 172800 (48h)", async () => {
    const logger = makeSpyLogger();
    const getDailySalt = createDailySalt({ redis: handle.client, logger });

    await getDailySalt();

    const key = saltKey(new Date());
    const ttl = await handle.client.ttl(key);

    expect(ttl).toBeGreaterThan(0);
    expect(Math.abs(ttl - 172_800)).toBeLessThanOrEqual(60);
  });

  it('a second instance racing after the first has already written reads back the SAME salt', async () => {
    const logger = makeSpyLogger();
    const first = createDailySalt({ redis: handle.client, logger });
    const winner = await first();

    // A brand new createDailySalt — a fresh process-local memo, same
    // shared Redis — models a SECOND API instance rather than a second
    // call on the same one; it must read the first instance's winning
    // value via GET, never write its own.
    const second = createDailySalt({ redis: handle.client, logger });
    const setSpy = vi.spyOn(handle.client, 'set');
    const loser = await second();

    expect(loser).toBe(winner);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
