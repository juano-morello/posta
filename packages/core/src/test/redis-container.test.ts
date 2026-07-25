import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { startRedisContainer } from './redis-container';

// T2.2.7's redis-container.ts had no direct test file of its own before
// this one — it was only exercised indirectly via
// packages/core/src/redis/invalidate.test.ts's happy path. This file
// adds that direct coverage AND, specifically, proves the S2.2
// story-fan-out review's "carried bug" fix: a `client.connect()` failure
// must stop the already-started container, not leak it.
//
// [Dual-stack retry follow-up] T2.2.8's stress testing found a SECOND,
// real bug on top of the leak: a bare `client.connect()` with no retry can
// itself transiently fail (a dual-stack `localhost` DNS race under
// concurrent Docker port-forward load — reproduced at 9/54 concurrent
// runs), and redis-container.ts now both fixes that race at its root
// (connecting to the IPv4 loopback explicitly, never the ambiguous
// `localhost` string) AND retries a bounded number of times as defense in
// depth. That changes what "client.connect() rejects" proves: ONE
// rejection is now an EXPECTED, RECOVERABLE case (the retry test below),
// not an immediate failure — only EXHAUSTING every retry attempt still
// represents a genuine outage, so the leak-proving test below now forces
// every attempt to reject, not just the first.

const CONTAINER_TEST_TIMEOUT_MS = 120_000;

/** A bounded, fast-failing verification client — `retryStrategy: () =>
 * null` stops ioredis's own reconnect loop after the first failure, and
 * `connectTimeout` bounds how long a single connect attempt waits before
 * giving up, so a genuinely-stopped container's closed port produces a
 * fast, deterministic rejection (ECONNREFUSED) rather than a hang. */
function makeBoundedVerificationClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    retryStrategy: () => null,
    connectTimeout: 3_000,
  });
}

describe('startRedisContainer (T2.2.7)', () => {
  it(
    'returns a real, working client connected via the IPv4 loopback, and stop() actually tears the container down',
    async () => {
      const handle = await startRedisContainer();

      // [Dual-stack retry follow-up] The concrete, observable proof of
      // toIpv4LoopbackUrl's root-cause fix: the handle's own url must
      // never carry the ambiguous "localhost" hostname that raced two
      // address families in the first place.
      expect(new URL(handle.url).hostname).toBe('127.0.0.1');

      await handle.client.set('smoke-test-key', 'smoke-test-value');
      expect(await handle.client.get('smoke-test-key')).toBe('smoke-test-value');

      const { url } = handle;
      await handle.stop();

      // Proves stop() does not merely close the CLIENT side of the
      // connection — the container itself must actually be gone, or a
      // fresh client pointed at the same url would still succeed.
      const verifyClient = makeBoundedVerificationClient(url);
      try {
        await expect(verifyClient.connect()).rejects.toThrow();
      } finally {
        verifyClient.disconnect();
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    '[Dual-stack retry follow-up] recovers from a single transient connect failure without leaking a client or the container',
    async () => {
      // Only the FIRST client.connect() ioredis performs rejects — every
      // later call (the retry loop's 2nd attempt, or anything after this
      // spy is restored) goes through the real implementation. This is
      // the scenario the retry loop exists for: a one-off dual-stack race
      // on attempt 1 that a fresh attempt 2 simply doesn't hit.
      const connectSpy = vi
        .spyOn(Redis.prototype, 'connect')
        .mockRejectedValueOnce(new Error('simulated one-off dual-stack race'));

      let handle: Awaited<ReturnType<typeof startRedisContainer>> | undefined;
      try {
        handle = await startRedisContainer();
        // The real proof of "recovered", not a mock-call count: the
        // returned client actually works against the real container.
        expect(await handle.client.ping()).toBe('PONG');
      } finally {
        connectSpy.mockRestore();
        await handle?.stop();
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it(
    '[S2.2 story-fan-out review, carried bug + dual-stack retry follow-up] stops the already-started container when every connect retry is exhausted, instead of leaking it',
    async () => {
      // vi.spyOn without an explicit mock implementation still calls
      // through to the REAL RedisContainer#start — this only intercepts
      // the return value so the test can independently verify what
      // happened to the container AFTER startRedisContainer's own catch
      // block has already run and thrown, since a thrown Error carries
      // no reference to the container it was cleaning up.
      const startSpy = vi.spyOn(RedisContainer.prototype, 'start');

      // mockRejectedValue (persistent, NOT mockRejectedValueOnce) rejects
      // EVERY client.connect() call, including every attempt the retry
      // loop inside startRedisContainer makes with a brand-new client each
      // time — genuinely exhausting the retry, the only way to reach the
      // "every attempt fails" branch this test proves cleans up after
      // itself. It is restored (see the finally block) before the
      // verification client below makes its own, unaffected connect()
      // call.
      const connectSpy = vi
        .spyOn(Redis.prototype, 'connect')
        .mockRejectedValue(new Error('simulated persistent connect failure'));

      let capturedError: unknown;
      try {
        await startRedisContainer();
      } catch (error) {
        capturedError = error;
      } finally {
        connectSpy.mockRestore();
      }

      expect(capturedError).toBeInstanceOf(Error);
      expect((capturedError as Error).message).toContain(
        'Failed to connect to the testcontainers Redis',
      );
      expect((capturedError as Error).message).toContain('simulated persistent connect failure');

      expect(startSpy.mock.results).toHaveLength(1);
      const startedContainer = (await startSpy.mock.results[0]!.value) as StartedRedisContainer;
      startSpy.mockRestore();

      // The real proof, not a mock-call assertion: a FRESH client
      // attempting to connect to the SAME url the (allegedly stopped)
      // container was using must be refused. Before the original leak
      // fix, this connection would SUCCEED — the container would still be
      // running, because startRedisContainer's very first version never
      // called container.stop() on a connect() failure at all.
      const verifyClient = makeBoundedVerificationClient(startedContainer.getConnectionUrl());
      try {
        await expect(verifyClient.connect()).rejects.toThrow();
      } finally {
        verifyClient.disconnect();
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );
});
