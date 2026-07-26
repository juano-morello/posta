import Redis from 'ioredis';

// T2.1.3 — the Redis seam every later E2 task shares. Redis does double
// duty on one instance: the hot link/salt cache (TTL'd keys, spec §9)
// AND the BullMQ event bus (no TTL, T2.4.2) — this module owns neither
// of those concerns, only the connection itself.
//
// `maxRetriesPerRequest: 1` and `enableOfflineQueue: false` are fixed,
// not configurable through {@link RedisClientOptions}: invariant 1 ("a
// redirect never blocks on analytics") requires a dead Redis to fail a
// command FAST, not queue it behind ioredis's own reconnect loop — a
// caller opting into the default (unbounded retries, offline queueing)
// would silently reintroduce the exact blocking this seam exists to
// prevent.
//
// Singleton vs factory, reconciled: db/client.ts's createDbClient() is
// deliberately NOT a module-level singleton (T1.1.1) — the testcontainers
// harness needs a fresh pool per booted container on a dynamically
// assigned port, and a singleton built at import time would bind to
// whatever DATABASE_URL happened to be set first. The redirect hot path
// (T2.1.4) has the opposite need: ONE already-connected client, built
// once at boot, closed over by every request with zero per-request
// instantiation [INV-2]. Both are true at once, so both are exported:
//
//   - createRedisClient(options) — a FRESH ioredis client every call.
//     What tests and the future T2.6.1 container harness use, same role
//     createDbClient() plays for Postgres.
//   - getRedis(options?) — a process-wide memoized instance, built via
//     createRedisClient() the first time it is called. What main.ts
//     calls once at boot (T2.1.4) and every hot-path request closes
//     over; `options` is only consulted on that first call.
//   - closeRedis() — closes and clears the memoized instance, so a
//     later getRedis() call builds a brand new client. Primarily test
//     teardown's job here; T0.7.8's SIGTERM handler is the production
//     caller.

export interface RedisClientOptions {
  /** Defaults to `process.env.REDIS_URL` when omitted. */
  readonly url?: string;
  /**
   * ioredis's own `lazyConnect`. Left unset in production (ioredis's own
   * default, `false`) so the client the hot path closes over starts
   * connecting the instant it is constructed — T2.1.4 awaits readiness
   * once, at boot, never per-request. Tests pass `true` explicitly so
   * constructing a client never opens a real socket; this task's own
   * suite has no live Redis to connect to.
   */
  readonly lazyConnect?: boolean;
}

function resolveUrl(options: RedisClientOptions): string {
  const url = options.url ?? process.env.REDIS_URL;

  if (!url) {
    throw new Error('REDIS_URL must be set (or pass url explicitly to createRedisClient).');
  }

  return url;
}

/**
 * Builds a fresh ioredis client from `REDIS_URL` (or `options.url`),
 * with `maxRetriesPerRequest: 1` and `enableOfflineQueue: false` fixed
 * (see this file's header). Never memoized — callers that want the
 * process-wide singleton the hot path uses should call {@link getRedis}
 * instead.
 */
export function createRedisClient(options: RedisClientOptions = {}): Redis {
  const url = resolveUrl(options);

  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // `?? false` restates ioredis's own default explicitly rather than
    // omitting the key — functionally identical, but keeps this options
    // object honest about every field it sets instead of leaving one
    // implicit.
    lazyConnect: options.lazyConnect ?? false,
  });
}

let memoizedClient: Redis | undefined;

/**
 * The process-wide singleton the redirect hot path closes over at boot
 * (T2.1.4). Builds the client via {@link createRedisClient} on the first
 * call and returns that SAME instance on every call after — `options` is
 * only consulted the first time; a later call with different options
 * before {@link closeRedis} runs is a no-op on those options, the same
 * way any singleton getter behaves.
 */
export function getRedis(options?: RedisClientOptions): Redis {
  if (!memoizedClient) {
    memoizedClient = createRedisClient(options);
  }

  return memoizedClient;
}

/**
 * Closes the memoized singleton and clears it, so the next
 * {@link getRedis} call builds a brand new client. A no-op if
 * {@link getRedis} was never called.
 *
 * Uses `quit()` (graceful — sends `QUIT`, waits for in-flight replies)
 * only once the client is actually connected or connecting. A client
 * still in ioredis's `wait` status (constructed with `lazyConnect` and
 * never issued a command — every client this package's own tests build)
 * or already `end` has no in-flight work to drain, and `quit()` would
 * itself open a connection this client never needed, purely to close it
 * again. `disconnect()` tears down local state instead, with no network
 * I/O — which is also what keeps this test-safe with no Redis running.
 */
export async function closeRedis(): Promise<void> {
  if (!memoizedClient) return;

  const client = memoizedClient;
  memoizedClient = undefined;

  if (client.status === 'wait' || client.status === 'end') {
    client.disconnect();
    return;
  }

  await client.quit();
}
