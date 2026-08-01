import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../../test/pg-container';
import { loadCorpus } from './load';
import type { Fixture } from './schema';
import { assertGoldenCorpusPasses, formatGoldenMismatches, runGoldenCorpus } from './runner';

// T4.4.2 [E4, S4.4] — proves the golden RUNNER mechanism itself (T4.4.1
// shipped the fixture format + loader; this task wires them to a real
// Postgres and events_classified, T4.1.1). Deliberately NOT the production
// corpus: every fixture here is written to a throwaway temp directory and
// loaded through the real `loadCorpus`, the same pattern load.test.ts uses
// for its own synthetic fixtures — no *.json file under
// packages/core/src/classification/corpus/ itself is ever committed by
// this file. The real seed data (browsers.json, unfurlers.json,
// prefetch.json, scripted.json, datacenter.json, adversarial.json) is
// T4.4.3-T4.4.8's job, and every one of those tasks will replay its
// fixtures through this SAME runGoldenCorpus.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations', 'sql');

const REALISTIC_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';
const REALISTIC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.0 Safari/605.1.15';
const REALISTIC_CLIENT_HINTS = '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="24"';

/** Every signal present — a full, unambiguous browser fingerprint that rules 1-7 all decline. */
const FULL_BROWSER_SIGNALS = {
  http_method: 'GET',
  user_agent: REALISTIC_CHROME_UA,
  referer: null,
  accept: 'text/html,application/xhtml+xml',
  accept_language: 'es-AR,es;q=0.9',
  sec_fetch_site: 'none',
  sec_fetch_mode: 'navigate',
  sec_fetch_dest: 'document',
  sec_fetch_user: '?1',
  sec_purpose: null,
  sec_ch_ua: REALISTIC_CLIENT_HINTS,
  sec_ch_ua_mobile: '?0',
  sec_ch_ua_platform: '"Windows"',
  purpose: null,
  x_purpose: null,
  x_moz: null,
  country: 'AR',
  asn: null,
} as const;

const NO_SIGNAL = {
  referer: null,
  accept: null,
  accept_language: null,
  sec_fetch_site: null,
  sec_fetch_mode: null,
  sec_fetch_dest: null,
  sec_fetch_user: null,
  sec_purpose: null,
  sec_ch_ua: null,
  sec_ch_ua_mobile: null,
  sec_ch_ua_platform: null,
  purpose: null,
  x_purpose: null,
  x_moz: null,
  country: null,
  asn: null,
} as const;

/**
 * Six small, test-owned fixtures — one for each of the four families the
 * task asks for (humano, unfurler-by-UA, prefetch, scripted-bot), plus two
 * bonus ordering-adjacent rules (unfurler-by-HEAD, bot-by-no-UA) that come
 * nearly free once FULL_BROWSER_SIGNALS/NO_SIGNAL exist. Not an attempt at
 * covering all 8 rules — that is the real corpus's job (T4.4.3+).
 */
const GOLDEN_TEST_FIXTURES: readonly Record<string, unknown>[] = [
  {
    id: 'golden-runner-browser-humano-01',
    signals: FULL_BROWSER_SIGNALS,
    expect: { classification: 'humano', why: 'humano' },
    provenance: 'hand-authored for T4.4.2 golden runner test, rule 8 (else -> humano)',
  },
  {
    id: 'golden-runner-unfurler-facebook-01',
    signals: {
      ...NO_SIGNAL,
      http_method: 'GET',
      user_agent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    },
    expect: { classification: 'unfurler', why: `user-agent 'facebookexternalhit'` },
    provenance: 'hand-authored for T4.4.2 golden runner test, rule 2 (known unfurler UA)',
  },
  {
    id: 'golden-runner-prefetch-chrome-01',
    signals: { ...FULL_BROWSER_SIGNALS, sec_purpose: 'prefetch' },
    expect: { classification: 'prefetch', why: 'preview de link · Purpose: prefetch' },
    provenance: 'hand-authored for T4.4.2 golden runner test, rule 1 (Sec-Purpose: prefetch)',
  },
  {
    id: 'golden-runner-bot-python-requests-01',
    signals: { ...NO_SIGNAL, http_method: 'GET', user_agent: 'python-requests/2.31.0' },
    expect: { classification: 'bot', why: `user-agent 'python-requests'` },
    provenance: 'hand-authored for T4.4.2 golden runner test, rule 4 (scripted-client UA)',
  },
  {
    id: 'golden-runner-unfurler-head-01',
    signals: { ...FULL_BROWSER_SIGNALS, http_method: 'HEAD', user_agent: REALISTIC_SAFARI_UA },
    expect: { classification: 'unfurler', why: 'método HEAD' },
    provenance: 'hand-authored for T4.4.2 golden runner test, rule 3 (HEAD request)',
  },
  {
    id: 'golden-runner-bot-no-ua-01',
    signals: { ...NO_SIGNAL, http_method: 'GET', user_agent: null },
    expect: { classification: 'bot', why: 'sin user-agent' },
    provenance: 'hand-authored for T4.4.2 golden runner test, rule 5 (no user-agent at all)',
  },
];

