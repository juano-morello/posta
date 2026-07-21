// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Root ESLint 9 flat config, applied across the whole pnpm workspace.
// Flat config has no per-package files to wire up (unlike .eslintrc's
// nested-config resolution) — one config at the root covers apps/* and
// packages/* alike.
//
// Deliberately just the recommended presets for now: S0.2's actual
// architectural rules (the web/api/worker/core/contracts arrows) live in
// dependency-cruiser, not here — see .dependency-cruiser.js. This file
// stays a plain scaffold until a real ESLint-shaped rule (not an import
// graph shaped one) is needed.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // tests/boundaries/*.fixture.ts (added in T0.2.4) contains a
      // deliberately illegal import used only as dependency-cruiser input.
      // It must never be linted, type-checked, or built — only pointed at
      // directly by the depcruise invocation in arrows.test.ts. Pre-declared
      // here so T0.2.4 doesn't need to reopen this file.
      'tests/boundaries/*.fixture.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
