import { vi } from 'vitest';
import type { ResolveLogger } from './resolve';

// Shared between resolve-tenant.test.ts (the handle→tenant ladder,
// createResolveTenant) and resolve-link.test.ts (the link lookup and
// backfill: lookupCachedLink / resolveLinkFromDb / resolveLink) — split
// out of one file (resolve.test.ts) into two once it crossed this
// epic's 800-line hard cap (T2.2.5's fix round 1). Kept here, imported
// by both, rather than copy-pasted into each: duplicated test setup
// drifts exactly like duplicated production logic.

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
