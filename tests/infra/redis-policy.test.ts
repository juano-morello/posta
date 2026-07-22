import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';

// T0.4.8 — INV-7 is load-bearing, not a detail. Redis does double duty as
// the TTL'd hot link cache AND the no-TTL BullMQ event bus. Under
// `allkeys-lru`, a queue backlog silently evicts its own jobs — events
// vanish with no error anywhere, because nothing else would ever notice a
// queue item disappearing. T0.4.2 sets `maxmemory-policy volatile-lru` via
// a mounted docker/redis.conf (not a CLI flag, so the value stays
// reviewable in a diff); THIS test connects to the REAL running Redis over
// REDIS_URL and reads back the REAL configured policy with `CONFIG GET` —
// never a mock, never an assertion against a stub — so a provider default
// of `allkeys-lru` (locally, or on a managed instance CI wires up per
// S0.5) fails loudly instead of silently.
//
// Deliberately no hardcoded REDIS_URL fallback: this reads exactly what
// apps/api and apps/worker read at boot (S0.3's env schemas), so "this
// test passes" and "the app would actually boot against a
// correctly-configured Redis" stay the same claim. No REDIS_URL means no
// real Redis to check against — that is a failure worth surfacing loudly,
// not something to paper over with a default that could silently point at
// the wrong instance.

const REDIS_URL = process.env.REDIS_URL;
const REQUIRED_POLICY = 'volatile-lru';

/** A loopback address nothing is listening on — connect() rejects almost
 * immediately (ECONNREFUSED), so this exercises the "Redis is genuinely
 * down" branch distinctly from "reachable but misconfigured". */
const UNREACHABLE_URL = 'redis://127.0.0.1:1';

function makeTestRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000, // fail fast — don't wait ioredis's 10s default against a black-holed port
    retryStrategy: () => null, // fail fast — never hang the run retrying
  });
  // lazyConnect means no socket exists yet, so no 'error' listener exists
  // until connect() is called. Without one, a connection failure emits an
  // unhandled 'error' event ON TOP OF the rejection connect() already
  // produces — ioredis would then throw a second, unrelated "Unhandled
  // error event" alongside the real one. This swallows that duplicate;
  // the real failure is still surfaced via the rejected `connect()` call
  // in assertRedisHasRequiredPolicy below.
  client.on('error', () => undefined);
  return client;
}

/** Guards teardown so a client that never connected can't mask the real
 * test failure with a teardown failure of its own: `client.quit()` on a
 * never-connected ioredis client can itself throw, which would otherwise
 * report as a second, confusing error stacked on top of the actual one. */
async function teardownTestRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  try {
    await client.quit();
  } catch {
    // Already failing/failed to connect — nothing more to clean up.
  }
}

/** Shared by both the "reachable" and "unreachable" cases below, so they
 * exercise the IDENTICAL connect-and-wrap logic — the unreachable case is
 * only a meaningful test if it fails via the same friendly wrapping the
 * reachable case's happy path relies on, not some unrelated raw error. */
async function assertRedisHasRequiredPolicy(client: Redis): Promise<void> {
  try {
    await client.connect();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not connect to the Redis at REDIS_URL. Is the local stack up ` +
        `(\`docker compose up -d --wait\`)? Original error: ${reason}`,
    );
  }

  // ioredis's CONFIG GET returns a flat [key, value] array, e.g.
  // ['maxmemory-policy', 'volatile-lru'] — never a mocked response.
  const [, actualPolicy] = await client.config('GET', 'maxmemory-policy');

  expect(actualPolicy).toBe(REQUIRED_POLICY);
}

describe('redis eviction policy (INV-7)', () => {
  if (!REDIS_URL) {
    it('fails loudly: REDIS_URL is not set, so the live maxmemory-policy cannot be verified', () => {
      throw new Error(
        'REDIS_URL is not set. Start the local stack (`pnpm dev` or ' +
          '`docker compose up -d --wait`) and copy REDIS_URL from .env.example ' +
          'into your .env, or (in CI) wire a Redis service container and export ' +
          'REDIS_URL for this test job (S0.5).',
      );
    });
    return;
  }

  // Nested so beforeAll/afterAll/it are only ever REGISTERED when REDIS_URL
  // is present, instead of being defined-then-never-run alongside the
  // guard `it` above in the same describe scope — clearer intent, clearer
  // Vitest output. REDIS_URL is a secret (contracts' SECRET_ENV_KEYS), so
  // its raw value never appears in a describe/it name or a thrown message
  // below — only "REDIS_URL" the key name does.
  describe('when REDIS_URL is configured', () => {
    let client: Redis;

    beforeAll(() => {
      client = makeTestRedisClient(REDIS_URL as string);
    });

    afterAll(async () => {
      await teardownTestRedisClient(client);
    });

    it(`the running Redis's maxmemory-policy is genuinely "${REQUIRED_POLICY}", not a provider default`, async () => {
      await assertRedisHasRequiredPolicy(client);
    });
  });

  // The other RED case: REDIS_URL is set but nothing is listening (Redis
  // genuinely down, wrong port, stack not started). Distinct from "wrong
  // policy" above, which requires a REACHABLE Redis — this exercises the
  // connect()-rejects branch, previously untested, and proves it surfaces
  // the friendly wrapped message rather than a raw ioredis stack.
  describe('when REDIS_URL points at an unreachable Redis', () => {
    let client: Redis;

    beforeAll(() => {
      client = makeTestRedisClient(UNREACHABLE_URL);
    });

    afterAll(async () => {
      await teardownTestRedisClient(client);
    });

    it('fails loudly with the friendly connection-failure message, not a raw stack', async () => {
      await expect(assertRedisHasRequiredPolicy(client)).rejects.toThrow(/could not connect/i);
    });
  });
});
