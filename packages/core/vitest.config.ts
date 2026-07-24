import { defineConfig } from 'vitest/config';

// T1.1.2 — packages/core's own Vitest project, referenced from the root
// vitest.config.ts's `projects` array (same pattern as that config's
// `containers` project). Hook timeout raised to 120s: the testcontainers
// Postgres harness (src/test/pg-container.ts) pulls postgres:16-alpine on a
// cold run, and every integration test in E1-E4 that reuses it inherits
// the same beforeAll/afterAll boot — Vitest's 10s default hookTimeout is
// not enough for a cold pull on a slow connection or a contended CI
// runner. No custom `include`: Vitest's own default test glob, resolved
// relative to this project's root (packages/core), already matches every
// *.test.ts under src/.
export default defineConfig({
  test: {
    name: 'core',
    hookTimeout: 120_000,
  },
});
