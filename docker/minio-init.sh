#!/bin/sh
# Posta — one-shot MinIO bucket bootstrap (S0.4, T0.4.4).
#
# Runs once against the already-healthy minio service and creates the two
# buckets the app needs, so a fresh clone needs no manual console step.
# `mc mb --ignore-existing` makes this safe to run again on every
# `docker compose up` — an existing bucket is left untouched.
set -eu

# Fail with a clear message if these arrive empty (e.g. a blank R2_ACCESS_KEY_ID
# / R2_SECRET_ACCESS_KEY / R2_BUCKET_* in .env), rather than letting `mc` fail
# later with an opaque credential/auth error that doesn't point at the cause.
: "${MINIO_ROOT_USER:?minio-init: MINIO_ROOT_USER is empty — check R2_ACCESS_KEY_ID in .env}"
: "${MINIO_ROOT_PASSWORD:?minio-init: MINIO_ROOT_PASSWORD is empty — check R2_SECRET_ACCESS_KEY in .env}"
: "${R2_BUCKET_EVENTS:?minio-init: R2_BUCKET_EVENTS is empty — check .env}"
: "${R2_BUCKET_AVATARS:?minio-init: R2_BUCKET_AVATARS is empty — check .env}"

mc alias set local "http://minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$R2_BUCKET_EVENTS"
mc mb --ignore-existing "local/$R2_BUCKET_AVATARS"
echo "minio-init: buckets ready — $R2_BUCKET_EVENTS, $R2_BUCKET_AVATARS"
