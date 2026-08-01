import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from './load';
import type { Fixture } from './schema';

// T4.4.1 [E4, S4.4] — the corpus fixture format + loader. This file proves
// the LOADER's behavior (validation, duplicate-id detection, error
// messages) against small, throwaway fixture sets written to a temp
// directory — same mkdtempSync/rmSync pattern
// packages/core/src/analytics/no-raw-events.test.ts already uses for its
// own synthetic fixtures. This is deliberately NOT the production corpus:
// no *.json file here is ever committed under
// packages/core/src/classification/corpus/ itself — that's T4.4.3+'s job.

const VALID_SIGNALS = {
  http_method: 'GET',
  user_agent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  referer: null,
  accept: 'text/html,application/xhtml+xml',
  accept_language: 'es-AR,es;q=0.9',
  sec_fetch_site: 'none',
  sec_fetch_mode: 'navigate',
  sec_fetch_dest: 'document',
  sec_fetch_user: '?1',
  sec_purpose: null,
  sec_ch_ua: '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"',
  sec_ch_ua_mobile: '?0',
  sec_ch_ua_platform: '"Windows"',
  purpose: null,
  x_purpose: null,
  x_moz: null,
  country: 'AR',
  asn: 7303,
} as const;

function validFixture(id: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    signals: VALID_SIGNALS,
    expect: { classification: 'humano', why: 'browser navigation with full client hints' },
    provenance: 'hand-authored, spec §7.1 rule 8 (else -> humano)',
    ...overrides,
  };
}

/**
 * Writes `files` (filename -> JS value, JSON.stringify'd) into a fresh temp
 * directory, runs `run(dir)`, then always removes the directory — mirrors
 * no-raw-events.test.ts's withTempScanRoot.
 */
function withTempCorpusDir(files: Record<string, unknown>, run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'posta-corpus-load-'));
  try {
    for (const [filename, contents] of Object.entries(files)) {
      writeFileSync(path.join(dir, filename), JSON.stringify(contents, null, 2));
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadCorpus — valid fixtures', () => {
  it('loads a single valid fixture from an array-shaped file', () => {
    withTempCorpusDir({ 'browsers.json': [validFixture('browser-chrome-desktop-01')] }, (dir) => {
      const fixtures = loadCorpus(dir);

      expect(fixtures).toHaveLength(1);
      expect(fixtures[0]).toMatchObject({
        id: 'browser-chrome-desktop-01',
        expect: { classification: 'humano' },
      });
    });
  });

  it('loads a single valid fixture from a file containing one bare object (not wrapped in an array)', () => {
    withTempCorpusDir({ 'single.json': validFixture('single-fixture-01') }, (dir) => {
      const fixtures = loadCorpus(dir);

      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].id).toBe('single-fixture-01');
    });
  });

  it('loads fixtures from multiple files, combining them into one list', () => {
    withTempCorpusDir(
      {
        'browsers.json': [validFixture('browser-01'), validFixture('browser-02')],
        'bots.json': [validFixture('bot-01', { expect: { classification: 'bot', why: 'user-agent curl' } })],
      },
      (dir) => {
        const fixtures = loadCorpus(dir);

        expect(fixtures.map((fixture) => fixture.id).sort()).toEqual(['bot-01', 'browser-01', 'browser-02']);
      },
    );
  });

  it('returns an empty array for a directory with no *.json files', () => {
    withTempCorpusDir({}, (dir) => {
      expect(loadCorpus(dir)).toEqual([]);
    });
  });

  it('ignores non-JSON files sitting alongside the corpus', () => {
    withTempCorpusDir({ 'browsers.json': [validFixture('browser-only-01')] }, (dir) => {
      writeFileSync(path.join(dir, 'README.md'), '# not a fixture file\n');

      const fixtures = loadCorpus(dir);

      expect(fixtures).toHaveLength(1);
    });
  });

  it('defaults to this module\'s own directory when no dir is passed, and finds no stray fixtures yet (T4.4.1 ships no production corpus data)', () => {
    const fixtures: Fixture[] = loadCorpus();

    expect(fixtures).toEqual([]);
  });
});

describe('loadCorpus — rejects a fixture missing provenance', () => {
  it('throws, naming the fixture id, when provenance is entirely absent', () => {
    const fixture = validFixture('missing-provenance-01');
    delete (fixture as Record<string, unknown>).provenance;

    withTempCorpusDir({ 'bad.json': [fixture] }, (dir) => {
      expect(() => loadCorpus(dir)).toThrow(/missing-provenance-01/);
    });
  });

  it('throws, naming the fixture id, when provenance is an empty string', () => {
    withTempCorpusDir({ 'bad.json': [validFixture('blank-provenance-01', { provenance: '' })] }, (dir) => {
      expect(() => loadCorpus(dir)).toThrow(/blank-provenance-01/);
    });
  });
});

describe('loadCorpus — rejects duplicate ids', () => {
  it('throws, naming the id, when two fixtures in the SAME file share an id', () => {
    withTempCorpusDir({ 'dupes.json': [validFixture('dup-same-file-01'), validFixture('dup-same-file-01')] }, (dir) => {
      expect(() => loadCorpus(dir)).toThrow(/dup-same-file-01/);
    });
  });

  it('throws, naming the id and both files, when two fixtures in DIFFERENT files share an id', () => {
    withTempCorpusDir(
      {
        'a.json': [validFixture('dup-cross-file-01')],
        'b.json': [validFixture('dup-cross-file-01')],
      },
      (dir) => {
        expect(() => loadCorpus(dir)).toThrow(/dup-cross-file-01/);
        expect(() => loadCorpus(dir)).toThrow(/a\.json/);
        expect(() => loadCorpus(dir)).toThrow(/b\.json/);
      },
    );
  });
});

describe('loadCorpus — rejects an unknown expect.classification value', () => {
  it('throws, naming the fixture id, for classification "maybe"', () => {
    withTempCorpusDir(
      {
        'bad-classification.json': [
          validFixture('bad-classification-01', { expect: { classification: 'maybe', why: 'nonsense' } }),
        ],
      },
      (dir) => {
        expect(() => loadCorpus(dir)).toThrow(/bad-classification-01/);
      },
    );
  });
});

describe('loadCorpus — other malformed input', () => {
  it('throws, naming the file, for invalid JSON', () => {
    withTempCorpusDir({}, (dir) => {
      writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');

      expect(() => loadCorpus(dir)).toThrow(/broken\.json/);
    });
  });

  it('throws for a file whose top-level JSON value is neither an object nor an array', () => {
    withTempCorpusDir({}, (dir) => {
      writeFileSync(path.join(dir, 'scalar.json'), '"just a string"');

      expect(() => loadCorpus(dir)).toThrow(/scalar\.json/);
    });
  });

  it('throws, naming the fixture id, for a fixture missing a required signal key', () => {
    const fixture = validFixture('missing-signal-01');
    const signals = { ...(fixture.signals as Record<string, unknown>) };
    delete signals.user_agent;
    fixture.signals = signals;

    withTempCorpusDir({ 'bad.json': [fixture] }, (dir) => {
      expect(() => loadCorpus(dir)).toThrow(/missing-signal-01/);
    });
  });

  it('throws for a fixture carrying an unknown extra top-level key (schema is strict)', () => {
    withTempCorpusDir(
      { 'bad.json': [validFixture('extra-key-01', { unexpected_field: 'nope' })] },
      (dir) => {
        expect(() => loadCorpus(dir)).toThrow(/extra-key-01/);
      },
    );
  });
});
