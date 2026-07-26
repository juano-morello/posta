import { vi } from 'vitest';
import { links, newId, user, type DbClient } from '@posta/core';
import type { ResolveLogger } from './resolve-redis';
import type { LinkCacheWriteRedis } from './resolve-link';

/**
 * The minimal shape seedTenant/seedLink need from a testcontainers
 * handle — `db` only, structurally satisfied by the real
 * `PgContainerHandle` (`@posta/core/testing`) every `.test.ts` caller
 * actually passes. Defined locally rather than importing
 * `PgContainerHandle` by name: `@posta/core/testing` is a package.json
 * subpath export, and apps/api/tsconfig.json's PRODUCTION build uses
 * `moduleResolution: "node10"`, which cannot resolve subpath exports
 * (only `.`). `*.test.ts` files are excluded from that build (they
 * typecheck separately, under the root `tsconfig.test.json`, which does
 * support subpaths) — but THIS file is not itself named `*.test.ts` (it
 * has no `describe`/`it` blocks of its own), so it IS swept into the
 * production build and would fail to resolve `@posta/core/testing`
 * directly. Depending only on `DbClient` (the `.` export, already used
 * by resolve-tenant.ts/resolve-link.ts) sidesteps that entirely.
 */
interface DbHandle {
  readonly db: DbClient['db'];
}

// Shared between resolve-tenant.test.ts (the handle→tenant ladder,
// createResolveTenant) and resolve-link.test.ts (the link lookup and
// backfill: lookupCachedLink / resolveLinkFromDb / resolveLink) — split
// out of one file (resolve.test.ts) into two once it crossed this
// epic's 800-line hard cap (T2.2.5's fix round 1). Kept here, imported
// by both, rather than copy-pasted into each: duplicated test setup
// drifts exactly like duplicated production logic.
//
// ResolveLogger itself now lives in resolve-redis.ts (T2.2.6's fix
// round, once resolve.ts ITSELF crossed the same 800-line cap and split
// into resolve-redis.ts / resolve-tenant.ts / resolve-link.ts) rather
// than either tier-specific production file, since both tiers' deps
// shapes reference it.
//
// [T2.2.6 fix round 1] seedTenant, seedLink, LINK_REDIS_TIMEOUT_MS,
// TEST_CACHE_TTL_SECONDS and makeRecordingLinkCacheRedis moved here from
// resolve-link.test.ts once THAT file crossed the same 800-line cap and
// split by concern into resolve-link.test.ts (T2.2.3/T2.2.4/T2.2.5, the
// positive path) and resolve-link-tombstone.test.ts (T2.2.6, the
// negative cache) — both files need identical fixtures, so they live
// here rather than being copy-pasted into each, same reasoning as the
// rest of this file.

/**
 * apps/api's tests run under the ROOT vitest config's 'default' project,
 * which does not raise hookTimeout — only packages/core's own project
 * (vitest.config.ts) sets it to 120s. A cold testcontainers image pull
 * blows the 10s default, so every beforeAll/afterAll pair booting a
 * Postgres container in either split file passes this as an explicit
 * third-argument timeout.
 */
export const CONTAINER_TEST_TIMEOUT_MS = 120_000;

/**
 * The exact shape of ResolveLogger#warn, spelled out so `vi.fn<LoggerWarnFn>()`
 * produces a Mock whose call signature is structurally assignable to
 * ResolveLogger — an untyped `vi.fn()` infers `(...args: any[]) => any`,
 * which typechecks at the call site but fails `tsc --noEmit -p
 * tsconfig.test.json` (T2.6.1's separate, stricter typecheck pass) when
 * assigned to the interface. Mirrors middleware.test.ts's identical
 * LoggerErrorFn fix for RedirectMiddlewareLogger#error.
 */
export type LoggerWarnFn = (message: string, meta?: Record<string, unknown>) => void;

export function makeSpyLogger(): ResolveLogger & { warn: ReturnType<typeof vi.fn<LoggerWarnFn>> } {
  return { warn: vi.fn<LoggerWarnFn>() };
}

/** Mirrors packages/core/src/db/tenant.test.ts's own seedTenant() — a
 * `user` row doubling as tenant_id (invariant 9). No bio_pages row: the
 * link tier is reached only once a tenant_id is already known (the
 * handle→tenant ladder is resolve-tenant.test.ts's concern), so neither
 * resolve-link.test.ts nor resolve-link-tombstone.test.ts needs one.
 * `handle` is a parameter, not a variable this function closes over,
 * since each describe block that calls it boots its OWN Postgres
 * container. */