/** Mirrors load.test.ts's withTempCorpusDir: writes one fixture-array file, runs `run(dir)`, always cleans up. */
function withTempCorpusDir(fixtures: readonly Record<string, unknown>[], run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'posta-corpus-golden-'));
  try {
    writeFileSync(path.join(dir, 'golden-runner-fixtures.json'), JSON.stringify(fixtures, null, 2));
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('golden corpus runner (T4.4.2)', () => {
  let handle: PgContainerHandle;
  let fixtures: Fixture[] = [];

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    withTempCorpusDir(GOLDEN_TEST_FIXTURES, (dir) => {
      fixtures = loadCorpus(dir);
    });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('loaded all six test-owned fixtures via loadCorpus (sanity check on the fixture set itself)', () => {
    expect(fixtures).toHaveLength(6);
    expect(fixtures.map((fixture) => fixture.id).sort()).toEqual(
      [
        'golden-runner-bot-no-ua-01',
        'golden-runner-bot-python-requests-01',
        'golden-runner-browser-humano-01',
        'golden-runner-prefetch-chrome-01',
        'golden-runner-unfurler-facebook-01',
        'golden-runner-unfurler-head-01',
      ].sort(),
    );
  });

  it(
    'reports every fixture passing when the corpus agrees with events_classified — ' +
      'covering humano, unfurler (by UA and by HEAD), prefetch, and scripted-bot',
    async () => {
      const result = await runGoldenCorpus(fixtures, handle.pool);

      expect(result.mismatches).toEqual([]);
      expect(result.total).toBe(6);
      expect(result.passed).toBe(6);
      // assertGoldenCorpusPasses must be a true no-op on a clean run.
      expect(() => assertGoldenCorpusPasses(result)).not.toThrow();
    },
  );

  it(
    'detects and reports a mismatch when a fixture\'s expect.classification is deliberately ' +
      'wrong — the runner itself is expected to catch this, not the surrounding test suite',
    async () => {
      const target = fixtures.find((fixture) => fixture.id === 'golden-runner-browser-humano-01');
      if (!target) throw new Error('fixture setup broken: golden-runner-browser-humano-01 missing');

      // The view will still (correctly) classify this event as "humano" —
      // only the FIXTURE's stated expectation is flipped to "bot", a
      // classification the view can never actually produce for this UA
      // and signal set.
      const flipped: Fixture = { ...target, expect: { ...target.expect, classification: 'bot' } };
      const fixturesWithFlip = fixtures.map((fixture) => (fixture.id === flipped.id ? flipped : fixture));

      const result = await runGoldenCorpus(fixturesWithFlip, handle.pool);

      expect(result.total).toBe(6);
      expect(result.passed).toBe(5);
      expect(result.mismatches).toHaveLength(1);

      const [mismatch] = result.mismatches;
      expect(mismatch.fixtureId).toBe('golden-runner-browser-humano-01');
      expect(mismatch.expected.classification).toBe('bot');
      expect(mismatch.actual.classification).toBe('humano');

      // The formatted report a maintainer actually reads must name the
      // fixture and spell out both sides of the disagreement.
      const report = formatGoldenMismatches(result.mismatches);
      expect(report).toContain('golden-runner-browser-humano-01');
      expect(report).toContain('expected "bot"');
      expect(report).toContain('got "humano"');

      // assertGoldenCorpusPasses must surface the SAME information via throw.
      expect(() => assertGoldenCorpusPasses(result)).toThrow(/golden-runner-browser-humano-01/);
      expect(() => assertGoldenCorpusPasses(result)).toThrow(/expected "bot", got "humano"/);
    },
  );
});
