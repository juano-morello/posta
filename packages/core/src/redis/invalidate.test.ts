import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRedisContainer, type RedisContainerHandle } from '../test/redis-container';
import { handleKey, linkKey } from './keys';
import { invalidateHandle, invalidateLink } from './invalidate';

// T2.2.7 — the invalidation seam E5's link edit/archive/delete will call
// (E5 does not exist yet; this task defines the seam and proves it against
// a REAL Redis, not a recording double — the behaviours under test ARE
// real Redis semantics: DEL returning 1 vs 0, and a key genuinely being
// gone afterward). Boots the shared testcontainers Redis harness (this
// task's own addition, ../test/redis-container.ts) once for the whole
// file, mirroring resolve-link-tombstone.test.ts's beforeAll/afterAll
// shape around startPgContainer.

// Mirrors apps/api/src/redirect/resolve-link.ts's LINK_TOMBSTONE exactly
// (T2.2.6). Restated as a literal, not imported: packages/core has no
// dependency on apps/api (the dependency arrows in CLAUDE.md run the other
// way — api -> core, never core -> api), so the only way to reference the
// SAME sentinel value from this package is to write it again, not import
// it.
const LINK_TOMBSTONE = '\0';

const CONTAINER_TEST_TIMEOUT_MS = 120_000;

describe('invalidateLink / invalidateHandle (T2.2.7)', () => {
  let handle: RedisContainerHandle;

  beforeAll(async () => {
    handle = await startRedisContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  describe('invalidateLink', () => {
    it('deletes a cached link so the key is gone after the call', async () => {
      const key = linkKey('tenant-1', 'promo');
      await handle.client.set(
        key,
        JSON.stringify({ link_id: '01J', tenant_id: 'tenant-1', destination: 'https://example.test/promo' }),
      );

      const deleted = await invalidateLink(handle.client, 'tenant-1', 'promo');

      expect(deleted).toBe(1);
      expect(await handle.client.get(key)).toBeNull();
    });

    it('invalidating an absent key is a no-op returning 0', async () => {
      const deleted = await invalidateLink(handle.client, 'tenant-1', 'never-cached');

      expect(deleted).toBe(0);
    });

    it('deletes a T2.2.6 negative-cache tombstone too, since it lives at the same key', async () => {
      const key = linkKey('tenant-1', 'scanned-slug');
      await handle.client.set(key, LINK_TOMBSTONE);

      const deleted = await invalidateLink(handle.client, 'tenant-1', 'scanned-slug');

      expect(deleted).toBe(1);
      expect(await handle.client.get(key)).toBeNull();
    });

    it('invalidating one tenant leaves another tenant identically-slugged key untouched', async () => {
      const keyA = linkKey('tenant-a', 'promo');
      const keyB = linkKey('tenant-b', 'promo');
      await handle.client.set(keyA, 'value-a');
      await handle.client.set(keyB, 'value-b');

      const deleted = await invalidateLink(handle.client, 'tenant-a', 'promo');

      expect(deleted).toBe(1);
      expect(await handle.client.get(keyA)).toBeNull();
      expect(await handle.client.get(keyB)).toBe('value-b');
    });
  });

  describe('invalidateHandle', () => {
    it('deletes a cached handle so the key is gone after the call', async () => {
      const key = handleKey('juano');
      await handle.client.set(key, 'tenant-1');

      const deleted = await invalidateHandle(handle.client, 'juano');

      expect(deleted).toBe(1);
      expect(await handle.client.get(key)).toBeNull();
    });

    it('invalidating an absent handle is a no-op returning 0', async () => {
      const deleted = await invalidateHandle(handle.client, 'never-claimed');

      expect(deleted).toBe(0);
    });
  });
});
