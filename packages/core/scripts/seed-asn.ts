#!/usr/bin/env node
// T1.4.3 — `pnpm --filter @posta/core seed:asn` reads the vendored JSON
// (T1.4.2) and issues ONE multi-row INSERT ... ON CONFLICT (asn) DO
// UPDATE SET name = EXCLUDED.name against asn_datacenter (T1.4.1). Only
// `name` is in the SET clause — `added_at` is never touched on conflict,
// so re-running after editing a name updates it in place without
// resetting when the row was first added. Safe to run on every deploy.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

export interface AsnEntry {
  readonly asn: number;
  readonly name: string;
  readonly source: string;
}

interface AsnDataset {
  readonly entries: readonly AsnEntry[];
}

const DEFAULT_DATASET_PATH = path.join(import.meta.dirname, 'data', 'datacenter-asns.json');

// [S1.4 review, typescript-reviewer MEDIUM] JSON.parse returns `any` —
// casting it straight to AsnDataset would let a malformed file (missing
// or renamed `entries` key) through as if it were valid, silently
// seeding zero rows instead of failing at load time. This is a shape
// check, not full schema validation (datacenter-asns.test.ts already
// covers per-entry correctness for the committed file) — just enough to
// catch "this isn't the shape we expect" before it reaches SQL.
function assertIsAsnDataset(value: unknown, datasetPath: string): asserts value is AsnDataset {
  const hasEntriesArray =
    typeof value === 'object' && value !== null && Array.isArray((value as { entries?: unknown }).entries);
  if (!hasEntriesArray) {
    throw new Error(
      `loadAsnDataset: ${datasetPath} does not have the expected {"entries": [...]} shape`,
    );
  }
}

export function loadAsnDataset(datasetPath: string = DEFAULT_DATASET_PATH): AsnEntry[] {
  const raw = readFileSync(datasetPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  assertIsAsnDataset(parsed, datasetPath);
  return [...parsed.entries];
}

export interface SeedAsnResult {
  readonly rowCount: number;
}

export async function seedAsnDatacenter(
  pool: Pool,
  datasetPath: string = DEFAULT_DATASET_PATH,
): Promise<SeedAsnResult> {
  const entries = loadAsnDataset(datasetPath);
  // [S1.4 review, silent-failure-hunter MEDIUM] An empty dataset and a
  // corrupted-but-parseable one (e.g. `{"entries": []}`) both used to
  // return the same "seeded 0" success — indistinguishable from a real
  // failure. There is no legitimate reason to ever seed zero rows, so
  // this is always a loud error, not a no-op.
  if (entries.length === 0) {
    throw new Error(`seedAsnDatacenter: ${datasetPath} has no entries — refusing to seed zero rows`);
  }

  const values: unknown[] = [];
  const rowPlaceholders = entries.map((entry, index) => {
    const base = index * 2;
    values.push(entry.asn, entry.name);
    return `($${base + 1}, $${base + 2})`;
  });

  await pool.query(
    `INSERT INTO asn_datacenter (asn, name) VALUES ${rowPlaceholders.join(', ')}
     ON CONFLICT (asn) DO UPDATE SET name = EXCLUDED.name`,
    values,
  );

  return { rowCount: entries.length };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('seed-asn: DATABASE_URL is not set');
    process.exit(1);
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });

  // [S1.4 review, silent-failure-hunter CRITICAL] A plain `finally { await
  // pool.end(); }` would let a pool.end() failure REPLACE seedAsnDatacenter's
  // real error if both throw — e.g. "table asn_datacenter does not exist"
  // gets masked by a later "connection already closed" from cleanup,
  // pointing whoever's debugging a failed deploy at the wrong problem.
  // Same capture-both-combine-if-both-fail pattern as pg-container.ts's
  // closeClientAndContainer() and partition-maintenance.job.ts's close().
  let seedError: unknown;
  let rowCount: number | undefined;
  try {
    ({ rowCount } = await seedAsnDatacenter(pool));
  } catch (error) {
    seedError = error;
  }

  let closeError: unknown;
  try {
    await pool.end();
  } catch (error) {
    closeError = error;
  }

  if (seedError && closeError) {
    throw new Error(
      `seed-asn: failed with "${describeError(seedError)}", then pool.end() also failed ` +
        `with "${describeError(closeError)}".`,
    );
  }
  if (seedError) throw seedError;
  if (closeError) throw closeError;

  console.log(`seed-asn: seeded ${rowCount} datacenter ASNs`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only run main() when executed directly (`node seed-asn.ts` / `pnpm
// seed:asn`), not when imported by seed-asn.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('seed-asn: failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
