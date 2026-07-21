# E0 — Foundation

**Milestone:** M1 · **Depends on:** — · **Unblocks:** E1, E6

**Goal:** a monorepo where the dependency arrows are enforced by the build, the environment is validated at startup, and `pnpm dev` brings up the full local stack.

**Done when:** a fresh clone runs `pnpm install && pnpm dev` and gets Postgres, Redis and an R2-compatible store running with all four packages building; and a deliberate `web → core` import **fails CI**.

---

## S0.1 — Monorepo skeleton

**As a** developer **I want** the workspace laid out per the architecture **so that** package boundaries exist before there is code to misplace.

**Acceptance:**
- [ ] `git init`, `.gitignore`, initial commit
- [ ] pnpm workspace + Turborepo with `build`, `dev`, `test`, `lint`, `typecheck` pipelines
- [ ] `packages/contracts`, `packages/core`, `apps/api`, `apps/worker`, `apps/web` all build empty
- [ ] TypeScript project references wired; `pnpm typecheck` passes from clean
- [ ] Turbo remote cache disabled for now (no team, no gain)

**Tasks:**
- [ ] T0.1.1 `git init` + `.gitignore` (node_modules, .env, .turbo, dist, .next, *.mmdb)
- [ ] T0.1.2 root `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- [ ] T0.1.3 shared `tsconfig.base.json`; per-package tsconfigs extending it
- [ ] T0.1.4 scaffold the 5 packages with minimal entrypoints
- [ ] T0.1.5 Node version pin (`.nvmrc` + `engines`) — worker and api must match

---

## S0.2 — Dependency arrows enforced by the build

**As a** maintainer **I want** illegal imports to fail CI **so that** the architecture cannot erode by accident.

Allowed: `web→contracts` · `api→core,contracts` · `worker→core,contracts` · `core→contracts`. No app imports another app.

**Acceptance:**
- [ ] `eslint-plugin-boundaries` (or `dependency-cruiser`) configured with the arrow rules
- [ ] A test fixture importing `core` from `web` fails lint with a readable message
- [ ] `packages/contracts` has **zero** runtime dependencies beyond `zod` — asserted by a test, not a convention
- [ ] `packages/core` is marked server-only and cannot be imported into a client bundle

**Tasks:**
- [ ] T0.2.1 install and configure the boundary linter
- [ ] T0.2.2 encode the five allowed arrows as explicit rules
- [ ] T0.2.3 write the negative test (illegal import must fail)
- [ ] T0.2.4 assert `contracts` dependency list is `["zod"]`
- [ ] T0.2.5 add `import 'server-only'` to `core`'s entrypoint

> `web` calls the API over HTTP for bio data. That is a network call, not an import — the arrow holds. Do not "fix" this by importing `core`.

---

## S0.3 — Environment config, validated at startup

**As an** operator **I want** a missing env var to crash on boot **so that** it never surfaces as a mystery 500 in production.

**Acceptance:**
- [ ] A Zod env schema per app; parsed at startup; process exits non-zero with the missing key named
- [ ] `.env.example` complete and committed; real `.env` git-ignored
- [ ] `POSTA_LINK_DOMAIN` drives every host construction — **no hardcoded `posta.lat` anywhere** (asserted by a grep test)
- [ ] Secrets (DB URL, Redis URL, R2 keys, auth secret) never logged, including in error paths

**Tasks:**
- [ ] T0.3.1 `packages/contracts/env.ts` — shared primitives
- [ ] T0.3.2 per-app env schemas (api, worker, web)
- [ ] T0.3.3 fail-fast loader invoked before anything else in each entrypoint
- [ ] T0.3.4 `.env.example` + README setup section
- [ ] T0.3.5 grep test: no literal `posta.lat` outside `.env.example` and docs

---

## S0.4 — Local dev stack

**As a** developer **I want** one command to get real infra **so that** tests run against Postgres and Redis, not mocks.

**Acceptance:**
- [ ] `docker-compose.yml` with Postgres 16, Redis 7, MinIO (R2-compatible S3 API)
- [ ] Redis configured with `maxmemory-policy volatile-lru` **locally too**, so dev matches prod [INV-7]
- [ ] `pnpm dev` runs compose + all apps in watch mode
- [ ] Healthchecks so apps wait for infra instead of crash-looping

**Tasks:**
- [ ] T0.4.1 compose file with the three services + healthchecks
- [ ] T0.4.2 Redis config with `volatile-lru`
- [ ] T0.4.3 MinIO bucket auto-create on boot
- [ ] T0.4.4 `pnpm dev` orchestration via turbo
- [ ] T0.4.5 `pnpm dev:reset` — tear down volumes and re-seed

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
- [ ] T0.5.1 CI workflow with pnpm + turbo cache
- [ ] T0.5.2 Postgres + Redis service containers
- [ ] T0.5.3 coverage gate at 80%
- [ ] T0.5.4 branch protection on main once the repo is pushed

---

## S0.6 — Reconcile the source documents

**As a** future reader **I want** the docs to agree with the build **so that** `CLAUDE.md` stays trustworthy as the contract it claims to be.

The design resolved three contradictions. The docs still contain the losing side of each.

**Acceptance:**
- [ ] `CLAUDE.md` invariant 11 replaced with the amended one-frontend-surface text (spec §11)
- [ ] `CLAUDE.md` gains the Cloudflare Origin Rule routing note
- [ ] `POSTA.md` §0 — links are `juano.posta.lat/<slug>`, bio is `juano.posta.lat/`; the `juano.lbt.works` reference is removed
- [ ] `POSTA.md` §2 microcopy examples updated to the longer host
- [ ] `POSTA.md` §8 reframed: SCSS is the **token source**, Tailwind + shadcn is the component layer
- [ ] A decision-log section links back to the spec

**Tasks:**
- [ ] T0.6.1 rewrite `CLAUDE.md` invariant 11 [INV-11]
- [ ] T0.6.2 add routing table to `CLAUDE.md`
- [ ] T0.6.3 fix `POSTA.md` §0 domains
- [ ] T0.6.4 sweep `POSTA.md` for `posta.lat/` examples
- [ ] T0.6.5 reframe `POSTA.md` §8 SCSS scope
- [ ] T0.6.6 add decision log pointing at the spec

> The longer host has a UI consequence, so it is not a pure find-and-replace: `juano.posta.lat/promo` does not fit a list row the way `posta.lat/promo` did. The links list truncates to `…/promo`, showing the full host on hover and copying the full URL. Carry this into S7.2.
