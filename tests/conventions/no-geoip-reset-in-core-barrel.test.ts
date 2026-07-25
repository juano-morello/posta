import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

// T2.3.4 review fixup — resetGeoDatabases (packages/core/src/geoip/loader.ts)
// exists purely for loader.test.ts's own teardown; its docstring says so
// explicitly ("there is no socket or file handle to close"). Unlike
// closeRedis (packages/core/src/redis/client.ts), which redis/index.ts's
// barrel legitimately re-exports because T0.7.8's SIGTERM handler is a REAL
// production caller, nothing in production ever needs resetGeoDatabases.
// Reaching it via `@posta/core` would let a caller clear the boot-time
// GeoIP memo mid-process, reopening the per-request file-I/O risk
// (invariant 2) T2.3.4 exists to close — geoip/index.ts's barrel was fixed
// to use named exports instead of `export * from './loader'` for exactly
// this reason.
//
// This test pins that fix against the BUILT package entry point
// (packages/core/dist/index.js — what apps/api and apps/worker actually
// resolve `@posta/core` to, the same dist path tests/boundaries/
// arrows.test.ts's own fixture relies on) rather than grepping
// geoip/index.ts's source text. A textual grep for the string
// "resetGeoDatabases" would NOT catch a future regression back to
// `export * from './loader'`: `export *` never spells the re-exported
// names out, so the offending line would contain no such string to catch.
// Only inspecting the actual resolved runtime export surface catches every
// way the leak could be reintroduced, not just this specific one.
const REPO_ROOT = process.cwd();

// dist/ is gitignored and this repo's `test` task has no build dependency
// (see arrows.test.ts's own beforeAll, same rationale) — build once, up
// front, so this test reflects the CURRENT source rather than a stale or
// absent dist/.
beforeAll(() => {
  const build = spawnSync('pnpm', ['--filter', '@posta/core', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  if (build.status !== 0) {
    throw new Error(
      `pnpm --filter @posta/core build failed (needed so packages/core/dist ` +
        `reflects the current source for this test):\n${build.stdout}\n${build.stderr}`,
    );
  }
}, 30_000);

describe("@posta/core's public entry point does not expose test-only GeoIP helpers", () => {
  it('does not export resetGeoDatabases', async () => {
    const core: Record<string, unknown> = await import('../../packages/core/dist/index.js');

    expect('resetGeoDatabases' in core).toBe(false);
  });

  it('still exports the production GeoIP loader functions, so the fix did not over-trim', async () => {
    const core: Record<string, unknown> = await import('../../packages/core/dist/index.js');

    expect(typeof core.createGeoDatabases).toBe('function');
    expect(typeof core.openGeoDatabases).toBe('function');
  });
});
