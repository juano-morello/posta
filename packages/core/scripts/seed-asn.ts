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

export function loadAsnDataset(datasetPath: string = DEFAULT_DATASET_PATH): AsnEntry[] {
  const raw = readFileSync(datasetPath, 'utf8');
  const dataset = JSON.parse(raw) as AsnDataset;
  return [...dataset.entries];
}

export interface SeedAsnResult {
  readonly rowCount: number;
}

export async function seedAsnDatacenter(
  pool: Pool,
  datasetPath: string = DEFAULT_DATASET_PATH,
): Promise<SeedAsnResult> {
  const entries = loadAsnDataset(datasetPath);
  if (entries.length === 0) return { rowCount: 0 };

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
  try {
    const { rowCount } = await seedAsnDatacenter(pool);
    console.log(`seed-asn: seeded ${rowCount} datacenter ASNs`);
  } finally {
    await pool.end();
  }
}

// Only run main() when executed directly (`node seed-asn.ts` / `pnpm
// seed:asn`), not when imported by seed-asn.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('seed-asn: failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
