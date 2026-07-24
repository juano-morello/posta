import { afterEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { closeRedis, createRedisClient, getRedis } from './client';

// T2.1.3 — the Redis seam every later E2 task shares. Scoped deliberately
// like tests/infra/redis-policy.test.ts's own "no server needed" half:
// every client here is constructed with `lazyConnect: true`, so no test
// in this file ever opens a real socket — no command is ever sent, only
// `client.options` is read back. The live-Redis half of T2.1.3's verify
// line (a real PING against the compose Redis returning PONG) is
// out of scope for this task per the batch dispatch notes; it lands with
// T2.6.1's integration harness, which is the first consumer that
// actually issues commands against these clients.

const TEST_URL = 'redis://localhost:6379';

/** Every client this file builds passes `lazyConnect: true` so
 * construction never opens a socket; this local helper is the ONE place
 * that default lives, so no test can forget it and silently start
 * dialing out. */
function freshTestClient(url: string = TEST_URL): Redis {
  return createRedisClient({ url, lazyConnect: true });
}

afterEach(async () => {
  // getRedis's memoized singleton is process-wide, so it must not leak
  // between tests. Every client in this suite is lazyConnect and never
  // issues a command, so it stays in ioredis's 'wait' status — closeRedis()
  // takes the disconnect() branch for that status (see client.ts), which
  // is synchronous local cleanup with no network I/O, so this is safe to
  // run unconditionally after every test.
  await closeRedis();
});

describe('createRedisClient (T2.1.3)', () => {
  it('builds a client from an explicit url', () => {
    const client = freshTestClient('redis://explicit-host:6379');
    expect(client.options.host).toBe('explicit-host');
    expect(client.options.port).toBe(6379);
    client.disconnect();
  });

  it('sets maxRetriesPerRequest: 1, so a dead Redis fails a command fast', () => {
    const client = freshTestClient();
    expect(client.options.maxRetriesPerRequest).toBe(1);
    client.disconnect();
  });

  it('sets enableOfflineQueue: false, so commands never queue behind a reconnect', () => {
    const client = freshTestClient();
    expect(client.options.enableOfflineQueue).toBe(false);
    client.disconnect();
  });

  it('returns a FRESH client on every call, never memoized', () => {
    const first = freshTestClient();
    const second = freshTestClient();
    expect(first).not.toBe(second);
    first.disconnect();
    second.disconnect();
  });

  describe('when no url is passed and REDIS_URL is unset', () => {
    it('throws a clear error naming REDIS_URL', () => {
      const originalRedisUrl = process.env.REDIS_URL;
      delete process.env.REDIS_URL;

      try {
        expect(() => createRedisClient({ lazyConnect: true })).toThrow(/REDIS_URL/);
      } finally {
        if (originalRedisUrl === undefined) {
          delete process.env.REDIS_URL;
        } else {
          process.env.REDIS_URL = originalRedisUrl;
        }
      }
    });
  });

  describe('when url is omitted but REDIS_URL is set in env', () => {
    it('falls back to the env value', () => {
      const originalRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://from-env:6379';

      let client: Redis | undefined;
      try {
        client = createRedisClient({ lazyConnect: true });
        expect(client.options.host).toBe('from-env');
      } finally {
        client?.disconnect();
        if (originalRedisUrl === undefined) {
          delete process.env.REDIS_URL;
        } else {
          process.env.REDIS_URL = originalRedisUrl;
        }
      }
    });
  });
});

describe('getRedis (T2.1.3)', () => {
  it('returns the SAME instance on repeated calls (the hot path memoizes on this)', () => {
    const first = getRedis({ url: TEST_URL, lazyConnect: true });
    const second = getRedis({ url: TEST_URL, lazyConnect: true });
    expect(first).toBe(second);
  });

  it('ignores options passed after the first call — the singleton is already built', () => {
    const first = getRedis({ url: TEST_URL, lazyConnect: true });
    const second = getRedis({ url: 'redis://a-different-host:6379', lazyConnect: true });
    expect(second).toBe(first);
    expect(second.options.host).toBe('localhost');
  });
});

describe('closeRedis (T2.1.3)', () => {
  it('is a no-op when getRedis was never called', async () => {
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  it('clears the memoized singleton, so a later getRedis() builds a new client', async () => {
    const first = getRedis({ url: TEST_URL, lazyConnect: true });

    await closeRedis();

    const second = getRedis({ url: TEST_URL, lazyConnect: true });
    expect(second).not.toBe(first);
  });

  it('disconnects a client that never connected without sending a real command', async () => {
    const client = getRedis({ url: TEST_URL, lazyConnect: true });
    expect(client.status).toBe('wait');
    const quitSpy = vi.spyOn(client, 'quit');

    await closeRedis();

    // The 'wait' branch tears down local state via disconnect(), never
    // quit() — quit() would itself open the connection this client never
    // needed, just to close it again.
    expect(quitSpy).not.toHaveBeenCalled();
    expect(client.status).toBe('end');
  });

  it('calls quit() on a client that is connected or connecting, to drain gracefully', async () => {
    const client = getRedis({ url: TEST_URL, lazyConnect: true });
    // Force the client past 'wait' without opening a real socket by
    // stubbing quit() to resolve immediately, then flipping status the
    // same way ioredis itself would once a connection attempt begins —
    // asserts closeRedis()'s OTHER branch without ever touching the
    // network, matching this file's "no test opens a socket" rule.
    const quitSpy = vi.spyOn(client, 'quit').mockImplementation(async () => {
      return 'OK';
    });
    Object.defineProperty(client, 'status', { value: 'connecting', configurable: true });

    await closeRedis();

    expect(quitSpy).toHaveBeenCalledOnce();
  });
});
