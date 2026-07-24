import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T1.4.2 — validates the vendored dataset itself (packages/core/scripts/
// vendor-asn.sh regenerates it from the upstream source named in its
// "provenance" header). Not a mock: reads the real committed JSON file
// off disk, the same file T1.4.3's seed script reads at seed time.
const DATASET_PATH = path.join(import.meta.dirname, 'datacenter-asns.json');

interface AsnEntry {
  readonly asn: unknown;
  readonly name: unknown;
  readonly source: unknown;
}

interface Dataset {
  readonly provenance: {
    readonly upstreamSource: unknown;
    readonly pulledAt: unknown;
  };
  readonly entries: readonly AsnEntry[];
}

function loadDataset(): Dataset {
  return JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Dataset;
}

describe('datacenter-asns.json (T1.4.2)', () => {
  it('has a provenance header naming the upstream source and the date pulled', () => {
    const dataset = loadDataset();

    expect(typeof dataset.provenance.upstreamSource).toBe('string');
    expect(dataset.provenance.upstreamSource).toMatch(/^https?:\/\//);
    expect(dataset.provenance.pulledAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has at least 200 entries', () => {
    const dataset = loadDataset();

    expect(dataset.entries.length).toBeGreaterThanOrEqual(200);
  });

  it('every entry has asn (positive integer), name (non-empty string), and source (non-empty string)', () => {
    const dataset = loadDataset();

    for (const entry of dataset.entries) {
      expect(Number.isInteger(entry.asn)).toBe(true);
      expect(entry.asn as number).toBeGreaterThan(0);
      expect(typeof entry.name).toBe('string');
      expect((entry.name as string).length).toBeGreaterThan(0);
      expect(typeof entry.source).toBe('string');
      expect((entry.source as string).length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate ASNs', () => {
    const dataset = loadDataset();

    const asns = dataset.entries.map((entry) => entry.asn);
    expect(new Set(asns).size).toBe(asns.length);
  });

  it('covers every provider S1.4 names explicitly, with a recognizable name', () => {
    const dataset = loadDataset();
    const byAsn = new Map(dataset.entries.map((entry) => [entry.asn, entry]));

    // { asn, a substring that must appear in its name } — proves each
    // named provider (S1.4's acceptance criteria) is not just present by
    // ASN number but readably identifiable in the `name` column too.
    const required: ReadonlyArray<readonly [number, string]> = [
      [16509, 'Amazon'], // AWS
      [15169, 'Google'], // GCP
      [8075, 'Microsoft'], // Azure
      [14061, 'DigitalOcean'],
      [24940, 'Hetzner'],
      [16276, 'OVH'],
      [63949, 'Linode'],
      [20940, 'Akamai'],
      [20473, 'Vultr'],
      [13335, 'Cloudflare'],
      [31898, 'Oracle'],
      [12876, 'Scaleway'],
      [51167, 'Contabo'],
    ];

    for (const [asn, mustContain] of required) {
      const entry = byAsn.get(asn);
      expect(entry, `expected an entry for ASN ${asn} (${mustContain})`).toBeDefined();
      expect(entry?.name as string).toContain(mustContain);
    }
  });
});

describe('the dedup/validation logic itself catches a genuinely broken dataset', () => {
  // A negative-case sanity check on the ASSERTIONS above, not the real
  // file: proves "unique positive integers" would actually fail loudly
  // on a duplicate or non-positive ASN, rather than passing by accident
  // (e.g. because Number.isInteger(undefined) happens to be false too).
  it('a duplicate-ASN fixture fails the uniqueness check', () => {
    const brokenEntries = [
      { asn: 1, name: 'A', source: 'test' },
      { asn: 1, name: 'B', source: 'test' },
    ];
    const asns = brokenEntries.map((entry) => entry.asn);
    expect(new Set(asns).size).not.toBe(asns.length);
  });

  it('a zero/negative-ASN fixture fails the positive-integer check', () => {
    const brokenEntries = [{ asn: 0, name: 'A', source: 'test' }, { asn: -5, name: 'B', source: 'test' }];
    for (const entry of brokenEntries) {
      expect(entry.asn > 0).toBe(false);
    }
  });
});
