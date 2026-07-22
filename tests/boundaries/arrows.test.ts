import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import depcruiseConfig from '../../.dependency-cruiser.js';

// This is the acceptance test for S0.2: "A test fixture importing core
// from web fails lint with a readable message." The three fixtures below
// cover the three shapes a real violation takes:
//   - web-imports-core.fixture.ts: a static, UNRESOLVED import (nothing
//     under tests/boundaries/ has @posta/core as a dependency, so this is
//     the "nobody added the dependency yet" case).
//   - web-imports-core-dynamic.fixture.ts: a dynamic import that
//     genuinely RESOLVES, via a relative path straight into
//     packages/core/src.
//   - web-imports-core-dist.fixture.ts: a static import that genuinely
//     RESOLVES into packages/core/DIST, via a relative path — the shape a
//     real `apps/web` import actually takes once someone adds `@posta/core`
//     to its package.json for real, since that resolves through core's
//     `main` field.
// All three are needed: dependency-cruiser records an unresolved
// specifier, a resolved src path, and a resolved dist path differently,
// and a rule (or an includeOnly scope) can pass some of these while
// missing another — see .dependency-cruiser.js's top comment for the
// incident where the dist-resolved case slipped through undetected
// because includeOnly was scoped to `.../src` only. The src-resolved
// fixture alone would not have caught that regression, since src was
// already inside the old, buggy scope.
const REPO_ROOT = process.cwd();
const DEPCRUISE_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise',
);
const VIOLATED_RULE_NAME = 'no-illegal-core-import';

// All three fixtures are deliberately outside the includeOnly scope
// .dependency-cruiser.js's options use for the normal `pnpm depcruise`
// run — a run over the real apps/packages tree must stay green (T0.2.3)
// even though this exact import shape must fail (this test). So this
// test points a dedicated depcruise invocation directly at each fixture,
// overriding --include-only just for that run — otherwise the filter
// that keeps the fixtures out of the normal scan would also swallow the
// violation we're trying to observe here.
//
// The override is deliberately NOT a blanket '.' (match everything): it
// is built from the config's own, *live* includeOnly.path, extended just
// enough to reach these fixtures (which live under tests/boundaries/, so
// structurally outside apps/packages) and an unresolved bare @posta/<name>
// specifier (which was never gated by includeOnly to begin with — only
// resolved paths are, since an unresolved specifier isn't a real
// filesystem path). A blanket '.' override would make every fixture here
// pass regardless of what the real config's includeOnly says, which is
// exactly what would let the dist-resolved test below stay green even if
// includeOnly regressed back to `.../src` — the config would be broken
// in production while this suite kept reporting all clear. Deriving the
// override from the config instead means a regression there shows up
// here too.
const FIXTURE_INCLUDE_ONLY = [
  depcruiseConfig.options.includeOnly.path,
  '^tests/boundaries/',
  '^@posta/',
].join('|');

// The dist-resolved fixture imports packages/core/dist/index.js, but
// dist/ is gitignored and this repo's `test` task has no build
// dependency — a cold checkout (or a fresh `pnpm install` without ever
// having run `pnpm --filter @posta/core build`) would have no dist/ to
// resolve into, and the fixture's import would come back *unresolved*
// instead of genuinely resolved, silently testing the wrong thing (the
// same code path web-imports-core.fixture.ts already covers) instead of
// failing loudly. Build it once, up front, so the dist-resolved
// assertion below is actually exercising dist resolution.
beforeAll(() => {
  const build = spawnSync('pnpm', ['--filter', '@posta/core', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  if (build.status !== 0) {
    throw new Error(
      `pnpm --filter @posta/core build failed (needed so packages/core/dist ` +
        `exists for the dist-resolved boundary test):\n${build.stdout}\n${build.stderr}`,
    );
  }
}, 30_000);

function runDepcruiseOnFixture(fixture: string) {
  const result = spawnSync(
    DEPCRUISE_BIN,
    [
      '--config',
      '.dependency-cruiser.js',
      '--output-type',
      'err-long',
      '--include-only',
      FIXTURE_INCLUDE_ONLY,
      fixture,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  // spawnSync sets `error` (and leaves stdout undefined) when it can't even
  // launch the process — e.g. a missing/uninstalled depcruise binary. Left
  // unchecked, that surfaces as an opaque "Cannot read properties of
  // undefined (reading 'includes')" from the assertions below, which sends
  // whoever hits it chasing the wrong problem. Fail loudly with the real
  // cause instead.
  if (result.error) {
    throw new Error(
      `Failed to spawn depcruise at ${DEPCRUISE_BIN}: ${result.error.message}`,
    );
  }

  return result;
}

describe('dependency boundary: apps/web cannot import @posta/core', () => {
  it('fails depcruise on a static import, naming the no-illegal-core-import rule', () => {
    const result = runDepcruiseOnFixture(
      'tests/boundaries/web-imports-core.fixture.ts',
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(VIOLATED_RULE_NAME);
  });

  it('fails depcruise on a resolved dynamic import, naming the no-illegal-core-import rule', () => {
    const result = runDepcruiseOnFixture(
      'tests/boundaries/web-imports-core-dynamic.fixture.ts',
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(VIOLATED_RULE_NAME);
  });

  it('fails depcruise on a dist-resolved import, naming the no-illegal-core-import rule', () => {
    const result = runDepcruiseOnFixture(
      'tests/boundaries/web-imports-core-dist.fixture.ts',
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(VIOLATED_RULE_NAME);
  });
});
