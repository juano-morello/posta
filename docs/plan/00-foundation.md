# E0 — Foundation

**Milestone:** M1 · **Depends on:** — · **Unblocks:** E1, E6

**Goal:** a monorepo where the dependency arrows are enforced by the build, the environment is validated at startup, and `pnpm dev` brings up the full local stack.

**Done when:** a fresh clone runs `pnpm install && pnpm dev` and gets Postgres, Redis and an R2-compatible store running with all five packages building; a deliberate `web → core` import **fails CI**; and `docker compose up` runs the same images production will run.

**Package names:** `@posta/contracts` · `@posta/core` · `@posta/api` · `@posta/worker` · `@posta/web`

---

## S0.1 — Monorepo skeleton

**As a** developer **I want** the workspace laid out per the architecture **so that** package boundaries exist before there is code to misplace.

**Acceptance:**
- [x] `git init`, `.gitignore`, initial commit
- [ ] pnpm workspace + Turborepo with `build`, `dev`, `test`, `lint`, `typecheck` pipelines
- [ ] `packages/contracts`, `packages/core`, `apps/api`, `apps/worker`, `apps/web` all build empty
- [ ] TypeScript project references wired; `pnpm typecheck` passes from clean
- [ ] Turbo remote cache disabled for now (no team, no gain)

**Tasks:**

#### T0.1.1 · `chore: initialize git repo with .gitignore` ✅ done (`e1ecd51`)
Git repo on `main`, `.gitignore` covering node_modules, `.env*` (except `.env.example`), `.turbo`, `dist`, `.next`, `*.mmdb`, `.idea`, compose volumes.
→ **files** `.gitignore` · **verify** `git check-ignore -v .env` resolves to a rule · **after** —

#### T0.1.2 · `chore: add pnpm workspace manifest`
Root `package.json` (private, `packageManager` pinned to an exact pnpm version) and `pnpm-workspace.yaml` listing `apps/*` and `packages/*`. No dependencies yet beyond turbo.
→ **files** `package.json`, `pnpm-workspace.yaml` · **verify** `pnpm install` exits 0 · **after** T0.1.1

#### T0.1.3 · `chore: pin node version across the workspace`
`.nvmrc` plus an `engines.node` range in the root manifest. `api` and `worker` must run the same major — they share `@posta/core` and a mismatch surfaces as native-module breakage at deploy time, not locally.
→ **files** `.nvmrc`, `package.json` · **verify** `node -v` matches `.nvmrc`; `pnpm install` emits no engine warning · **after** T0.1.2

#### T0.1.4 · `chore: add turborepo pipelines`
`turbo.json` with `build` (`dependsOn: ["^build"]`, outputs `dist/**` and `.next/**`), `test`, `lint`, `typecheck`, and `dev` (`persistent: true`, `cache: false`). Remote cache explicitly disabled.
→ **files** `turbo.json` · **verify** `pnpm turbo run build --dry-run=json` parses and lists every workspace package · **after** T0.1.2

