import { defineConfig } from 'vitest/config';

// Root-level Vitest config. tests/** holds workspace-level tests — checks
// that span multiple packages (the S0.2 dependency-boundary tests) rather
// than belonging to any single package. Package-level unit tests get their
// own configs later (T0.5.3); this one deliberately only wires up
// tests/**, no coverage thresholds yet (that is T0.5.4).
//
// packages/**/*.test.ts added in T0.3.2: the plan puts contracts' unit
// tests beside their source (packages/contracts/src/env.test.ts etc.),
// not under tests/. Widened minimally — just packages/**, not apps/**,
// since apps have no tests yet this batch (their env schemas land in the
// next batch and can extend this glob then).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
