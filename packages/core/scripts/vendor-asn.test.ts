import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEntries, decodeEntities, parseCsv, parseCsvLine } from './vendor-asn';

// S1.4 review fan-out fixes, verified directly (not just by re-running
// vendor-asn.sh against the real upstream file, which never happens to
// exercise any of these error paths today).
describe('parseCsvLine', () => {
  it('parses a quoted field containing a comma', () => {
    expect(parseCsvLine('123,"Some, Company, Inc."')).toEqual(['123', 'Some, Company, Inc.']);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsvLine('1,"Say ""hi"" there"')).toEqual(['1', 'Say "hi" there']);
  });

  it('throws on a quote appearing mid-field, rather than silently misparsing', () => {
    expect(() => parseCsvLine('1,foo"bar,baz')).toThrow(/unexpected quote mid-field/);
  });
});

describe('decodeEntities', () => {
  it('decodes numeric HTML entities and &amp; regardless of case', () => {
    expect(decodeEntities('Solu&#231;&#245;es &Amp; Co')).toBe('Soluções & Co');
  });
});

describe('parseCsv', () => {
  it('parses rows after a valid "ASN,Entity" header', () => {
    const rows = parseCsv('ASN,Entity\n1,"Foo, Inc."\n2,Bar\n');
    expect(rows).toEqual([
      { asn: 1, name: 'Foo, Inc.' },
      { asn: 2, name: 'Bar' },
    ]);
  });

  it('throws when the header does not match — a format change should fail loudly, not misparse', () => {
    expect(() => parseCsv('ASN,Name\n1,Foo\n')).toThrow(/expected the CSV header to be/);
  });

  it('throws on an empty file', () => {
    expect(() => parseCsv('')).toThrow(/expected the CSV header to be/);
  });
});

describe('buildEntries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops malformed rows (non-integer/non-positive ASN, blank name) and warns with a count', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // buildEntries always merges in SUPPLEMENTAL_ENTRIES on top of the
    // CSV rows given, so this asserts on the ONE row under test rather
    // than the full output array (which would otherwise also need to
    // duplicate the entire supplemental list here).
    const entries = buildEntries([
      { asn: 999_999_001, name: 'Good Entry' },
      { asn: Number.NaN, name: 'Bad ASN' },
      { asn: 0, name: 'Zero ASN' },
      { asn: 999_999_002, name: '' },
    ]);

    expect(entries).toContainEqual({
      asn: 999_999_001,
      name: 'Good Entry',
      source: 'brianhama/bad-asn-list',
    });
    expect(entries.some((entry) => entry.asn === 999_999_002)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped 3 malformed row(s)'));
  });

  it('does not warn when every row is well-formed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    buildEntries([{ asn: 1, name: 'Good Entry' }]);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a supplemental entry overrides the CSV row for the same ASN', () => {
    // AWS's ASN (16509) is both in SUPPLEMENTAL_ENTRIES and present in
    // any real CSV row for it — the supplemental name must win.
    const entries = buildEntries([{ asn: 16509, name: 'Some Upstream Name, Us' }]);
    const aws = entries.find((entry) => entry.asn === 16509);
    expect(aws?.name).toBe('Amazon.com, Inc. (AWS)');
    expect(aws?.source).toBe('public ASN registration (bgp.he.net / PeeringDB)');
  });
});
