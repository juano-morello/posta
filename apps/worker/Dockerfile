# apps/worker/Dockerfile — T0.7.5 (multi-stage), hardened non-root in
# T0.7.7, SIGTERM-clean shutdown wired into apps/worker/src/main.ts in
# T0.7.8. Same four-stage shape as apps/api/Dockerfile (T0.7.4) — see that
# file for the fuller rationale on each stage; comments here only cover
# what's specific to the worker.
#
# Build context is the REPO ROOT (`docker build -f apps/worker/Dockerfile .`).
#
# The worker is a BullMQ consumer with no routed API of its own — it
# serves exactly one HTTP route (/health, for a Kubernetes liveness
# probe). No other port is EXPOSEd: this image doesn't provide a "service"
# beyond that, and exposing one anyway would invite a readiness probe
# pointed at nothing.

ARG NODE_BASE=node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
ARG NODE_RUNTIME_BASE=node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# ---------------------------------------------------------------- pruner --
FROM ${NODE_BASE} AS pruner
WORKDIR /app
RUN npm install -g turbo@2.10.5
COPY . .
RUN turbo prune @posta/worker --docker

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
# See apps/api/Dockerfile — tsconfig.base.json is a bare root file `turbo
# prune` never carries; every workspace tsconfig extends it by relative
# path (../../tsconfig.base.json).
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm --filter @posta/worker... run build

# ---------------------------------------------------------------- runner --
FROM ${NODE_RUNTIME_BASE} AS runner
WORKDIR /app
ENV NODE_ENV=production
# T0.7.7 — non-root runtime user [security]. See apps/api/Dockerfile for
# why uid 10001 specifically.
RUN addgroup -g 10001 posta && adduser -D -u 10001 -G posta posta
# See apps/api/Dockerfile — pnpm needs to write directly under /app
# (not just node_modules), which COPY --chown alone doesn't cover since
# /app itself was created by WORKDIR while still root.
RUN chown posta:posta /app
RUN corepack enable
COPY --from=pruner --chown=posta:posta /app/out/json/ .
USER posta
RUN pnpm install --prod --frozen-lockfile
# See apps/api/Dockerfile — @posta/worker resolves @posta/contracts and
# @posta/core through pnpm workspace symlinks whose target needs its
# compiled dist/ present.
COPY --from=builder --chown=posta:posta /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=posta:posta /app/packages/core/dist ./packages/core/dist
COPY --from=builder --chown=posta:posta /app/apps/worker/dist ./apps/worker/dist

# Documentation only — the health endpoint's actual bind port comes from
# WORKER_PORT at runtime (config-via-env). Matches .env.example's default.
EXPOSE 3002

CMD ["node", "apps/worker/dist/main.js"]
