#!/usr/bin/env bash
set -euo pipefail

# scripts/refresh-base-digests.sh — T0.7.2
#
# docker/base-images.env pins the Node base image(s) by digest, not by a
# floating tag (see that file's header for why). This script is the ONLY
# sanctioned way to change the pinned digest — never hand-edit it.
#
#   scripts/refresh-base-digests.sh            re-resolve the CURRENT
#                                               digest the registry serves
#                                               for each pinned tag and
#                                               rewrite docker/base-images.env
#                                               (and every apps/*/Dockerfile's
#                                               matching `ARG ...=` default,
#                                               so the two never drift apart)
#
#   scripts/refresh-base-digests.sh --check    exit 0 if the pinned digests
#                                               still match what the
#                                               registry serves today, exit
#                                               1 if they've drifted. Writes
#                                               nothing — this is the CI /
#                                               pre-build drift guard.
#
# Requires `docker buildx` (ships with Docker Desktop and the docker-ce
# buildx plugin) to resolve a tag's OCI manifest-list digest — the same
# value `docker inspect --format '{{.RepoDigests}}'` reports after pulling
# that tag.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/docker/base-images.env"

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "refresh-base-digests: $ENV_FILE not found" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "refresh-base-digests: docker not found on PATH" >&2
  exit 1
fi

# key -> resolved current digest, so the Dockerfile sync pass below doesn't
# have to re-resolve anything a second time.
declare -A CURRENT_DIGEST
drifted=0
pins_found=0
rewritten=""

# Matches lines like: NODE_BASE=node:24-alpine@sha256:<64 hex chars>
# The ref group needs ':' — that's the repo:tag separator in every image
# reference (node:24-alpine) — without it this pattern silently fails to
# match ANY pin line and the whole drift check becomes a no-op.
pin_pattern='^([A-Z_]+)=([A-Za-z0-9._/:-]+)@sha256:([0-9a-f]{64})[[:space:]]*$'

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ $pin_pattern ]]; then
    key="${BASH_REMATCH[1]}"
    ref="${BASH_REMATCH[2]}"
    pinned="sha256:${BASH_REMATCH[3]}"

    current="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
    if [[ -z "$current" ]]; then
      echo "refresh-base-digests: could not resolve $ref — is Docker running and reachable?" >&2
      exit 1
    fi
    CURRENT_DIGEST["$key"]="$ref@$current"
    pins_found=$((pins_found + 1))

    if [[ "$current" != "$pinned" ]]; then
      drifted=1
      echo "refresh-base-digests: $key drifted — pinned $pinned, registry now serves $current for $ref" >&2
    fi

    rewritten+="${key}=${ref}@${current}"$'\n'
  elif [[ "$line" == *"@sha256:"* ]]; then
    # Looks like it's trying to pin a digest but doesn't fully match —
    # fail loudly instead of silently treating it as a passthrough
    # comment line, which would make the drift check quietly stop
    # checking anything.
    echo "refresh-base-digests: malformed pin line, refusing to skip it: $line" >&2
    exit 1
  else
    rewritten+="${line}"$'\n'
  fi
done <"$ENV_FILE"

# A file with zero recognized pins (empty, comments-only, or otherwise
# broken in a way that doesn't trip the malformed-line check above) would
# otherwise let --check exit 0 having verified nothing — a silently
# no-op drift guard is worse than no guard, since it looks green in CI.
if [[ "$pins_found" -eq 0 ]]; then
  echo "refresh-base-digests: no pins found in $ENV_FILE — nothing was verified" >&2
  exit 1
fi

if $CHECK_ONLY; then
  exit "$drifted"
fi

printf '%s' "$rewritten" >"$ENV_FILE"
echo "refresh-base-digests: docker/base-images.env is up to date"

# Keep every Dockerfile's `ARG <KEY>=<ref>@<digest>` default line in
# lockstep — a bare `docker build -f apps/api/Dockerfile .` (no
# --build-arg) relies on that default, so base-images.env being correct
# isn't enough on its own. Silently a no-op before T0.7.4-6 write these
# files; shopt -s nullglob makes the glob below expand to nothing instead
# of the literal pattern when no Dockerfile exists yet.
shopt -s nullglob
for dockerfile in "$REPO_ROOT"/apps/*/Dockerfile; do
  for key in "${!CURRENT_DIGEST[@]}"; do
    value="${CURRENT_DIGEST[$key]}"
    # BSD sed (macOS) and GNU sed (Linux/CI) both accept -i '' vs -i
    # differently; -i.bak with an immediate rm is the one form both agree on.
    # (The trailing $ here is bash's own double-quote expansion producing a
    # literal `$`, passed to sed as the end-of-line anchor — not an escaped
    # sed metacharacter. Verified: this line correctly rewrites a
    # deliberately-corrupted ARG default back to the resolved digest.)
    sed -i.bak -E "s|^ARG ${key}=.*$|ARG ${key}=${value}|" "$dockerfile"
    rm -f "${dockerfile}.bak"
  done
done
