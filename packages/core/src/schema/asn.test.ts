import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { asnDatacenter } from './asn';

// T1.4.1 — `asn_datacenter` is global reference data, not tenant-owned: a
// datacenter ASN is a fact about the internet, not about an account. It
// deliberately carries no tenant_id. Adding one being a plain INSERT (not
// a migration against a live partitioned events table) is what keeps
// E4's classification view improvable without a schema change — this
// table is the seam that makes that true.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

interface DrizzleQueryError extends Error {
  readonly cause?: { readonly code?: string };
}

function pgErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return (error as DrizzleQueryError).cause?.code;
}

describe('asn_datacenter schema (T1.4.1)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('exists after migrate and is empty — seeding is T1.4.3, not this migration', async () => {
    const result = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM asn_datacenter
    `);
    expect(result.rows[0]?.count).toBe('0');
  });

  it('added_at is timestamp with time zone and defaults to now()', async () => {
    const result = await handle.db.execute<{ data_type: string }>(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'asn_datacenter' AND column_name = 'added_at'
    `);
    expect(result.rows[0]?.data_type).toBe('timestamp with time zone');

    await handle.db.insert(asnDatacenter).values({ asn: 16509, name: 'Amazon.com, Inc.' });
    // Compared entirely in Postgres (EXTRACT(EPOCH FROM ...)), same as
    // bio-pages.test.ts's timestamptz round-trip check — raw db.execute()
    // returns Postgres's text encoding, not a JS-Date-parseable format.
    const row = await handle.db.execute<{ diff_seconds: string }>(sql`
      SELECT EXTRACT(EPOCH FROM (now() - added_at))::text AS diff_seconds
      FROM asn_datacenter WHERE asn = 16509
    `);
    expect(Math.abs(Number(row.rows[0]?.diff_seconds))).toBeLessThan(30);
  });

  it('a duplicate asn raises 23505 — asn is the primary key', async () => {
    await handle.db.insert(asnDatacenter).values({ asn: 15169, name: 'Google LLC' });

    let caughtCode: string | undefined;
    try {
      await handle.db.insert(asnDatacenter).values({ asn: 15169, name: 'Google LLC (dup)' });
    } catch (error) {
      caughtCode = pgErrorCode(error);
    }

    expect(caughtCode).toBe('23505');
  });
});
