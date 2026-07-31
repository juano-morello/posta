import path from 'node:path';
import react from '@vitejs/plugin-react';
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
          exclude: [
            ...configDefaults.exclude,
            'tests/containers/**',
            'packages/core/**',
            'apps/api/src/redirect/test/**',
            'apps/worker/src/test/e2e-*.test.ts',
            'apps/worker/src/test/pipeline-harness.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'containers',
          include: ['tests/containers/**/*.test.ts'],
          fileParallelism: false,
        },
      },
      // 'e2e' project (T3.5, E3) — split out of 'default' for the SAME
      // reason 'containers' and 'redirect-hot-path' are (see their own
      // comments): these seven files don't just read and write MinIO like
      // the ~20 other R2-backed files under 'default' now can (the main
      // `ci` job writes a `.env` and starts the compose MinIO as of
      // 9402a36) — they OPERATE it mid-run. e2e-r2-outage.test.ts calls
      // `docker compose stop/start minio` directly, and every other file
      // here shares that same compose MinIO through startPipelineHarness()
      // /REAL_R2_CONFIG, so one file taking it down is a hard dependency
      // the read/write-only files don't have and can't be mixed with. See
      // this block's own `fileParallelism` paragraph below for the fuller
      // account (the measured collision, and why it's `false` here).
      // .github/workflows/ci.yml's `event-pipeline` job is what actually
      // runs this project, invoking `pnpm test --project e2e` against that
      // same compose stack. As with 'redirect-hot-path' below, 'default'
      // excludes these same two globs, so this project is the ONLY one
      // that ever runs these files — if that job is ever removed, they
      // silently stop running everywhere.
      //
      // The dependency is NOT uniform, so the include list is enumerated
      // rather than taking the whole apps/worker/src/test/ directory:
      //   - e2e-r2-outage.test.ts drives `docker compose stop/start/ps
      //     minio` directly (its own stopMinio/startMinio/waitForMinioHealthy).
      //   - e2e-pg-outage.test.ts and e2e-kill-recovery.test.ts don't call
      //     `docker compose` at all — they drive `docker pause`/`inspect`
      //     against their OWN testcontainers — but both point R2_ENDPOINT at
      //     the compose MinIO on http://localhost:9000, so the worker child
      //     process they spawn cannot flush a batch without it (INV-7:
      //     R2 first, Postgres only if it succeeded).
      //   - e2e-exactly-once/-duplicate-delivery/-enrichment.test.ts and
      //     pipeline-harness.test.ts inherit that same MinIO dependency
      //     through startPipelineHarness()'s REAL_R2_CONFIG.
      // Deliberately NOT included: pipeline-harness-process.test.ts, the
      // one file in that directory with no compose dependency at all — it
      // imports only `acquireBuildLock` and drives it with a mocked
      // fs.mkdirSync, boots nothing, and passes in the main job today.
      // Moving it here would quietly drop a passing unit test (and
      // pipeline-harness-process.ts's coverage) out of the 80% gate for no
      // reason. Note that `buildWorkerExclusively`, which the e2e files DO
      // import, is not itself a reason to move anything: it shells out to
      // `pnpm --filter @posta/worker run build` (nest build) and never to
      // docker — the "docker compose build" in its neighbouring comment is
      // an analogy, not an invocation.
      //
      // Timeouts, not left at Vitest's 5s/10s defaults: every file here
      // already calls vi.setConfig() with its own (testTimeout 60_000,
      // hookTimeout up to 900_000 in e2e-pg-outage/e2e-kill-recovery) and
      // passes explicit per-hook timeouts on top, so these project-level
      // values are the ceiling those files assume rather than a new
      // policy — set here so a file added to this glob later inherits a
      // workable budget instead of timing out at 10s inside a beforeAll
      // that boots containers, builds and spawns a worker, and waits on
      // STALL_REDELIVERY_TIMEOUT_MS (150s) for BullMQ's stalled-job
      // redelivery. Strictly above 'default', never below it.
      //
      // `fileParallelism: false` — the same defense 'containers' and
      // 'redirect-hot-path' already take, and here it is mandatory rather
      // than precautionary, because pulling these seven files out of
      // 'default' is what made the collision reliable. MinIO is ONE shared
      // compose service, not a per-file container, and
      // e2e-r2-outage.test.ts's whole method is `docker compose stop minio`
      // — which takes it down for every other process on the machine, not
      // just itself. Spread across 'default''s 83 files those seven rarely
      // overlapped; alone in a 7-file project they are all in flight at
      // once. Measured, not predicted: the first run of this project with
      // parallelism left on failed exactly that way — 1 failed | 6 passed,
      // e2e-pg-outage.test.ts dying on `connect ECONNREFUSED 127.0.0.1:9000`
      // (and ::1:9000) mid-drain while e2e-r2-outage.test.ts had MinIO
      // stopped. Serialized, the same seven files pass 121/121. Cost is
      // ~88s wall-clock parallel versus ~182s serial (both measured on the
      // same machine), against this job's own 30-minute CI budget — and the
      // parallel number is worthless when it is not reproducibly green.
      {
        test: {
          name: 'e2e',
          include: [
            'apps/worker/src/test/e2e-*.test.ts',
            'apps/worker/src/test/pipeline-harness.test.ts',
          ],
          testTimeout: 60_000,
          hookTimeout: 900_000,
          fileParallelism: false,
        },
      },
      // 'redirect-hot-path' project — the S2.6 invariant suite
      // (T2.6.1-T2.6.9, apps/api/src/redirect/test/**) shares this
      // directory's ONE startHotPathHarness() factory, and every file in
      // it boots its own Postgres+Redis testcontainers pair PLUS a full
      // Nest/Express app. Because 'default' excludes this same glob (just
      // above), this project is the ONLY one that ever runs these files —
      // .github/workflows/ci.yml's main `ci` job must name it explicitly
      // (`--project redirect-hot-path`) alongside default/web/core, or the
      // whole suite silently stops running (and stops contributing
      // coverage) in that job, even though nothing about the exclude above
      // announces that dependency. Investigated a reported flake here
      // (queue-down.test.ts's mechanism-1 assertion, `expected 51 to be
      // 50`) and found a genuine race INSIDE that file, now fixed at its
      // source: its `beforeAll` warmup request awaited only the client's
      // HTTP response, not the server's own fire-and-forget capture
      // continuation (middleware.ts flushes the redirect BEFORE it awaits
      // getDailySalt()/calls enqueueCapture() — T2.4.3's own ordering).
      // getDailySalt's first-ever call does a real Redis round trip
      // (salt.ts), so under contention that continuation could still be
      // in flight when the very next `it` disconnected the queue,
      // producing an (N+1)-th "Enqueue failed" log line from a request
      // neither `it` ever issued. queue-down.test.ts's own `beforeAll` now
      // waits for that warmup's job to actually land in the queue before
      // returning — the same "wait for the real side effect" discipline
      // every recovery check in that file already used.
      //
      // Fixing that one race does not rule out this DIRECTORY'S other
      // stated risk: several files booting Postgres+Redis pairs
      // concurrently is genuine resource contention (CPU/Docker-daemon
      // pressure stretching every timing-sensitive assertion in this
      // suite, not just queue-down.test.ts's own), and two files
      // (queue-down.test.ts, no-ip.test.ts) deliberately disconnect ioredis
      // clients as part of their own fault injection. `fileParallelism:
      // false` here is the SAME defense 'containers' above already takes
      // for its own concurrent-boot risk (docker compose build racing on
      // shared image tags) — applied here as a deliberate safety net
      // alongside the real fix, not instead of it, so a DIFFERENT latent
      // timing sensitivity in this same directory fails loudly in
      // isolation rather than intermittently under load. Measured cost
      // (three back-to-back local runs each way, Docker otherwise idle):
      // a full `pnpm test` averages ~62-65s with this group at default
      // parallelism versus ~75-77s serialized — roughly +12s, this
      // directory's own 9 files' containers booting one-after-another
      // instead of overlapping. (One early measurement read +107s; that
      // run immediately followed dozens of manual repro runs in the same
      // session and is attributable to Docker/testcontainers-ryuk still
      // reaping leftover containers, not to this setting itself — the
      // steady-state delta above is the one to trust.)
      {
        test: {
          name: 'redirect-hot-path',
          include: ['apps/api/src/redirect/test/**/*.test.ts'],
          fileParallelism: false,
        },
      },
      // E6 (S6.1) — apps/web's component tests need a DOM (Testing
      // Library) and JSX transform, neither of which the 'default'
      // project provides (node environment, plain esbuild tsx transform
      // with no React refresh/runtime wiring). Scoped to *.test.tsx only:
      // apps/web's *.test.ts files (tokens.test.ts, contrast.test.ts, the
      // grep tests, etc.) have no DOM and stay on 'default' — jsdom would
      // only slow those down for no benefit. Kept as its own project
      // rather than switching 'default' to jsdom repo-wide, so
      // packages/contracts, api and worker's node-only tests are
      // unaffected.
      {
        plugins: [react()],
        resolve: {
          // Mirrors apps/web/tsconfig.json's "@/*" -> "./src/*" path alias.
          // Vite/Vitest doesn't read tsconfig `paths` on its own, so
          // components importing e.g. '@/styles/globals.css' (layout.tsx)
          // would otherwise fail to resolve under this project.
          alias: {
            '@': path.resolve(__dirname, 'apps/web/src'),
          },
        },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/**/*.test.tsx'],
          exclude: [...configDefaults.exclude],
          setupFiles: ['apps/web/vitest.setup.ts'],
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
