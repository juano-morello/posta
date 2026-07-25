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

// [T2.2.7 dual-stack retry follow-up] Root-cause fix for the connect race
// T2.2.8's stress testing found (9/54 concurrent runs) and whose LEAK half
// was closed separately: testcontainers' own host resolution
// (node_modules/testcontainers/build/container-runtime/utils/resolve-host.js)
// returns the literal STRING `"localhost"` for a local, non-remote Docker
// daemon — never an IP. Node's own dual-stack ("Happy Eyeballs") DNS
// resolution of that string races an IPv4 (127.0.0.1) and an IPv6 (::1)
// connection attempt. This harness's container (like docker-compose.yml's
// own redis service) is reachable on the IPv4 loopback; under concurrent
// Docker port-forward load from several container-booting test files
// running at once (vitest's default file parallelism — the flake was
// never seen under a sequential single-file run), the IPv6 half of that
// race can transiently lose, and ioredis surfaces that as a rejected
// `connect()` even though the IPv4 half would have succeeded.
//
// Connecting to `127.0.0.1` explicitly removes the ambiguous resolution —
// and therefore the race — at its root, rather than retrying around it:
// there is no longer a DNS lookup with two candidate addresses to race in
// the first place. Left untouched for any OTHER hostname (a remote Docker
// host via TESTCONTAINERS_HOST_OVERRIDE, for instance): forcing
// `127.0.0.1` there would be actively wrong, not just unnecessary.
function toIpv4LoopbackUrl(connectionUrl: string): string {
  const url = new URL(connectionUrl);
  if (url.hostname === 'localhost') {
    url.hostname = '127.0.0.1';
  }
  return url.toString();
}

// Bounded connect retry — defense in depth ON TOP OF toIpv4LoopbackUrl
// above, not instead of it: the address fix removes the SPECIFIC
// dual-stack race, but a small bounded retry still tolerates other
// genuinely transient connect failures (e.g. Docker's own port-forward not
// yet accepting connections in the instant right after the container
// reports itself started) the same way a real deployment's own startup
// probe would tolerate one bad dial. Small and bounded on purpose: a
// retry loop that ran indefinitely would turn a genuine Redis outage into
// a hung test instead of a loud, fast failure.
const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 100;

/**
 * Connects a FRESH ioredis client to `url`, retrying up to
 * {@link CONNECT_RETRY_ATTEMPTS} times with a linear backoff between
 * attempts. Mirrors apps/api/src/redirect/resolve-degraded.test.ts's own
 * `connectDegradedClient` (T2.2.8), which solved the identical problem for
 * a different call site — same shape here, deliberately, rather than a
 * third pattern: a brand NEW client every attempt (never reusing one that
 * just failed — ioredis's own connection state after a failed `connect()`
 * is not something a caller should trust to retry cleanly), a no-op
 * `'error'` listener attached BEFORE `connect()` is awaited (ioredis's own
 * `silentEmit` still `console.error`s an "Unhandled error event" for a
 * failed attempt with no listener, even though it doesn't crash the
 * process — this keeps a legitimately-retried attempt's output clean, not
 * just non-fatal), and `client.disconnect()` — never `quit()` — on a
 * failed attempt, for the same reason `startRedisContainer`'s original
 * connect-failure cleanup does: `quit()` sends a graceful `QUIT` and waits
 * for it to round-trip over an established connection, which a client
 * whose `connect()` just rejected never achieved.
 *
 * On exhausting every attempt, throws with the URL, the attempt count, and
 * the LAST attempt's own underlying error — a genuine Redis outage stays
 * loud and fast, rather than being retried into a generic, contextless
 * timeout.
 */
async function connectWithRetry(url: string): Promise<Redis> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    const client = createRedisClient({ url, lazyConnect: true });
    client.on('error', () => {});

    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      client.disconnect();
      if (attempt < CONNECT_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS * attempt));
      }
    }
  }

  throw new Error(
    `Failed to connect to the testcontainers Redis at ${url} after ${CONNECT_RETRY_ATTEMPTS} ` +
      `attempts: ${describeError(lastError)}`,
  );
}

/**
 * Boots a fresh Redis 7 container and returns a handle whose `client` is a
 * REAL, already-connected ioredis client — never a mock. Callers own the
 * handle's lifecycle: always call `stop()` (typically from an `afterAll`),
 * or the container and its client outlive the test run.
 *
 * `url` is rewritten via {@link toIpv4LoopbackUrl} before anything connects
 * to it — including the retry loop below — and is the SAME rewritten URL
 * returned on the handle, so a caller building its own second client
 * against `handle.url` (resolve-degraded.test.ts's `connectDegradedClient`
 * does exactly this, deliberately, to get a client `stop()` never
 * gracefully `quit()`s) inherits the identical fix rather than needing a
 * second copy of it.
 *
 * Built with `lazyConnect: true` inside {@link connectWithRetry} rather
 * than the default (immediate, implicit connect) `createRedisClient` path
 * production uses: `client.ts`'s `createRedisClient` also sets
 * `enableOfflineQueue: false` (invariant 1's fast-fail requirement), and
 * without waiting for the connection to actually reach `ready` first, the
 * very first command this handle's caller issues could race the socket
 * handshake and be rejected outright instead of running against a live
 * container.
 *
 * [S2.2 story-fan-out review, dual-stack retry follow-up] If every retry
 * attempt still fails — a genuine Redis outage, not the transient race
 * {@link toIpv4LoopbackUrl} and the retry loop exist to tolerate — the
 * already-started container is stopped before rethrowing, mirroring
 * pg-container.ts's identical migration-failure cleanup: without this, the
 * caller never receives a handle to call `stop()` on, and the container
 * leaks. `connectWithRetry` already disconnects every FAILED attempt's own
 * client as it goes (see its own doc comment), so there is no client left
 * to close here — only the container. Deliberately NOT routed through
 * {@link closeBoth}: that helper's contract is "attempt both, unconditionally
 * — a `run()` that hasn't actually happened yet". Here, the connect
 * failure has ALREADY happened by the time this catch block runs, and only
 * one further step (`container.stop()`) remains conditionally worth
 * attempting — forcing that shape through `closeBoth` would need a fake
 * pre-rejected "step" standing in for work already done, which is more
 * confusing than the two three-line try/catches below. A `container.stop()`
 * failure on top of the connect failure is still reported ALONGSIDE it,
 * not silently dropped — same discipline, simpler shape for a step that
 * isn't symmetric.
 */
export async function startRedisContainer(): Promise<RedisContainerHandle> {
  const container: StartedRedisContainer = await new RedisContainer(REDIS_IMAGE).start();
  const url = toIpv4LoopbackUrl(container.getConnectionUrl());

  let client: Redis;
  try {
    client = await connectWithRetry(url);
  } catch (connectError) {
    let stopError: unknown;
    try {
      await container.stop();
    } catch (error) {
      stopError = error;
    }

    if (stopError) {
      throw new Error(
        `${describeError(connectError)} Additionally failed to stop the already-started ` +
          `container afterward: ${describeError(stopError)}.`,
      );
    }
    throw connectError;
  }

  return {
    client,
    url,
    stop: () => closeClientAndContainer(client, container),
  };
}
