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
    'returns a real, working client, and stop() actually tears the container down',
    async () => {
      const handle = await startRedisContainer();

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
    '[S2.2 story-fan-out review, carried bug] stops the already-started container when client.connect() rejects, instead of leaking it',
    async () => {
      // vi.spyOn without an explicit mock implementation still calls
      // through to the REAL RedisContainer#start — this only intercepts
      // the return value so the test can independently verify what
      // happened to the container AFTER startRedisContainer's own catch
      // block has already run and thrown, since a thrown Error carries
      // no reference to the container it was cleaning up.
      const startSpy = vi.spyOn(RedisContainer.prototype, 'start');

      // Forces the FIRST client.connect() ioredis performs to reject —
      // simulating the dual-stack `localhost` race the review reproduced
      // at 9/54 concurrent runs, without depending on that race actually
      // firing here. `mockRejectedValueOnce` affects exactly the one
      // call startRedisContainer makes; it is restored (see the finally
      // block) before the verification client below makes its own,
      // unaffected connect() call.
      const connectSpy = vi
        .spyOn(Redis.prototype, 'connect')
        .mockRejectedValueOnce(new Error('simulated dual-stack connect failure'));

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
      expect((capturedError as Error).message).toContain('simulated dual-stack connect failure');

      expect(startSpy.mock.results).toHaveLength(1);
      const startedContainer = (await startSpy.mock.results[0]!.value) as StartedRedisContainer;
      startSpy.mockRestore();

      // The real proof, not a mock-call assertion: a FRESH client
      // attempting to connect to the SAME url the (allegedly stopped)
      // container was using must be refused. Before this fix, this
      // connection would SUCCEED — the container would still be running,
      // because startRedisContainer's original code never called
      // container.stop() on a connect() failure at all.
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
