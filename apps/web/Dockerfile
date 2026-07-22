# apps/web/Dockerfile — T0.7.6 (multi-stage), hardened non-root in T0.7.7.
# web has no SIGTERM task in T0.7.8 (that's api/worker only, see the
# plan) — Next's own standalone server already handles SIGTERM/SIGINT to
# stop accepting new connections and let in-flight ones drain.
#
# Build context is the REPO ROOT (`docker build -f apps/web/Dockerfile .`).
# Same pruner/deps/builder stages as apps/api and apps/worker (see
# apps/api/Dockerfile for the fuller rationale) — the runner stage is what
# differs: standalone Next output needs no `node_modules` reinstall at
# all, self-contained instead of prod-deps-via-pnpm.

ARG NODE_BASE=node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
ARG NODE_RUNTIME_BASE=node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# ---------------------------------------------------------------- pruner --
FROM ${NODE_BASE} AS pruner
WORKDIR /app
RUN npm install -g turbo@2.10.5
COPY . .
RUN turbo prune @posta/web --docker

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
# prune` never carries.
COPY tsconfig.base.json ./tsconfig.base.json
# apps/web/public doesn't exist yet in this repo. The runner stage below
# copies it unconditionally (Docker COPY has no "if it exists" form), so
# guarantee it's there — empty is fine — rather than have the very first
# static asset someone adds be the commit that makes this Dockerfile
# start needing a conditional it never had before.
RUN mkdir -p apps/web/public
# next.config.ts sets `output: 'standalone'` (this same commit) — without
# it this build step is unchanged, but the runtime stage below would need
# the full workspace node_modules instead of the traced-and-copied subset.
RUN pnpm --filter @posta/web... run build

# ---------------------------------------------------------------- runner --
FROM ${NODE_RUNTIME_BASE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# T0.7.7 — non-root runtime user [security]. See apps/api/Dockerfile for
# why uid 10001 specifically. Created before the COPYs below so
# --chown=posta:posta can resolve the name.
RUN addgroup -g 10001 posta && adduser -D -u 10001 -G posta posta
# No `pnpm install` here at all — Next's standalone output already traced
# and copied exactly the production node_modules subset this server needs
# (see .next/standalone/node_modules after a build). That's the whole
# point of `output: 'standalone'`: unlike api/worker, web's runner doesn't
# reinstall anything.
COPY --from=builder --chown=posta:posta /app/apps/web/.next/standalone ./
COPY --from=builder --chown=posta:posta /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=posta:posta /app/apps/web/public ./apps/web/public
USER posta

# Documentation only — the actual bind port comes from PORT above
# (config-via-env). Matches .env.example's WEB_PORT default.
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
