#!/usr/bin/env node
// T1.4.2 — regenerates packages/core/scripts/data/datacenter-asns.json.
//
// Vendored, not fetched at runtime (see that file's "provenance" header
// and CLAUDE.md's decision log): a classification input that changes
// silently would invalidate E4's golden corpus without a diff. This
// script is the documented, re-runnable "refresh" (T1.4.4 points here) —
// it downloads the upstream CSV, transforms it, and WRITES the committed
// JSON; it never runs at deploy/request time.
//
// Usage: scripts/vendor-asn.sh (downloads the CSV, then calls this with
// the CSV path) — or directly: node vendor-asn.ts <csv-path> [out-path]
// Node 24's native TypeScript support runs this file directly; there is
// no plain-JS syntax here it couldn't already run unchanged, but .ts
// matches every other script in this repo (and keeps this file inside
// typescript-eslint's no-undef exemption for Node globals, rather than
// needing a bespoke ESLint override for a lone .mjs file).
import { readFileSync, writeFileSync } from 'node:fs';

const UPSTREAM_URL = 'https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv';
const UPSTREAM_LICENSE = 'MIT license';

interface AsnEntry {
  readonly asn: number;
  readonly name: string;
  readonly source: string;
}

// Providers the S1.4 acceptance criteria names explicitly. Some (AWS,
// GCP, Azure, DigitalOcean) already have a usable row in the upstream
// CSV once cleanName() strips its "Slug-As - " prefix; others (Cloudflare,
// Oracle) have no row there at all, because bad-asn-list catalogs
// hosting/colo ASNs specifically, not CDN/PaaS ones. Every ASN below is a
// real, publicly documented registration (bgp.he.net / PeeringDB /
// provider network docs), added by ASN — never resolved by hostname, so
// this carries no SSRF/DNS-rebinding surface (same reasoning as the
// destination-literal check in CLAUDE.md's decision log).
const SUPPLEMENTAL_ENTRIES: readonly AsnEntry[] = (
  [
    [16509, 'Amazon.com, Inc. (AWS)'],
    [14618, 'Amazon.com, Inc. (AWS EC2)'],
    [8987, 'Amazon.com, Inc. (AWS Europe)'],
    [15169, 'Google LLC'],
    [396982, 'Google LLC (Google Cloud)'],
    [8075, 'Microsoft Corporation (Azure/MSN)'],
    [8068, 'Microsoft Corporation'],
    [12076, 'Microsoft Corporation'],
    [14061, 'DigitalOcean, LLC'],
    [24940, 'Hetzner Online GmbH'],
    [16276, 'OVH SAS'],
    [63949, 'Linode, LLC (Akamai Technologies)'],
    [20940, 'Akamai International B.V.'],
    [20473, 'The Constant Company, LLC (Vultr)'],
    [13335, 'Cloudflare, Inc.'],
    [209242, 'Cloudflare London, LLC'],
    [31898, 'Oracle Corporation (Oracle Cloud Infrastructure)'],
    [12876, 'Scaleway (Online S.A.S.)'],
    [51167, 'Contabo GmbH'],
  ] as const
).map(([asn, name]) => ({ asn, name, source: 'public ASN registration (bgp.he.net / PeeringDB)' }));

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/gi, '&');
}

// Most upstream rows follow "Slug-As - Real Org Name, Cc" — the part
// before " - " is a machine-generated ASN handle, not the org name.
// Rows with no " - " separator (e.g. "Voxility, Ro") are already a bare
// name and pass through unchanged.
function cleanName(rawName: string): string {
  const decoded = decodeEntities(rawName).trim();
  const dashIndex = decoded.indexOf(' - ');
  const withoutPrefix = dashIndex === -1 ? decoded : decoded.slice(dashIndex + 3);
  return withoutPrefix.replace(/\s+/g, ' ').trim();
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

interface RawRow {
  readonly asn: number;
  readonly name: string;
}

function parseCsv(csvText: string): RawRow[] {
  const lines = csvText.split('\n').filter((line) => line.trim().length > 0);
  const [, ...rows] = lines; // drop the "ASN,Entity" header row
  return rows.map((line) => {
    const [asnText, nameText] = parseCsvLine(line);
    return { asn: Number(asnText), name: cleanName(nameText ?? '') };
  });
}

function buildEntries(csvRows: readonly RawRow[]): AsnEntry[] {
  // A Map keyed by ASN: later writes overwrite earlier ones, which is
  // what lets SUPPLEMENTAL_ENTRIES (applied after the CSV rows) win over
  // upstream's messier/missing names for the same ASN, and also
  // resolves the handful of ASNs bad-asn-list itself lists twice.
  const byAsn = new Map<number, AsnEntry>();
  for (const row of csvRows) {
    if (!Number.isInteger(row.asn) || row.asn <= 0 || !row.name) continue;
    byAsn.set(row.asn, { asn: row.asn, name: row.name, source: 'brianhama/bad-asn-list' });
  }
  for (const entry of SUPPLEMENTAL_ENTRIES) {
    byAsn.set(entry.asn, entry);
  }
  return [...byAsn.values()].sort((a, b) => a.asn - b.asn);
}

function main(): void {
  const csvPath = process.argv[2];
  const outPath = process.argv[3] ?? new URL('./data/datacenter-asns.json', import.meta.url).pathname;
  if (!csvPath) {
    console.error('usage: node vendor-asn.ts <csv-path> [out-path]');
    process.exit(1);
  }

  const csvText = readFileSync(csvPath, 'utf8');
  const entries = buildEntries(parseCsv(csvText));

  if (entries.length < 200) {
    throw new Error(`vendor-asn: only produced ${entries.length} entries, need at least 200`);
  }
  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.asn)) throw new Error(`vendor-asn: duplicate asn ${entry.asn} after dedup`);
    seen.add(entry.asn);
  }

  const dataset = {
    provenance: {
      upstreamSource: `${UPSTREAM_URL} (${UPSTREAM_LICENSE})`,
      pulledAt: new Date().toISOString().slice(0, 10),
      supplementedWith:
        'public ASN registration records (bgp.he.net / PeeringDB) for major providers ' +
        'the upstream hosting/colo list omits or names ambiguously — see SUPPLEMENTAL_ENTRIES ' +
        'in vendor-asn.ts',
      refresh: 'packages/core/scripts/vendor-asn.sh (see packages/core/scripts/data/README.md)',
    },
    entries,
  };

  writeFileSync(outPath, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(`vendor-asn: wrote ${entries.length} entries to ${outPath}`);
}

main();
