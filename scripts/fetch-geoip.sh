#!/usr/bin/env bash
set -euo pipefail

# scripts/fetch-geoip.sh — T0.7.9 (S0.7)
#
# Downloads DB-IP's free "lite" GeoIP databases into data/geoip/. TWO files
# are required — the ASN database carries no country data, and vice versa:
#   dbip-asn-lite.mmdb       which network owns an IP (classification rule 6)
#   dbip-country-lite.mmdb  country, when CF-IPCountry is absent
#
# DB-IP lite is CC BY 4.0 — no account, no licence key, free redistribution.
# That single licence difference (over MaxMind's non-redistributable
# GeoLite2 EULA) is the ONLY reason these files can be baked straight into
# the api image at build time (T0.7.10) instead of needing an init
# container or a licence Secret — see CLAUDE.md's decision log. The
# attribution string the bio-page footer must carry (E8) lives in
# docs/ops/geoip.md.
#
# Releases are monthly and land MID-month (DB-IP's own release schedule) —
# so the current calendar month's file can still 404 for the first couple
# of weeks. This script tries the current year-month first and falls back
# to the previous one, rather than hard-failing on that date edge.
#
# Usage: scripts/fetch-geoip.sh   (also exposed as `pnpm geo:fetch`)
#
# Runs identically on the HOST (dev machine, any OS) and inside the api
# image's Docker builder stage (Alpine, T0.7.10) — so it can only rely on
# tools present on BOTH. Verified directly against both environments:
#   - macOS ships curl, not wget; node:24-alpine ships busybox wget, not
#     curl — neither environment has both, so `download()` below tries
#     curl first and falls back to wget rather than assuming either.
#   - GNU `date -d "<date> -1 month"` is NOT available on either side:
#     BSD date (macOS) has no -d flag at all, and Alpine's busybox date -d
#     accepts a fixed date string but rejects relative offsets ("invalid
#     date"). Previous-month arithmetic is therefore done on the plain
#     year/month integers instead of via date(1) at all.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Follows GEOIP_DB_DIR (apps/api/src/env.ts, .env.example's default
# ./data/geoip) rather than hardcoding "data/geoip" as a second,
# independent source of truth for the same path — the two matched only by
# coincidence before this. Falls back to "data/geoip" when the var isn't
# set (e.g. a bare `bash scripts/fetch-geoip.sh` outside any .env context),
# which is exactly the same value that fallback used to be hardcoded to.
OUT_DIR="${GEOIP_DB_DIR:-data/geoip}"
mkdir -p "$OUT_DIR"

DATABASES=("dbip-asn-lite" "dbip-country-lite")

# download <url> <dest-path> — curl first (the host default), wget second
# (Alpine's busybox default). Fails loudly if neither exists rather than
# silently producing no file.
download() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    echo "fetch-geoip: neither curl nor wget is available on this system" >&2
    return 1
  fi
}

this_year="$(date -u +%Y)"
this_month="$(date -u +%m)"
this_year_month="${this_year}-${this_month}"

# Previous month, by integer arithmetic on year/month — see the file header
# for why date(1) itself can't do this portably here. `10#` forces base-10
# parsing so a month like "08" or "09" isn't misread as an invalid octal
# literal by bash's arithmetic context.
this_month_num=$((10#${this_month}))
if [[ "$this_month_num" -eq 1 ]]; then
  prev_year=$((this_year - 1))
  prev_month_num=12
else
  prev_year="$this_year"
  prev_month_num=$((this_month_num - 1))
fi
prev_year_month="$(printf '%s-%02d' "$prev_year" "$prev_month_num")"

fetch_one() {
  local db="$1"
  local gz_path="$OUT_DIR/${db}.mmdb.gz"
  local mmdb_path="$OUT_DIR/${db}.mmdb"
  local url="https://download.db-ip.com/free/${db}-${this_year_month}.mmdb.gz"

  echo "fetch-geoip: fetching ${db} for ${this_year_month}..."
  if ! download "$url" "$gz_path"; then
    rm -f "$gz_path"
    echo "fetch-geoip: ${this_year_month} release not found for ${db} (DB-IP releases mid-month) — falling back to ${prev_year_month}" >&2
    url="https://download.db-ip.com/free/${db}-${prev_year_month}.mmdb.gz"
    if ! download "$url" "$gz_path"; then
      rm -f "$gz_path"
      echo "fetch-geoip: could not download ${db} for ${this_year_month} or ${prev_year_month} — aborting" >&2
      exit 1
    fi
    echo "fetch-geoip: downloaded ${db} for ${prev_year_month} (fallback month)"
  else
    echo "fetch-geoip: downloaded ${db} for ${this_year_month}"
  fi

  gunzip -f "$gz_path"
  echo "fetch-geoip: wrote ${mmdb_path}"
}

for db in "${DATABASES[@]}"; do
  fetch_one "$db"
done

# A missing/corrupt file must fail loudly here, at fetch time — not later,
# silently, as an API that emits asn:null on every event once it can't open
# a bad GEOIP_DB_DIR file (see .env.example's GEOIP section). `maxmind`'s
# `Reader` class (re-exported from mmdb-lib) is the real MMDB reader both
# DB-IP and MaxMind's format share (same on-disk format, decision log) — the
# same one E4's classification code will use, so this is the first real
# exercise of it, not a throwaway check. `Reader` takes a Buffer
# synchronously — maxmind's own top-level `open`/`openSync` are async-only
# (`openSync` is deliberately disabled and throws as of v5) and not worth
# an event-loop round trip inside a shell script's verification step.
echo "fetch-geoip: verifying both files with a real MMDB reader (maxmind)..."
node -e "
const { Reader } = require('maxmind');
const fs = require('fs');
const path = require('path');
const files = ['dbip-asn-lite.mmdb', 'dbip-country-lite.mmdb'];
for (const file of files) {
  const dbPath = path.join('${OUT_DIR}', file);
  const reader = new Reader(fs.readFileSync(dbPath));
  console.log('fetch-geoip: ' + file + ' opened OK (databaseType=' + reader.metadata.databaseType + ')');
}
"

echo "fetch-geoip: done — both .mmdb files verified under ${OUT_DIR}/"
