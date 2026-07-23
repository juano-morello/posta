import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../src/test/pg-container';
import { loadAsnDataset, seedAsnDatacenter } from './seed-asn';

// T1.4.3 — `pnpm seed:asn` must be safe to run on every deploy: re-running
// after editing a name updates it in place, never duplicates a row, and
// never resets added_at (that would make "when was this ASN first added"
// lie every time the seed runs). All assertions run against a REAL
// testcontainers Postgres, migrated the normal way (T1.4.1's table).
const DATASET_PATH = path.join(import.meta.dirname, 'data', 'datacenter-asns.json');
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

describe('seedAsnDatacenter (T1.4.3)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('running it twice produces exactly one row per dataset entry, both times', async () => {
    const datasetEntries = loadAsnDataset(DATASET_PATH);

    await seedAsnDatacenter(handle.pool, DATASET_PATH);
    const afterFirstRun = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM asn_datacenter
    `);
    expect(Number(afterFirstRun.rows[0]?.count)).toBe(datasetEntries.length);

    await seedAsnDatacenter(handle.pool, DATASET_PATH);
    const afterSecondRun = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM asn_datacenter
    `);
    expect(Number(afterSecondRun.rows[0]?.count)).toBe(datasetEntries.length);
  });

  it('added_at is unchanged on the second run — re-seeding is not re-adding', async () => {
    const [firstEntry] = loadAsnDataset(DATASET_PATH);
    if (!firstEntry) throw new Error('dataset is empty — cannot run this assertion');

    const before = await handle.db.execute<{ added_at: string }>(sql`
      SELECT added_at::text AS added_at FROM asn_datacenter WHERE asn = ${firstEntry.asn}
    `);

    await seedAsnDatacenter(handle.pool, DATASET_PATH);

    const after = await handle.db.execute<{ added_at: string }>(sql`
      SELECT added_at::text AS added_at FROM asn_datacenter WHERE asn = ${firstEntry.asn}
    `);
    expect(after.rows[0]?.added_at).toBe(before.rows[0]?.added_at);
  });

  describe('re-seeding after editing a name', () => {
    let tempDir: string;
    let editedDatasetPath: string;
    const targetAsn = 16509; // AWS entry — present in every dataset revision

    beforeAll(() => {
      const originalEntries = loadAsnDataset(DATASET_PATH);
      const edited = originalEntries.map((entry) =>
        entry.asn === targetAsn ? { ...entry, name: 'Renamed For Test' } : entry,
      );
      tempDir = mkdtempSync(path.join(tmpdir(), 'posta-seed-asn-'));
      editedDatasetPath = path.join(tempDir, 'datacenter-asns.json');
      writeFileSync(editedDatasetPath, JSON.stringify({ entries: edited }));
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('updates the row in place — new name, same row count, no duplicate', async () => {
      const originalEntries = loadAsnDataset(DATASET_PATH);

      await seedAsnDatacenter(handle.pool, editedDatasetPath);

      const countResult = await handle.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM asn_datacenter
      `);
      expect(Number(countResult.rows[0]?.count)).toBe(originalEntries.length);

      const renamedResult = await handle.db.execute<{ name: string }>(sql`
        SELECT name FROM asn_datacenter WHERE asn = ${targetAsn}
      `);
      expect(renamedResult.rows[0]?.name).toBe('Renamed For Test');
    });
  });
});
