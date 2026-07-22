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
//
// apps/**/*.test.ts added in T0.3.5 (S0.3 batch 5): the per-app env
// schemas land beside their source the same way contracts' did
// (apps/api/src/env.test.ts etc.), and this batch's own verify commands
// (`pnpm test apps/api/src/env.test.ts` etc.) only find those files if
// the glob covers apps/** too — exactly the extension the comment above
// anticipated. Still no per-package configs (T0.5.3) or coverage
// thresholds (T0.5.4) — this stays the one root config.
//
// coverage (T0.5.3, S0.5) — v8 is Vitest's built-in provider, no extra
// native dependency to install/pin beyond @vitest/coverage-v8 itself.
// `include` is scoped to each package/app's own src — real application
// code, not test files, config files, or build output. `exclude` on top of
// that removes files with genuinely no logic to measure, so the number
// reflects real coverage rather than being gamed by padding the
// denominator with unmeasurable glue:
//   - **/main.ts: NestJS bootstrap wiring (env validation + NestFactory
//     .create + listen) — not business logic, and nothing imports it in a
//     test (nothing ever calls bootstrap()).
//   - **/app.module.ts: an empty `@Module({})` scaffold in both apps/api
//     and apps/worker — zero logic until E2/E3 add providers.
//   - apps/web/src/app/{layout,page}.tsx: the default Next.js app-router
//     scaffold and a one-line placeholder home page — no logic yet either.
//   - packages/core/src/index.ts: a documented placeholder (`export {}`)
//     until E1 adds the Drizzle schema — nothing to cover yet.
// No threshold yet (T0.5.4 adds `thresholds` once there's a number worth
// gating on).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.config.*',
        '**/main.ts',
        '**/app.module.ts',
        'apps/web/src/app/layout.tsx',
        'apps/web/src/app/page.tsx',
        'packages/core/src/index.ts',
      ],
    },
  },
});