#### T0.1.5 · `chore: add shared tsconfig base`
`tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `moduleResolution: bundler`, `isolatedModules`. Per-package tsconfigs extend it.
→ **files** `tsconfig.base.json` · **verify** `pnpm exec tsc -p tsconfig.base.json --showConfig` resolves · **after** T0.1.2

#### T0.1.6 · `feat: scaffold contracts package`
`@posta/contracts` with `package.json` (zod as the only runtime dep), tsconfig extending base, and `src/index.ts` exporting nothing yet. Builds to `dist/`.
→ **files** `packages/contracts/{package.json,tsconfig.json,src/index.ts}` · **verify** `pnpm --filter @posta/contracts build` exits 0 · **after** T0.1.5

#### T0.1.7 · `feat: scaffold core package`
`@posta/core`, depends on `@posta/contracts` via `workspace:*`. Empty `src/index.ts`. Client-bundle protection comes in T0.2.6 (a dependency-cruiser rule, not the `server-only` package — see that task).
→ **files** `packages/core/{package.json,tsconfig.json,src/index.ts}` · **verify** `pnpm --filter @posta/core build` exits 0 · **after** T0.1.6

#### T0.1.8 · `feat: scaffold api app`
Minimal NestJS: `main.ts` bootstrapping `AppModule`, listening on `API_PORT`. No controllers yet — the redirect middleware in E2 mounts before the Nest router, so `main.ts` is deliberately the interesting file here.
→ **files** `apps/api/{package.json,tsconfig.json,nest-cli.json,src/main.ts,src/app.module.ts}` · **verify** `pnpm --filter @posta/api build` exits 0; the process starts and answers a health route · **after** T0.1.7

#### T0.1.9 · `feat: scaffold worker app`
Minimal NestJS, separate process, no HTTP server beyond a health endpoint.
→ **files** `apps/worker/{package.json,tsconfig.json,nest-cli.json,src/main.ts,src/app.module.ts}` · **verify** `pnpm --filter @posta/worker build` exits 0 · **after** T0.1.7

#### T0.1.10 · `feat: scaffold web app`
Next.js App Router, TypeScript, no Tailwind yet (that lands in E6/S6.1). Depends on `@posta/contracts` only.
→ **files** `apps/web/{package.json,tsconfig.json,next.config.ts,src/app/layout.tsx,src/app/page.tsx}` · **verify** `pnpm --filter @posta/web build` exits 0 · **after** T0.1.6

#### T0.1.11 · `chore: wire typescript project references`
Composite builds so `tsc` resolves workspace packages from source in dev and from `dist` in CI. Prevents the "works in dev, fails in build" split.
→ **files** all five `tsconfig.json` files, `package.json` · **verify** `pnpm typecheck` passes from a clean `pnpm install` with no prior build · **after** T0.1.10

> The root `package.json` is in this task's file list because `pnpm typecheck` has
> nowhere else to resolve from — a root script is what makes this task's own verify
> runnable. The original list named only the tsconfigs, which made the task
> unsatisfiable within its declared scope.

---

## S0.2 — Dependency arrows enforced by the build

**As a** maintainer **I want** illegal imports to fail CI **so that** the architecture cannot erode by accident.

Allowed: `web→contracts` · `api→core,contracts` · `worker→core,contracts` · `core→contracts`. No app imports another app.

**Acceptance:**
- [ ] `eslint-plugin-boundaries` (or `dependency-cruiser`) configured with the arrow rules
- [ ] A test fixture importing `core` from `web` fails lint with a readable message
- [ ] `packages/contracts` has **zero** runtime dependencies beyond `zod` — asserted by a test, not a convention
- [ ] `packages/core` is marked server-only and cannot be imported into a client bundle

> **Tool decision:** use **dependency-cruiser**, not `eslint-plugin-boundaries`. The rules here are package-to-package rather than folder-to-folder, dependency-cruiser reads the workspace graph directly, and it can emit a diagram for the README. One tool, one config.

**Tasks:**

#### T0.2.1 · `chore: add eslint flat config`
Base ESLint 9 flat config with `typescript-eslint`, applied across the workspace. No custom rules yet.
→ **files** `eslint.config.js`, `package.json` · **verify** `pnpm lint` exits 0 on the empty scaffolds · **after** T0.1.11

#### T0.2.2 · `chore: add dependency-cruiser`
Install and generate a baseline `.dependency-cruiser.js`. No arrow rules yet — this task only proves the tool runs over the graph.
→ **files** `.dependency-cruiser.js`, `package.json` · **verify** `pnpm depcruise` exits 0 and reports 5 modules · **after** T0.2.1

#### T0.2.3 · `feat: encode the allowed dependency arrows`
Forbidden rules for every disallowed edge: `web→core`, `web→api`, any app→app, `contracts→anything`. Each rule carries a `comment` explaining *why*, because the error message is the only thing the person who trips it will read.
→ **files** `.dependency-cruiser.js` · **verify** `pnpm depcruise` exits 0 on the current tree · **after** T0.2.2

#### T0.2.4 · `test: assert web cannot import core`
A fixture file importing `@posta/core` from `apps/web`, plus a test asserting `depcruise` exits non-zero and names the rule. The fixture lives under a path excluded from the build.
→ **files** `tests/boundaries/web-imports-core.fixture.ts`, `tests/boundaries/arrows.test.ts` · **verify** `pnpm test tests/boundaries` passes (it asserts the *failure*) · **after** T0.2.3

#### T0.2.5 · `test: assert contracts has only zod as a runtime dependency`
Reads `packages/contracts/package.json` and asserts `dependencies` is exactly `["zod"]`. Guards invariant "contracts is isomorphic, zero server deps" against a casual `pnpm add`.
→ **files** `tests/boundaries/contracts-deps.test.ts` · **verify** `pnpm test tests/boundaries/contracts-deps.test.ts` · **after** T0.2.4

#### T0.2.6 · `feat: guard core against client bundles via dependency-cruiser`
Guard `packages/core` against client-bundle imports with the `no-illegal-core-import` dependency-cruiser rule (T0.2.3), hardened to catch static *and* dynamic imports and to see edges that actually resolve (through a package's `dist/`), not just ones nobody has added to a `package.json` yet. This is the *only* guard — no runtime package involved.
→ **files** `packages/core/{package.json,src/index.ts}`, `.dependency-cruiser.js` · **verify** `pnpm depcruise` fails when `apps/web` imports `@posta/core`, statically or dynamically, and `node -e "require('@posta/core')"` run from `apps/api`/`apps/worker` succeeds · **after** T0.2.5

> **Note:** an earlier version of this task added the npm `server-only` package to `packages/core/src/index.ts` instead. Rejected: `server-only`'s only non-`react-server` export is an unconditional `throw`, and plain Node (api, worker) never sets the `react-server` condition — importing core for real would have crashed both services at boot the moment E1/E2 wired up real Drizzle usage. A build-time check that runs in CI beats a runtime throw that only fires after the bad import has shipped.

---

## S0.3 — Environment config, validated at startup

**As an** operator **I want** a missing env var to crash on boot **so that** it never surfaces as a mystery 500 in production.

**Acceptance:**
- [ ] A Zod env schema per app; parsed at startup; process exits non-zero with the missing key named
- [x] `.env.example` complete and committed; real `.env` git-ignored
- [ ] `POSTA_LINK_DOMAIN` drives every host construction — **no hardcoded `posta.lat` anywhere** (asserted by a grep test)
- [ ] Secrets (DB URL, Redis URL, R2 keys, auth secret) never logged, including in error paths

**Tasks:**

#### T0.3.1 · `chore: document env in .env.example` ✅ done (`e1ecd51`)
All 24 variables with inline rationale where it matters. Committed; real `.env` git-ignored.
→ **files** `.env.example` · **verify** `git check-ignore .env` matches, `.env.example` is tracked · **after** —

#### T0.3.2 · `feat: add shared env primitives to contracts`
Reusable Zod primitives: `zPort`, `zUrl`, `zNonEmpty`, `zBooleanish`, `zCsvList`. Isomorphic, no `process.env` access — schemas only, so `web` can use them too.
→ **files** `packages/contracts/src/env.ts` · **verify** `pnpm test packages/contracts/src/env.test.ts` · **after** T0.2.6

#### T0.3.3 · `feat: derive every host from POSTA_LINK_DOMAIN`
`buildLinkUrl(handle, slug)`, `buildBioUrl(handle)`, `buildAppUrl(path)`, `buildApiUrl(path)`, `parseHandleFromHost(host)`. **This is the task that makes the grep test in T0.3.9 passable** — if hosts are assembled anywhere else, literals creep back in.
→ **files** `packages/contracts/src/domain.ts` · **verify** `pnpm test packages/contracts/src/domain.test.ts` — covers handle round-trip, reserved-handle rejection, and a non-`posta.lat` domain · **after** T0.3.2

#### T0.3.4 · `feat: add reserved handle and path lists to contracts`
`RESERVED_HANDLES` and `RESERVED_PATHS` as frozen arrays, parsed from `POSTA_RESERVED_HANDLES`. Shared by the redirect hot path (S2.1) and slug validation (S5.3) — **one list, never a copy**, because a drift here lets a user claim a slug that then 404s.
→ **files** `packages/contracts/src/reserved.ts` · **verify** `pnpm test packages/contracts/src/reserved.test.ts` · **after** T0.3.3

#### T0.3.5 · `feat: add api env schema`
Zod schema for the API's variables: DB, Redis, R2, DB-IP database paths, auth, domain, ports. The DB-IP keys are filesystem paths, not credentials — the lite databases are CC BY 4.0 and ship inside the image (S0.7), so there is no licence key to validate.
→ **files** `apps/api/src/env.ts` · **verify** `pnpm test apps/api/src/env.test.ts` asserts a missing key produces a named error · **after** T0.3.4

#### T0.3.6 · `feat: add worker env schema`
Worker's subset plus `EVENT_BATCH_SIZE` and `EVENT_BATCH_INTERVAL_MS`. Also `DATABASE_URL_WORKER` — the worker connects as the **writer** role while the API connects as a reader that has no `SELECT` on raw `events` (T4.2.4). Two roles means two URLs, and the split only bites if both are actually wired.
→ **files** `apps/worker/src/env.ts` · **verify** `pnpm test apps/worker/src/env.test.ts` · **after** T0.3.4

#### T0.3.7 · `feat: add web env schema`
Web's subset. Asserts that no secret-looking key is exposed under `NEXT_PUBLIC_` — a test, not a code review habit. [security]
→ **files** `apps/web/src/env.ts` · **verify** `pnpm test apps/web/src/env.test.ts` · **after** T0.3.4

#### T0.3.8 · `feat: fail fast on invalid env at startup`
A loader invoked as the first statement of each entrypoint. On failure it prints every missing or invalid key at once (not just the first) and exits non-zero. Never prints the *value* of a failing secret. [security]
→ **files** `apps/{api,worker}/src/main.ts`, `packages/contracts/src/env.ts` · **verify** running `@posta/api` with `DATABASE_URL` unset exits non-zero and names it · **after** T0.3.7

#### T0.3.9 · `test: forbid literal domains in source`
Greps `apps/` and `packages/` for `posta.lat` and `lbt.works`, excluding `.env.example`, `docs/` and `*.md`. Fails the build on a hit.
→ **files** `tests/conventions/no-literal-domain.test.ts` · **verify** `pnpm test tests/conventions` — passes clean, fails when a literal is planted · **after** T0.3.3

#### T0.3.10 · `test: assert secrets never reach logs`
Drives the logger with a populated env and asserts no secret value appears in output, including on a thrown-error path. [security]
→ **files** `tests/conventions/no-secret-logging.test.ts` · **verify** `pnpm test tests/conventions/no-secret-logging.test.ts` · **after** T0.3.8

#### T0.3.11 · `docs: add root README with setup steps`
Clone → `pnpm install` → copy `.env.example` → `pnpm dev`. Includes `pnpm geo:fetch` to pull the DB-IP lite databases, since without those files the datacenter classification rule cannot fire. No signup and no licence key — that step exists only because the `.mmdb` files are git-ignored, not because they are gated.
→ **files** `README.md` · **verify** a clean clone followed literally reaches a running stack · **after** T0.4.7

---

## S0.4 — Local dev stack

**As a** developer **I want** one command to get real infra **so that** tests run against Postgres and Redis, not mocks.

**Acceptance:**
- [ ] `docker-compose.yml` with Postgres 16, Redis 7, MinIO (R2-compatible S3 API)
- [ ] Redis configured with `maxmemory-policy volatile-lru` **locally too**, so dev matches prod [INV-7]
- [ ] `pnpm dev` runs compose + all apps in watch mode
- [ ] Healthchecks so apps wait for infra instead of crash-looping

**Tasks:**

#### T0.4.1 · `chore: add postgres service to docker-compose`
Postgres 16, named volume, credentials from `.env`, `pg_isready` healthcheck.
→ **files** `docker-compose.yml` · **verify** `docker compose up -d postgres` reaches `healthy` · **after** T0.1.2

#### T0.4.2 · `chore: add redis service with volatile-lru`
Redis 7 with an explicit `maxmemory` and `maxmemory-policy volatile-lru`, set via a mounted `redis.conf` rather than a CLI flag so the value is reviewable in a diff. [INV-7]
→ **files** `docker-compose.yml`, `docker/redis.conf` · **verify** `docker compose exec redis redis-cli config get maxmemory-policy` returns `volatile-lru` · **after** T0.4.1

#### T0.4.3 · `chore: add minio service`
MinIO with the S3 API on 9000 and console on 9001, credentials matching `.env`.
→ **files** `docker-compose.yml` · **verify** `docker compose up -d minio` reaches `healthy` · **after** T0.4.2

#### T0.4.4 · `chore: auto-create minio buckets on boot`
A one-shot `mc` init container creating `posta-events` and `posta-avatars` if absent, so a fresh clone needs no manual console step.
→ **files** `docker-compose.yml`, `docker/minio-init.sh` · **verify** `docker compose up -d` then `mc ls` shows both buckets · **after** T0.4.3

#### T0.4.5 · `chore: add healthchecks and startup ordering`
`depends_on` with `condition: service_healthy` across all three, so apps wait instead of crash-looping into a restart backoff that looks like a code bug.
→ **files** `docker-compose.yml` · **verify** `docker compose up -d` — no service restarts during startup · **after** T0.4.4

#### T0.4.6 · `chore: add pnpm dev orchestration`
`pnpm dev` brings up compose, waits for health, then runs all apps in watch mode via turbo.
→ **files** `package.json`, `turbo.json` · **verify** `pnpm dev` from clean reaches all three apps serving · **after** T0.4.5

#### T0.4.7 · `chore: add pnpm dev:reset`
Tears down volumes and re-seeds. The escape hatch when local data drifts, so nobody debugs a stale-schema ghost.
→ **files** `package.json`, `scripts/dev-reset.sh` · **verify** `pnpm dev:reset` leaves an empty, migrated database · **after** T0.4.6

#### T0.4.8 · `test: assert redis eviction policy is volatile-lru`
Connects to the running Redis and asserts the policy. Runs in CI too, so a provider default of `allkeys-lru` cannot slip through unnoticed. [INV-7]
→ **files** `tests/infra/redis-policy.test.ts` · **verify** `pnpm test tests/infra/redis-policy.test.ts` · **after** T0.4.2

> `volatile-lru` locally is not cosmetic. Under `allkeys-lru` a queue backlog evicts its own jobs, and that failure is invisible until events go missing. Dev must be able to reproduce it.

---

## S0.5 — CI

**As a** maintainer **I want** every push checked **so that** main is always deployable.

**Acceptance:**
- [ ] GitHub Actions: install → lint → typecheck → test → build, with turbo caching
- [ ] Service containers for Postgres + Redis so integration tests are real
- [ ] Coverage reported, floor 80%, build fails below it
- [ ] Runs on PR and on push to main

**Tasks:**

#### T0.5.1 · `ci: add github actions workflow`
Install → lint → typecheck → build on PR and push to main, with pnpm store and turbo caching keyed on the lockfile.
→ **files** `.github/workflows/ci.yml` · **verify** the workflow goes green on a PR · **after** T0.2.6

#### T0.5.2 · `ci: add postgres and redis service containers`
Service containers so integration tests run against real datastores rather than mocks — the hot-path and idempotency tests in E2/E3 are meaningless otherwise.
→ **files** `.github/workflows/ci.yml` · **verify** a trivial integration test connecting to both passes in CI · **after** T0.5.1

#### T0.5.3 · `ci: run the test suite with coverage`
Wire `pnpm test` with coverage reporting into the workflow. No threshold yet — that lands next, once there is code to measure.
→ **files** `.github/workflows/ci.yml`, `vitest.config.ts` · **verify** CI uploads a coverage summary · **after** T0.5.2

#### T0.5.4 · `ci: enforce 80% coverage floor`
Fails the build below 80% lines and branches.
→ **files** `vitest.config.ts` · **verify** artificially dropping coverage fails CI · **after** T0.5.3

#### T0.5.5 · `ci: run dependency-cruiser in the pipeline`
The arrow rules from S0.2 only protect the architecture if CI runs them.
→ **files** `.github/workflows/ci.yml` · **verify** a PR planting a `web→core` import fails CI · **after** T0.5.4

#### T0.5.6 · `chore: enable branch protection on main` ⛔ blocked
Require CI green and no direct pushes. **Blocked until a remote exists** — the repo is local-only today. Pair with the first `git push -u`.
→ **files** *(GitHub settings, not the repo)* · **verify** a direct push to main is rejected · **after** T0.5.5

---

## S0.6 — Reconcile the source documents ✅ done 2026-07-21

**As a** future reader **I want** the docs to agree with the build **so that** `CLAUDE.md` stays trustworthy as the contract it claims to be.

The design resolved three contradictions. The docs still contained the losing side of each.

**Acceptance:**
- [x] `CLAUDE.md` invariant 11 replaced with the amended one-frontend-surface text (spec §11)
- [x] `CLAUDE.md` gains the Cloudflare Origin Rule routing note
- [x] `POSTA.md` §0 — links are `juano.posta.lat/<slug>`, bio is `juano.posta.lat/`; the `juano.lbt.works` reference is removed
- [x] `POSTA.md` §2 microcopy examples updated to the longer host
- [x] `POSTA.md` §8 reframed: SCSS is the **token source**, Tailwind + shadcn is the component layer
- [x] A decision-log section links back to the spec

**Tasks:**
- [x] T0.6.1 rewrite `CLAUDE.md` invariant 11 [INV-11]
- [x] T0.6.2 add routing table to `CLAUDE.md`
- [x] T0.6.3 fix `POSTA.md` §0 domains
- [x] T0.6.4 sweep `POSTA.md` for `posta.lat/` examples
- [x] T0.6.5 reframe `POSTA.md` §8 SCSS scope
- [x] T0.6.6 add decision log pointing at the spec

**Found during execution, beyond the planned scope:**
- [x] A second `juano.lbt.works` in `POSTA.md` §2 screen 6 (Settings), which the plan had not caught
- [x] `POSTA.md` §5 declared `Link.id: number`, contradicting the ULID convention — changed to `string`
- [x] `POSTA.md` §7 screen 7 said "SSR"; now Next SSG + on-demand ISR, with a note that the editor preview must stay the real page component

> The longer host has a UI consequence, so it is not a pure find-and-replace: `juano.posta.lat/promo` does not fit a list row the way `posta.lat/promo` did. The links list truncates to `…/promo`, showing the full host on hover and copying the full URL. Carry this into S7.2.

---

## S0.7 — Container images

**As an** operator **I want** each app to ship as a self-contained image **so that** what Kubernetes runs is the same artifact I ran locally, not a re-resolved approximation of it.

**Acceptance:**
- [ ] `turbo prune --scope=<pkg> --docker` gives each app its own build context, so a dependency layer invalidates only when *that* app's dependencies change
- [ ] A multi-stage image per app — deps → build → slim runtime — for `api`, `worker` and `web`
- [ ] Every runtime stage runs as a non-root user, and every base image is pinned by digest [security]
- [ ] `dbip-asn-lite.mmdb` and `dbip-country-lite.mmdb` are baked in at build time — no init container, no secret, no runtime download
- [ ] `docker compose up` builds and runs these images rather than host Node
- [ ] CI builds all three and pushes them tagged with the git SHA
- [ ] Both an image-size budget and a start-and-answer-health smoke test run in CI
- [ ] Images are config-via-env only, log to stdout, and exit cleanly on `SIGTERM`

> **Data source decision:** DB-IP lite, not MaxMind GeoLite2. Same `.mmdb` format, so the reader library is unchanged — but DB-IP's lite databases are CC BY 4.0, which means no account, no licence key, and free redistribution. That single licence difference is what lets the database live *inside* the image. MaxMind's EULA forbids redistribution, which forces either a build-time secret or an init container that downloads on every pod start — a network dependency on the boot path of a service whose whole point is not blocking. The cost is an attribution line in the bio-page footer (E8). Cheap.

**Tasks:**

#### T0.7.1 · `chore: add a shared .dockerignore`
Root `.dockerignore` excluding `node_modules`, `.next`, `dist`, `.turbo`, `.env*`, `.git`, `docs`, `*.mmdb`. The build context is the repo root for all three images, so without this every `docker build` uploads the entire workspace and busts the cache on any file change at all.
→ **files** `.dockerignore` · **verify** `docker build -f /dev/null . 2>&1 | head -1` reports a context under 5MB · **after** T0.4.7

#### T0.7.2 · `chore: pin container base images by digest`
`docker/base-images.env` holding `NODE_BASE` and `NODE_RUNTIME_BASE` as `node:<major from .nvmrc>-alpine@sha256:…`, consumed by every Dockerfile via `ARG`. Plus `scripts/refresh-base-digests.sh` to re-resolve them deliberately. A floating tag means two builds of the same commit can differ, which turns "works on my machine" into a Kubernetes rollback.
→ **files** `docker/base-images.env`, `scripts/refresh-base-digests.sh` · **verify** `grep -c '@sha256:' docker/base-images.env` returns 2; `bash scripts/refresh-base-digests.sh --check` exits 0 · **after** T0.7.1

#### T0.7.3 · `chore: produce a pruned per-app build context with turbo prune`
`scripts/docker-prune.sh <scope>` wrapping `pnpm turbo prune --scope=@posta/<app> --docker`, emitting `out/json` (manifests + pruned `pnpm-lock.yaml`) and `out/full` (sources). This is the hard part of Dockerising a pnpm monorepo: a naive `COPY . .` ships every workspace package, so touching a `web` component reinstalls the `api`'s dependencies. The pruned lockfile is what makes the deps layer stable.
→ **files** `scripts/docker-prune.sh`, `package.json` · **verify** `bash scripts/docker-prune.sh api` writes `out/json/apps/api/package.json` and `out/json/pnpm-lock.yaml`, and `out/json/apps/web` does **not** exist · **after** T0.7.2

#### T0.7.4 · `chore: multi-stage Dockerfile for the api`
Four stages: `pruner` (runs T0.7.3's prune), `deps` (`pnpm install --frozen-lockfile` over `out/json` only), `builder` (`pnpm --filter @posta/api build`), `runner` (prod deps + `dist/` on the runtime base). Nothing from `builder` but `dist/` and `node_modules` crosses into `runner`.
→ **files** `apps/api/Dockerfile` · **verify** `docker build -f apps/api/Dockerfile .` succeeds, and a second build after touching `apps/web/src/app/page.tsx` reuses the cached `deps` layer · **after** T0.7.3

#### T0.7.5 · `chore: multi-stage Dockerfile for the worker`
Same four-stage shape as the api, scoped to `@posta/worker`. No HTTP port exposed beyond the health endpoint (E3) — the worker is a BullMQ consumer, and exposing a service port it does not serve invites a Kubernetes readiness probe pointed at nothing.
→ **files** `apps/worker/Dockerfile` · **verify** `docker build -f apps/worker/Dockerfile .` succeeds and `docker run --rm <img> node -e "process.exit(0)"` exits 0 · **after** T0.7.4

#### T0.7.6 · `chore: multi-stage Dockerfile for the web app`
Differs from the other two: set `output: 'standalone'` in `next.config.ts`, then copy only `.next/standalone`, `.next/static` and `public/` into the runtime stage. Without standalone the image carries the full workspace `node_modules` and lands several hundred MB heavier.
→ **files** `apps/web/Dockerfile`, `apps/web/next.config.ts` · **verify** `docker build -f apps/web/Dockerfile .` succeeds and `docker run --rm -p 3000:3000 <img>` serves `/` · **after** T0.7.5

#### T0.7.7 · `chore: run every runtime stage as a non-root user` [security]
Add a `posta` user (uid 10001) in each runtime stage, `chown` the app directory, and `USER posta` before `CMD`. Kubernetes can enforce this with `runAsNonRoot`, but an image that only works as root fails that admission check at deploy time rather than here.
→ **files** `apps/{api,worker,web}/Dockerfile` · **verify** `docker run --rm <img> id -u` returns `10001` for all three · **after** T0.7.6

#### T0.7.8 · `feat: shut down cleanly on SIGTERM in api and worker`
`app.enableShutdownHooks()` plus an explicit `SIGTERM` handler that stops accepting work, drains in-flight requests and closes the Redis and Postgres pools. Node as PID 1 does **not** get default signal handling, so without this every rolling deploy kills in-flight redirects at the 30s grace timeout.
→ **files** `apps/api/src/main.ts`, `apps/worker/src/main.ts` · **verify** `docker stop` on a running container exits within 5s, not at the 10s SIGKILL fallback · **after** T0.7.7

#### T0.7.9 · `chore: add the DB-IP database download script`
`scripts/fetch-geoip.sh` pulling `dbip-asn-lite` (~6MB) and `dbip-country-lite` from DB-IP's monthly free release into `data/geoip/`, exposed as `pnpm geo:fetch`. Both files are needed — the ASN database carries no country data. `docs/ops/geoip.md` records the monthly refresh cadence and the CC BY 4.0 attribution string the bio-page footer must carry (E8).
→ **files** `scripts/fetch-geoip.sh`, `package.json`, `docs/ops/geoip.md` · **verify** `pnpm geo:fetch` writes both `.mmdb` files and a reader opens each without error · **after** T0.7.8

#### T0.7.10 · `chore: bake the DB-IP databases into the api image only` [INV-6]
Run `fetch-geoip.sh` in the builder stage and `COPY` both `.mmdb` files into the **api** runtime stage at the paths the env schema expects (T0.3.5). The licence permits redistribution, so this replaces what would otherwise be an init container — the lookup reads a local file and the pod has no boot-time network dependency.

**The worker image deliberately does not get them.** Geo lookup happens at capture, in the API, because that is the only instant the IP exists — invariant 6 drops it there and never queues it. A worker holding geo databases could only use them if someone first queued an IP, so their absence is a structural reminder that the worker has no business doing geolocation. This is also why T0.3.5 carries `GEOIP_DB_DIR` and T0.3.6 does not.
→ **files** `apps/api/Dockerfile` · **verify** `docker run --rm <api-img> ls /app/data/geoip` lists both files, and `docker run --rm <worker-img> ls /app/data/geoip` fails with no such directory · **after** T0.7.9

#### T0.7.11 · `chore: build app images from docker-compose`
Give `api`, `worker` and `web` `build:` blocks pointing at their Dockerfiles, alongside the existing Postgres/Redis/MinIO services. Tradeoff, on purpose: `pnpm dev` keeps running watch mode on the host because container rebuilds are too slow for an edit loop — compose-built images are the artifact CI and production use, and the thing you reach for when a bug smells environmental.
→ **files** `docker-compose.yml`, `package.json` · **verify** `docker compose up --build -d` reaches `healthy` on all six services · **after** T0.7.10

#### T0.7.12 · `test: smoke-test that each built image starts and answers health`
Starts each image against the compose datastores and polls its health endpoint (defined in E2/E3) until ready or a 30s timeout. A green `docker build` proves the layers assembled, nothing more — a missing runtime dependency or a bad `CMD` only surfaces here.
→ **files** `tests/containers/image-smoke.test.ts` · **verify** `pnpm test tests/containers/image-smoke.test.ts` passes, and fails when `CMD` is pointed at a nonexistent entrypoint · **after** T0.7.11

#### T0.7.13 · `test: enforce a per-image size budget`
Reads `docker image inspect --format '{{.Size}}'` and fails above threshold: api 300MB, worker 300MB, web 250MB. Bloat is invisible until a rollout is slow — a stray `devDependency` in the runtime stage costs nothing locally and costs pull time on every node.
→ **files** `tests/containers/image-size.test.ts` · **verify** `pnpm test tests/containers/image-size.test.ts` passes; lowering a threshold by 1MB fails it · **after** T0.7.12

#### T0.7.14 · `ci: build and push all three images tagged with the git sha`
Buildx job on push to main: build `api`, `worker`, `web`, run the smoke and size tests against them, then push as `<registry>/posta-<app>:<sha>` with a GitHub Actions layer cache. `latest` may move as a convenience tag, never as the only one — a deploy pinned to `latest` cannot be rolled back to a known artifact.
→ **files** `.github/workflows/images.yml` · **verify** a merge to main pushes three digests whose tags match `git rev-parse HEAD` · **after** T0.7.13
