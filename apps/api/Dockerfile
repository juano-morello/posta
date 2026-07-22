# apps/api/Dockerfile — T0.7.4 (multi-stage), hardened non-root in T0.7.7,
# SIGTERM-clean shutdown wired into apps/api/src/main.ts in T0.7.8.
#
# Build context is the REPO ROOT (`docker build -f apps/api/Dockerfile .`),
# not this directory — the pruner stage below needs the whole workspace to
# compute this app's subset via `turbo prune` (T0.7.3).
#
# Four stages:
#   pruner  — turbo prune down to @posta/api + its workspace deps only
#   deps    — full `pnpm install` (incl. devDeps: @nestjs/cli, typescript)
#             over the PRUNED manifests/lockfile — this is the layer that
#             stays cache-hit across commits that never touch apps/api,
#             packages/core or packages/contracts (see T0.7.3's docstring)
#   builder — `pnpm --filter @posta/api... build` (the `...` also builds
#             @posta/contracts and @posta/core first — api's tsconfig
#             references their compiled `dist/`, not their `src/`)
#   runner  — prod-only deps, reinstalled fresh from the pruned manifests
#             (see below), plus the three dist/ trees the app needs at
#             runtime, on the slim runtime base

# ARGs declared before the first FROM are usable by any `FROM ${...}`
# below. The defaults here MUST match docker/base-images.env — never
# hand-edit either without scripts/refresh-base-digests.sh, which
# rewrites both in the same run so they can't drift apart. A bare
# `docker build -f apps/api/Dockerfile .` (no --build-arg) relies on
# these defaults; --build-arg NODE_BASE=... still overrides them.
ARG NODE_BASE=node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
ARG NODE_RUNTIME_BASE=node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# ---------------------------------------------------------------- pruner --
FROM ${NODE_BASE} AS pruner
WORKDIR /app
# A global, standalone turbo install — cheap and fast — rather than a full
# `pnpm install` at the monorepo root just to get `turbo` on PATH. The
# whole point of pruning is to avoid a root-level install; doing one here
# to bootstrap the pruner would defeat that.
RUN npm install -g turbo@2.10.5
COPY . .
RUN turbo prune @posta/api --docker

# ------------------------------------------------------------------ deps --
FROM ${NODE_BASE} AS deps
WORKDIR /app
RUN corepack enable
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# --------------------------------------------------------------- builder --
FROM ${NODE_BASE} AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
# turbo prune only carries files that belong to a workspace package
# (apps/*/package.json, packages/*/tsconfig.json, ...) — tsconfig.base.json
# is a bare root file every workspace tsconfig extends by relative path
# (../../tsconfig.base.json) but that isn't itself a workspace package, so
# prune never picks it up. Copied straight from the real build context,
# not from either pruner output.
COPY tsconfig.base.json ./tsconfig.base.json
# The `...` suffix also builds @posta/contracts and @posta/core first (in
# that dependency order) — api's own tsconfig `references` their compiled
# dist/, so building api alone here would fail with "cannot find module"
# (verified: it does, without this).
RUN pnpm --filter @posta/api... run build

# ---------------------------------------------------------------- runner --
FROM ${NODE_RUNTIME_BASE} AS runner
WORKDIR /app
ENV NODE_ENV=production
# T0.7.7 — non-root runtime user [security]. uid 10001 is arbitrary,
# unprivileged, and not used by anything else in the base image; it's
# also the exact value Kubernetes' `runAsNonRoot`/`runAsUser: 10001`
# admission checks would enforce, so failing here means failing in CI,
# not silently at deploy time. alpine has no `useradd` — `addgroup`/
# `adduser` are busybox's equivalent.
RUN addgroup -g 10001 posta && adduser -D -u 10001 -G posta posta
# WORKDIR created /app while still root — `COPY --chown` only chowns the
# files it copies, not the pre-existing parent directory, and pnpm needs
# to write a temp file directly under /app during install (not just under
# node_modules), which fails EACCES as posta otherwise.
RUN chown posta:posta /app
RUN corepack enable
# Prod deps land here via a SECOND, separate `pnpm install --prod` over the
# pruned manifests — not by copying/filtering the `deps` stage's node_modules.
# pnpm's node_modules is a tree of symlinks into a content-addressable
# store; partially copying it correctly (without also dragging the store,
# undoing most of the size win) is fragile. A fresh --prod install is both
# simpler and correct, at the cost of resolving the dependency graph twice
# across the two stages.
COPY --from=pruner --chown=posta:posta /app/out/json/ .
# Switch to posta BEFORE the install (not just before CMD): pnpm needs to
# write node_modules under /app, and this is the one RUN in the stage that
# writes anything — everything after it is just COPY --chown, which
# doesn't care which USER is active.
USER posta
# The trailing store-prune matters: pnpm installs by hardlinking from a
# content-addressable store (~/.local/share/pnpm/store) into node_modules,
# and that store is never needed again in a runtime image — nothing here
# ever runs pnpm again. Left alone it measured ~26.5MB, nearly as large as
# node_modules itself (~28MB). Must be the SAME RUN instruction as the
# install: Docker layers are diffs, so creating and deleting the store
# within one layer nets zero bytes added, where deleting it in a later
# instruction would still leave it in this layer's diff. Verified after
# removal that the app still starts correctly — pnpm's node_modules
# entries are hardlinks into the store's files, not symlinks, so the
# store can be deleted once the install is done without breaking anything
# still holding a link to that data.
RUN pnpm install --prod --frozen-lockfile && rm -rf "$(pnpm store path)"
# @posta/api depends on @posta/contracts and @posta/core through pnpm
# workspace symlinks (apps/api/node_modules/@posta/contracts ->
# ../../../../packages/contracts) created by the install above — the
# symlink TARGET needs its compiled dist/ present, or requiring
# @posta/contracts at runtime resolves to a directory with no dist/index.js.
COPY --from=builder --chown=posta:posta /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=posta:posta /app/packages/core/dist ./packages/core/dist
COPY --from=builder --chown=posta:posta /app/apps/api/dist ./apps/api/dist

# Documentation only — the actual bind address/port come from API_PORT at
# runtime (config-via-env, per CLAUDE.md). Matches .env.example's default.
EXPOSE 3001

CMD ["node", "apps/api/dist/main.js"]
