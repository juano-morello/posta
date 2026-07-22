#!/bin/bash
# Posta — pnpm dev:reset (S0.4, T0.4.7).
#
# The escape hatch when local data drifts: tears down the compose volumes
# entirely (not just the containers) and brings everything back up from
# nothing, so nobody debugs a stale-schema ghost.
#
# NOTE (E0 scope): there are no Drizzle migrations yet — those land in E1.
# This script recreates an EMPTY database and, if a migration runner
# exists by the time you're reading this, runs it; if not, it prints a
# clear notice and stops there rather than inventing a schema.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "dev:reset — tearing down compose volumes (postgres-data, redis-data, minio-data)..."
docker compose down -v

echo "dev:reset — recreating infra from empty volumes..."
docker compose up -d --wait postgres redis minio
# Second, unwaited `up -d` for the one-shot minio-init: --wait treats its
# expected clean exit as non-convergence (same reasoning as `pnpm dev`,
# T0.4.6), so it always runs as a follow-up step, not inside --wait.
docker compose up -d
# `docker compose wait` blocks until minio-init actually exits and
# propagates ITS exit code — unlike the plain `up -d` above, which returns
# as soon as the container is started, not once it's done. Without this,
# a failed bucket bootstrap (bad credentials, etc.) would go unnoticed:
# the script would print "done" and exit 0 while the buckets never got
# created. `set -e` turns that non-zero exit into a loud, immediate abort.
echo "dev:reset — waiting for minio-init (bucket bootstrap) to finish..."
docker compose wait minio-init

# Check packages/core's own declared scripts directly (not pnpm's --filter
# run output) — this is exact and immune to that output format changing
# in a future pnpm release, unlike a grep over the CLI's listing.
if node -e "process.exit(require('./packages/core/package.json').scripts?.migrate ? 0 : 1)"; then
  echo "dev:reset — running migrations (packages/core migrate)..."
  pnpm --filter @posta/core run migrate
else
  echo "dev:reset — no migration runner exists yet (packages/core has no"
  echo "'migrate' script). E1 adds the Drizzle schema and migrations; until"
  echo "then this leaves an empty, unmigrated database, which is expected."
fi

echo "dev:reset — done."
