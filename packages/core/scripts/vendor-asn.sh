#!/usr/bin/env bash
set -euo pipefail

# packages/core/scripts/vendor-asn.sh — T1.4.2/T1.4.4
#
# Downloads the upstream datacenter/hosting ASN list (brianhama/bad-asn-list,
# MIT license) and regenerates packages/core/scripts/data/datacenter-asns.json
# via vendor-asn.mjs. Committed rather than fetched at runtime — see that
# JSON file's own "provenance" header and CLAUDE.md's decision log: a
# classification input that changes silently would invalidate E4's golden
# corpus without a diff.
#
# Usage: packages/core/scripts/vendor-asn.sh   (also `pnpm --filter @posta/core vendor:asn`)
# Re-run this after editing SUPPLEMENTAL_ENTRIES in vendor-asn.mjs, or
# periodically to pick up the upstream list's own additions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_URL="https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv"
TMP_CSV="$(mktemp -t vendor-asn-XXXXXX.csv)"
trap 'rm -f "$TMP_CSV"' EXIT

echo "vendor-asn: downloading ${UPSTREAM_URL}..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMP_CSV" "$UPSTREAM_URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP_CSV" "$UPSTREAM_URL"
else
  echo "vendor-asn: neither curl nor wget is available on this system" >&2
  exit 1
fi

node "$SCRIPT_DIR/vendor-asn.ts" "$TMP_CSV" "$SCRIPT_DIR/data/datacenter-asns.json"
