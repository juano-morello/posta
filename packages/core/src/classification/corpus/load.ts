import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { FixtureSchema, type Fixture } from './schema';

// T4.4.1 [E4, S4.4] — loads and validates every fixture in the
// classification corpus (packages/core/src/classification/corpus/, or an
// injectable `dir` for testability — see load.test.ts's temp-directory
// fixtures). This task ships the loader itself with no real corpus data
// yet: T4.4.3+ populate corpus/*.json (browsers.json, unfurlers.json, ...);
// this file just needs to be correct once they do.
//
// Fails loudly, naming the offending fixture id and file, rather than
// silently skipping or coercing — a corpus whose loader quietly drops a
// malformed entry is worse than no corpus at all, since it would report a
// clean run over a smaller, wrong set of fixtures.
const DEFAULT_CORPUS_DIR = __dirname;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `*.json` files only, sorted for deterministic load (and error-reporting) order. */
function listCorpusFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function readJsonFile(fullPath: string, filename: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(fullPath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read corpus file "${filename}": ${describeError(error)}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse corpus file "${filename}" as JSON: ${describeError(error)}`);
  }
}

/**
 * Each corpus file may hold either a single fixture object or an array of
 * fixtures — later seed files (T4.4.3+, e.g. browsers.json) are expected to
 * hold many fixtures each, one per real UA/header combination. Normalizes
 * both shapes to a list of raw, not-yet-validated values before Zod ever
 * sees them.
 */
function toRawFixtureList(parsed: unknown, filename: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') return [parsed];
  throw new Error(
    `Corpus file "${filename}" must contain a single fixture object or an array of fixture ` +
      `objects, got ${JSON.stringify(parsed)}.`,
  );
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

/**
 * Best-effort id for an error message about a fixture that FAILED
 * validation — `raw.id` may itself be missing or the wrong type, so this
 * never throws; it falls back to a placeholder rather than compounding one
 * error with another.
 */
function bestEffortFixtureId(raw: unknown): string {
  if (raw !== null && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return '(fixture has no usable id)';
}

/**
 * Reads and validates every `*.json` file in `dir` (default: this module's
 * own directory) against FixtureSchema, across every file at once — a
 * duplicate `id` spanning two different files is caught, not just a
 * duplicate within one. Throws, naming the fixture id and file, on:
 *   - a fixture failing schema validation (a missing/blank `provenance`,
 *     an `expect.classification` outside the four allowed literals, a
 *     missing signal key, an extra unknown key, ...);
 *   - a duplicate `id` anywhere in the corpus, whether in the same file or
 *     across two different ones.
 */
export function loadCorpus(dir: string = DEFAULT_CORPUS_DIR): Fixture[] {
  const filenames = listCorpusFiles(dir);
  const fixtures: Fixture[] = [];
  const firstFileById = new Map<string, string>();

  for (const filename of filenames) {
    const fullPath = path.join(dir, filename);
    const parsed = readJsonFile(fullPath, filename);
    const rawList = toRawFixtureList(parsed, filename);

    rawList.forEach((raw, index) => {
      const result = FixtureSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(
          `Invalid fixture "${bestEffortFixtureId(raw)}" (entry ${index} in "${filename}"):\n` +
            describeZodError(result.error),
        );
      }

      const fixture = result.data;
      const existingFile = firstFileById.get(fixture.id);
      if (existingFile !== undefined) {
        throw new Error(
          `Duplicate fixture id "${fixture.id}": already defined in "${existingFile}", ` +
            `defined again in "${filename}". Every fixture id must be unique across the whole corpus.`,
        );
      }

      firstFileById.set(fixture.id, filename);
      fixtures.push(fixture);
    });
  }

  return fixtures;
}