export async function seedTenant(handle: DbHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

export async function seedLink(
  handle: DbHandle,
  tenantId: string,
  slug: string,
  destination: string,
  archivedAt?: Date,
): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({
    id: linkId,
    tenantId,
    slug,
    destination,
    ...(archivedAt ? { archivedAt } : {}),
  });
  return linkId;
}

// Mirrors LINK_CACHE_TTL_SECONDS's default (.env.example / apps/api/src/env.ts)
// — resolveLink takes it as a deps field rather than hardcoding it, same
// as REDIS_LOOKUP_TIMEOUT_MS below, so production wiring (main.ts,
// outside this task's scope) is the only place the env var is read.
export const LINK_REDIS_TIMEOUT_MS = 1_000;
export const TEST_CACHE_TTL_SECONDS = 3600;

/**
 * A recording double for LinkCacheWriteRedis (get + setex), backed by an
 * in-memory Map that setex actually writes into and get actually reads
 * from — so a cold resolveLink() call's backfill is visible to a WARM
 * second call, exactly like a real Redis instance, unlike
 * makeRecordingRedis's handle-cache sibling (resolve-tenant.test.ts,
 * T2.2.2) whose tests never depend on that read-your-own-write behavior.
 *
 * [T2.2.6] `get` also honours the `seconds` TTL `setex` was given,
 * expiring an entry once the injected `now()` passes it — needed so a
 * "waiting out the TTL resolves it" test can simulate time passing for
 * the tombstone without a real 60s sleep.
 *
 * `now` defaults to `Date.now` (every T2.2.5 test uses the default: none
 * of them advance time far enough for a 3600s-TTL entry to expire) and
 * is a PARAMETER, not a hardcoded `Date.now()` call, specifically so a
 * test can inject a plain, test-controlled clock instead — see
 * resolve-link-tombstone.test.ts's TTL-expiry test. [T2.2.6 fix round 1]
 * An earlier version of that test used `vi.useFakeTimers()` /
 * `vi.advanceTimersByTime()` here instead, which a reviewer flagged as
 * fragile: this codebase's own resolve-tenant.test.ts (the memo-expiry
 * test) carries an explicit warning that fake timers must never be
 * active during real Postgres I/O, and that test's second call, after
 * the tombstone expires, genuinely falls through to a real
 * resolveLinkFromDb query. Restoring real timers before that call
 * doesn't work either: `vi.useRealTimers()` reverts `Date.now()` to the
 * actual wall clock, undoing the very advance the test needed. An
 * injected clock sidesteps the conflict entirely — real timers run
 * throughout, and only this double's OWN notion of "now" is
 * test-controlled, decoupled from vitest's fake-timer machinery.
 *
 * ⚠️ Real-Redis-TTL note (see T2.2.5's report for the full reasoning):
 * this codebase has no Redis testcontainer helper yet — that lands in
 * T2.6.1 — and that task's binding `files` line was resolve.ts/
 * resolve.test.ts only, not any package.json, so adding
 * @testcontainers/redis wasn't available without going outside that
 * scope. This double therefore stands in for a real Redis: TTL
 * assertions check the EXACT `seconds` argument passed to `setex`, not a
 * live, decrementing `TTL key` read against a real server. The brief's
 * "TTL between 3590 and 3600" range assertion is exactly that
 * live-decrement check, and lands in T2.6.6 once the real harness
 * exists.
 */
export function makeRecordingLinkCacheRedis(now: () => number = Date.now): LinkCacheWriteRedis & {
  readonly getCalls: string[];
  readonly setexCalls: ReadonlyArray<{ key: string; seconds: number; value: string }>;
  failNextSetex(): void;
} {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const getCalls: string[] = [];
  const setexCalls: Array<{ key: string; seconds: number; value: string }> = [];
  let shouldFailNextSetex = false;

  return {
    getCalls,
    setexCalls,
    failNextSetex() {
      shouldFailNextSetex = true;
    },
    async get(key: string): Promise<string | null> {
      getCalls.push(key);
      const entry = store.get(key);
      if (!entry) return null;
      if (now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async setex(key: string, seconds: number, value: string): Promise<unknown> {
      setexCalls.push({ key, seconds, value });
      if (shouldFailNextSetex) {
        shouldFailNextSetex = false;
        throw new Error('simulated Redis SETEX failure');
      }
      store.set(key, { value, expiresAt: now() + seconds * 1000 });
      return 'OK';
    },
  };
}
