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
      client = new Redis(REDIS_URL as string, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // fail fast — never hang the run retrying
      });
    });

    afterAll(async () => {
      await client.quit();
    });

    it(`the running Redis's maxmemory-policy is genuinely "${REQUIRED_POLICY}", not a provider default`, async () => {
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
    });
  });
});
