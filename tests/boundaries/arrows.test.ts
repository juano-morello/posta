import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// This is the acceptance test for S0.2: "A test fixture importing core
// from web fails lint with a readable message." The fixture at
// web-imports-core.fixture.ts is deliberately outside the includeOnly
// scope that .dependency-cruiser.js's options use for the normal
// `pnpm depcruise` run (see that file's top comment) — a run over the
// real apps/packages tree must stay green (T0.2.3) even though this
// exact import shape must fail (this test). So this test points a
// dedicated depcruise invocation directly at the fixture, with
// `--include-only '.'` overriding the config's includeOnly just for this
// run — otherwise the filter that keeps the fixture out of the normal
// scan would also swallow the violation we're trying to observe here.
const REPO_ROOT = process.cwd();
const DEPCRUISE_BIN = path.join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'depcruise.cmd' : 'depcruise',
);
const FIXTURE = 'tests/boundaries/web-imports-core.fixture.ts';
const VIOLATED_RULE_NAME = 'no-illegal-core-import';

function runDepcruiseOnFixture() {
  const result = spawnSync(
    DEPCRUISE_BIN,
    [
      '--config',
      '.dependency-cruiser.js',
      '--output-type',
      'err-long',
      '--include-only',
      '.',
      FIXTURE,
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
  it('fails depcruise, naming the no-illegal-core-import rule', () => {
    const result = runDepcruiseOnFixture();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(VIOLATED_RULE_NAME);
  });
});
