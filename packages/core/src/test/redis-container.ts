import type Redis from 'ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { createRedisClient } from '../redis/client';
import { closeBoth, describeError } from './container-cleanup';

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

/**
 * Closes the ioredis client AND stops the container, unconditionally
 * attempting both even if the first fails — same reasoning as
 * pg-container.ts's closeClientAndContainer: a plain sequential
 * `await client.quit(); await container.stop();` would leak the container
 * whenever `quit()` throws, since the second call would never run. If both
 * fail, both messages are reported (never just the first, silently
 * dropping the second). The attempt-both/report-both shape itself lives in
 * ./container-cleanup.ts (T2.2.7 fix round 1) — shared with
 * pg-container.ts's identical need — this function is just the
 * Redis-shaped call into it.
 */
async function closeClientAndContainer(
  client: Redis,
  container: StartedRedisContainer,
): Promise<void> {
  await closeBoth(
    'Redis',
    { label: 'client.quit()', run: () => client.quit() },
    { label: 'container.stop()', run: () => container.stop() },
  );
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
 *
 * [S2.2 story-fan-out review, carried bug] `client.connect()` is wrapped
 * in a try/catch that tears the container down before rethrowing —
 * mirrors pg-container.ts's identical migration-failure cleanup. Without
 * this, a `connect()` failure (reproduced at 9/54 concurrent runs via a
 * dual-stack `localhost` race — the client resolves `localhost` to an
 * address family the container isn't listening on for that attempt) both
 * fails the caller AND leaves the already-started container running:
 * nothing else in this function's caller ever gets a chance to call
 * `stop()` on a handle that was never returned. S2.6's entire invariant
 * suite depends on this harness, so an unclosed leak here becomes a
 * CI-wide, compounding cost, not a one-test flake.
 *
 * Deliberately `client.disconnect()`, NOT `client.quit()`, in this one
 * cleanup path — the only difference from pg-container.ts's shape, and
 * for a reason specific to Redis: `quit()` sends a graceful `QUIT` and
 * waits for it to round-trip over an established connection, which is
 * exactly what a client whose `connect()` just rejected never achieved.
 * `../redis/client.ts`'s own `closeRedis()` already documents and avoids
 * this identical trap for a client stuck in ioredis's `wait`/`end`
 * status: `disconnect()` is synchronous local teardown with no network
 * I/O, so — unlike `quit()` here — it cannot itself hang waiting on the
 * very connection that just failed, which would silently reintroduce the
 * leak this fix exists to close (closeBoth awaits its first step before
 * attempting the second, so a HANGING first step would still block
 * `container.stop()` forever).
 *
 * No retry is added for the dual-stack race itself: a bounded retry that
 * papered over an intermittent connect failure without first fixing the
 * leak underneath it would hide the more important bug, not fix it.
 */
export async function startRedisContainer(): Promise<RedisContainerHandle> {
  const container: StartedRedisContainer = await new RedisContainer(REDIS_IMAGE).start();
  const url = container.getConnectionUrl();

  const client = createRedisClient({ url, lazyConnect: true });

  try {
    await client.connect();
  } catch (error) {
    await closeBoth(
      'Redis',
      { label: 'client.disconnect()', run: async () => client.disconnect() },
      { label: 'container.stop()', run: () => container.stop() },
    ).catch(() => undefined);
    throw new Error(
      `Failed to connect to the testcontainers Redis at ${url}: ${describeError(error)}`,
    );
  }

  return {
    client,
    url,
    stop: () => closeClientAndContainer(client, container),
  };
}
