#!/usr/bin/env bash
set -euo pipefail

# scripts/docker-prune.sh — T0.7.3
#
# Produces a pruned, per-app build context via `turbo prune`. This is the
# hard part of Dockerising a pnpm monorepo: a naive `COPY . .` Docker build
# context ships every workspace package's manifest and lockfile entries, so
# touching an unrelated `web` component busts the `api` image's deps-layer
# cache on every build. `turbo prune <app> --docker` computes exactly the
# subset of the monorepo <app> and its workspace dependencies need, and
# writes two trees under out/:
#
#   out/json   package.json manifests (every workspace member <app>
#              transitively depends on) + a pruned pnpm-lock.yaml. This is
#              the tree whose CONTENT never changes unless <app> or a
#              package it depends on changes its own dependencies — which
#              is what makes the Docker `deps` layer (T0.7.4-6) stable
#              across unrelated commits.
#   out/full   the above, plus the actual source files.
#
# The app Dockerfiles run this same `turbo prune` command themselves,
# inside a `pruner` build stage — this script exists for running the same
# prune step outside Docker (local inspection, debugging what a given
# app's build context actually contains).
#
# Usage: scripts/docker-prune.sh <app>     e.g. scripts/docker-prune.sh api
#
# <app> is the short workspace name (api, worker, web) — this script adds
# the @posta/ scope.

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <app>   e.g. $0 api" >&2
  exit 1
fi

APP="$1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -d "apps/$APP" ]]; then
  echo "docker-prune: apps/$APP does not exist" >&2
  exit 1
fi

# turbo prune always writes to ./out relative to cwd — stale output from a
# previous app would otherwise linger and get mistaken for this run's.
rm -rf out

# --scope=@posta/<app> is turbo's older, deprecated flag form (still
# accepted, but it now prints a deprecation warning on every invocation);
# the positional argument is the current form for the identical prune.
pnpm turbo prune "@posta/${APP}" --docker
