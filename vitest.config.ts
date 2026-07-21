import { defineConfig } from 'vitest/config';

// Root-level Vitest config. tests/** holds workspace-level tests — checks
// that span multiple packages (the S0.2 dependency-boundary tests) rather
// than belonging to any single package. Package-level unit tests get their
// own configs later (T0.5.3); this one deliberately only wires up
// tests/**, no coverage thresholds yet (that is T0.5.4).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
