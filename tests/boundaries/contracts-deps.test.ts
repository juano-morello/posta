import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// packages/contracts is the isomorphic web<->api seam (CLAUDE.md): pure
// Zod types, imported by both a browser bundle (web) and Node processes
// (api, worker). Any other runtime dependency — even something as
// innocuous-looking as a date-formatting library — either bloats the web
// bundle or, worse, drags server-only code across the boundary
// dependency-cruiser is guarding in .dependency-cruiser.js.
//
// This is a regression test, not a smoke test: dependency-cruiser cannot
// see this violation (a `pnpm add` doesn't create an import edge until
// someone writes `import` in a .ts file), so a plain `pnpm add lodash
// --filter @posta/contracts` would sail through T0.2.3's arrow rules
// undetected. Only a direct assertion on package.json catches it at the
// moment it happens.
describe('packages/contracts has zero runtime dependencies beyond zod', () => {
  it('declares "dependencies" as exactly ["zod"]', () => {
    const packageJsonPath = path.join(
      process.cwd(),
      'packages/contracts/package.json',
    );
    let contractsPackageJson: { dependencies?: Record<string, string> };
    try {
      contractsPackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not read/parse ${packageJsonPath}: ${reason}. This test ` +
          'guards the "contracts is isomorphic, zero server deps" ' +
          'invariant — it needs the file to exist and be valid JSON to ' +
          'check it.',
      );
    }

    expect(Object.keys(contractsPackageJson.dependencies ?? {})).toEqual([
      'zod',
    ]);
  });
});
