import type Redis from 'ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { createRedisClient } from '../redis/client';

// T2.2.7 — the shared testcontainers Redis harness this task's own
// invalidate.test.ts is the first consumer of, and T2.6.1's full-app
// integration harness is the next (per this task's brief). Mirrors
// pg-container.ts's shape and cleanup discipline exactly: boots the SAME
// image docker-compose.yml pins (redis:7-alpine), hands back a REAL,
// already-connected ioredis client (never a mock), and { url, client,
// stop } — never a mock, a real Redis for every integration test that
// calls this.

const REDIS_IMAGE = 'redis:7-alpine';

export interface RedisContainerHandle {
  readonly client: Redis;
  readonly url: string;
  /** Closes the ioredis client, then stops and removes the container. */
  stop(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Closes the ioredis client AND stops the container, unconditionally
 * attempting both even if the first fails — same reasoning as
 * pg-container.ts's closeClientAndContainer: a plain sequential
 * `await client.quit(); await container.stop();` would leak the container
 * whenever `quit()` throws, since the second call would never run. If both
 * fail, both messages are reported (never just the first, silently
 * dropping the second).
 */
async function closeClientAndContainer(
  client: Redis,
  container: StartedRedisContainer,
): Promise<void> {
  let closeError: unknown;
  try {
    await client.quit();
  } catch (error) {
    closeError = error;
  }

  let stopError: unknown;
  try {
    await container.stop();
  } catch (error) {
    stopError = error;
  }

  if (closeError && stopError) {
    throw new Error(
      `Failed to clean up the testcontainers Redis: client.quit() failed with ` +
        `"${describeError(closeError)}", then container.stop() failed with ` +
        `"${describeError(stopError)}".`,
    );
  }
  if (closeError) throw closeError;
  if (stopError) throw stopError;
}

/**
 * Boots a fresh Redis 7 container and returns a handle whose `client` is a
 * REAL, already-connected ioredis client — never a mock. Callers own the
 * handle's lifecycle: always call `stop()` (typically from an `afterAll`),
 * or the container and its client outlive the test run.
 *
 * Built with `lazyConnect: true` plus an explicit `await client.connect()`
 * rather than the default (immediate, implicit connect) createRedisClient
 * path production uses: client.ts's createRedisClient also sets
 * `enableOfflineQueue: false` (invariant 1's fast-fail requirement), and
 * without waiting for the connection to actually reach `ready` first, the
 * very first command this handle's caller issues could race the socket
 * handshake and be rejected outright instead of running against a live
 * container.
 */
export async function startRedisContainer(): Promise<RedisContainerHandle> {
  const container: StartedRedisContainer = await new RedisContainer(REDIS_IMAGE).start();
  const url = container.getConnectionUrl();

  const client = createRedisClient({ url, lazyConnect: true });
  await client.connect();

  return {
    client,
    url,
    stop: () => closeClientAndContainer(client, container),
  };
}
