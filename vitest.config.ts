import { configDefaults, defineConfig } from 'vitest/config';

// Root-level Vitest config. tests/** holds workspace-level tests — checks
// that span multiple packages (the S0.2 dependency-boundary tests) rather
// than belonging to any single package.
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
// anticipated. Still no per-package configs — this stays the one root
// config.
//
// coverage (T0.5.3/T0.5.4, S0.5) — v8 is Vitest's built-in provider, no
// extra native dependency to install/pin beyond @vitest/coverage-v8
// itself. `include` is scoped to each package/app's own src — real
// application code, not test files, config files, or build output.
// `exclude` on top of that removes files with genuinely no logic to
// measure, so the number reflects real coverage rather than being gamed
// by padding the denominator with unmeasurable glue:
//   - **/main.ts: NestJS bootstrap wiring (env validation + NestFactory
//     .create + listen + the inline `/health` handler) — infrastructure
//     wiring, not domain business logic, and nothing imports it in a test
//     (nothing ever calls bootstrap()).
//   - **/app.module.ts: an empty `@Module({})` scaffold in both apps/api
//     and apps/worker — zero logic until E2/E3 add providers.
//   - apps/web/src/app/{layout,page}.tsx: the default Next.js app-router
//     scaffold and a one-line placeholder home page — no logic yet either.
//   - packages/core/src/index.ts: a pure re-export barrel (E1, T1.1.3) —
//     nothing in it to unit test directly; every export it re-exposes is
//     already covered where it's actually defined (db/, ulid.ts, ...).
//     apps/api and apps/worker import through this file (not its
//     submodules), so it only executes once E2/E3 add integration tests
//     that do — nothing changes here when that happens, it just starts
//     showing up in the report with the same 100% its constituents have.
//
// thresholds (T0.5.4): global, not per-file — S0.5's acceptance criterion
// is "floor 80%, build fails below it" as a single number, and per-file
// gating would immediately fight small-but-real files (e.g. a future
// one-off util) for no safety benefit this early. Lines and branches only,
// matching the plan text verbatim ("Fails the build below 80% lines and
// branches") — statements/functions aren't gated, though they currently
// clear 80% too. `pnpm test --coverage` currently reports 100% lines /
// 94.44% branches across the included files, comfortably above the floor.
// projects (batch 9 review, T0.7.12/13): tests/containers/**'s two files
// (image-smoke.test.ts, image-size.test.ts) each run `docker compose build
// api worker web` in their own beforeAll — Vitest parallelizes test FILES
// by default, so without this split, two concurrent `docker compose build`
// invocations racing on the SAME image tags is a latent flakiness risk
// (didn't bite in the batch's own 244/244 run, but it's there). `projects`
// splits the suite into two groups: everything else keeps today's default
// parallelism ("default"), and tests/containers/** gets fileParallelism:
// false, which Vitest resolves to maxWorkers: 1 for that group specifically
// — so its two files always run one after another, never concurrently,
// while every other test file is untouched. `coverage` stays OUTSIDE
// `projects`, at this root level, deliberately: Vitest only supports
// coverage/reporters/resolveSnapshotPath at the root config and forces
// every project to share that single resolved coverage — duplicating it
// per-project isn't supported and wouldn't do anything if it were.
//
// 'packages/core' project (T1.1.2, E1): a bare glob string, not an inline
// object like the two above — this tells Vitest to resolve
// packages/core/vitest.config.ts as ITS OWN standalone project (same
// mechanism 'packages/*' would use for every package, scoped here to just
// the one package that needs it). That file raises hookTimeout to 120s for
// the testcontainers Postgres harness's cold image pulls (src/test/
// pg-container.ts), which every integration test in E1-E4 reuses — so
// every test under packages/core benefits, not only the harness's own
// test. 'default' excludes 'packages/core/**' below so its tests run
// under exactly one project, never both.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'default',
          include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
          // configDefaults.exclude must be spread explicitly — setting
          // `exclude` replaces Vitest's own node_modules/.git defaults
          // rather than adding to them.
          exclude: [...configDefaults.exclude, 'tests/containers/**', 'packages/core/**'],
        },
      },
      {
        test: {
          name: 'containers',
          include: ['tests/containers/**/*.test.ts'],
          fileParallelism: false,
        },
      },
      'packages/core',
    ],
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
        // T1.1.4: auth.ts's four tables are consumed two ways, and
        // NEITHER one is a TypeScript import that would make v8 count its
        // lines as executed. drizzle-kit reads it as a static file path
        // (a separate CLI process, `db:generate`) to emit the SQL
        // migration auth.test.ts actually migrates and asserts against —
        // that test's coverage is real, it just lands on the generated
        // .sql file, which isn't a coverage target at all. At runtime,
        // only Better Auth's OWN drizzle adapter will ever import these
        // exports (`user`, `session`, ...), and that wiring is E5's job,
        // outside packages/core. Unlike links.ts/bio.ts/domains.ts
        // (T1.1.5-8), which T1.1.9's tenant-scoped repository helper
        // imports within this same epic and so pick up real coverage —
        // this exclude is scoped to auth.ts specifically, not the whole
        // schema/ folder, so a genuine future gap in one of those files
        // still fails the threshold instead of being silently masked.
        'packages/core/src/schema/auth.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
