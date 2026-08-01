import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enrich } from './enrich';
import type { EnrichmentInput, EnrichmentResult } from './enrich';

// T3.2.6 (E3, S3.2) — a committed fixture of real { user_agent, referer,
// destination } triples, each with an independently-verified expected
// EnrichmentResult, run through the SAME enrich() T3.2.5 composed (desktop
// and mobile browsers, all six IN_APP_MARKERS webviews, referer-driven
// source_platform resolution, the LATAM Android long tail, dest_host
// variety, and deliberately malformed entries — see the fixture file's own
// per-entry `category`).
//
// This is explicitly NOT the classification corpus (a different, later E4
// concern — no bot/human verdict is asserted or even representable here).
// It only proves enrich() produces the correct DESCRIPTIVE facts (invariant
// 4) for a broad, real-world set of inputs — the fixture's own JSON text is
// separately asserted below to carry no verdict-shaped key at all, so a
// future edit can't quietly turn this into a classification fixture by
// accident.
//
// Reused end-to-end by T3.5.5 (a later task, not this one) — this file's
// job stops at proving enrich() is correct over the fixture; it does not
// concern itself with that later consumer.
const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures/ua-corpus.json');
const FIXTURE_RAW_TEXT = readFileSync(FIXTURE_PATH, 'utf8');

interface CorpusEntry {
  readonly name: string;
  readonly category: string;
  readonly input: EnrichmentInput;
  readonly expected: EnrichmentResult;
}

function loadCorpus(): readonly CorpusEntry[] {
  return JSON.parse(FIXTURE_RAW_TEXT) as readonly CorpusEntry[];
}

describe('ua-corpus.json (T3.2.6) — enrich() over a broad real-world fixture', () => {
  const corpus = loadCorpus();

  it('has at least 40 entries', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
  });

  it.each(corpus)('enriches "$name" ($category) to exactly the expected result', ({ input, expected }) => {
    expect(enrich(input)).toEqual(expected);
  });
});

describe('ua-corpus.json (T3.2.6) — never a classification fixture (invariant 4)', () => {
  // This is NOT the classification corpus (a different, later E4 concern).
  // Read as raw text (not just Object.keys() of the parsed entries) so a
  // verdict-shaped key nested anywhere in the file — inside `input`,
  // `expected`, a future extra field, even a comment-like string value —
  // is caught, not only a top-level one.
  it('contains no key matching verdict|classification|is_bot|is_human anywhere in the file', () => {
    expect(FIXTURE_RAW_TEXT).not.toMatch(/"[^"]*(verdict|classification|is_bot|is_human)[^"]*"\s*:/i);
  });
});
