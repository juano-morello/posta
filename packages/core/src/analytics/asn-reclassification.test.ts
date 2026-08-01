import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T4.1.4 — proves the core thesis of INV-5: `events_classified`
// (packages/core/migrations/sql/006_events_classified.sql, T4.1.1) is a
// read-time SQL view over raw `events`, LEFT JOINed to `asn_datacenter`.
// Adding a new datacenter ASN to that lookup table must reclassify EVERY
// past event carrying that ASN, on the very next read — with ZERO writes
// to the `events` row itself, because the verdict is never stored.
//
// The proof is Postgres's own `xmin` system column: it is the id of the
// transaction that last wrote the CURRENT version of a row, so it changes
// if and only if the row is physically rewritten (UPDATE, or a
// HOT-update, or VACUUM FULL — none of which this test triggers). Capture
// `xmin` on the raw `events` row before inserting the new ASN, flip the
// verdict by inserting into `asn_datacenter` only, then assert `xmin` is
// byte-for-byte identical afterwards: the classification changed, the row
// underneath it never moved.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

// A fresh ASN this suite owns end-to-end — must not collide with the
// asn_datacenter fixture events-classified.test.ts seeds (64512) since
// each test file boots its own container, but staying in the same
// reserved/private-use range (64512-65534) keeps the "obviously not a
// real allocation" property that test relies on too.
const NEW_DATACENTER_ASN = 64513;
const NEW_DATACENTER_NAME = 'Reclassified Cloud Ltd.';

const REALISTIC_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Safari/537.36';

const EVENT_ID = 'evt-asn-reclassification';

interface ClassifiedRow {
  readonly classification: string;
  readonly why: string;
}

interface XminRow {
  readonly xmin: string;
}

async function insertRawEvent(pool: Pool): Promise<void> {
  // Realistic browser UA, GET (not HEAD), accept-language AND
  // sec-fetch-site both present, but deliberately NO sec_ch_ua — the one
  // header the datacenter rule (rule 6) keys off of — so that adding the
  // ASN to asn_datacenter is the ONLY thing that can flip this row's
  // verdict. Every other rule in 006_events_classified.sql is picked to
  // stay dark: no prefetch/preview signal (rule 1), UA matches none of
  // the unfurler tokens (rule 2) nor the self-declared-automation tokens
  // (rule 4), method is GET not HEAD (rule 3), UA is non-empty (rule 5),
  // and accept_language/sec_fetch_site being present keeps rule 7 (no
  // metadata at all) from firing once rule 6 stops matching.
  await pool.query(
    `INSERT INTO events (
       event_id, occurred_at, tenant_id, link_id, slug,
       http_method, user_agent, accept_language, sec_fetch_site, sec_ch_ua, asn
     ) VALUES ($1, now(), 'tenant-reclassify', 'link-reclassify', 'slug-reclassify',
       'GET', $2, 'es-AR,es;q=0.9', 'none', NULL, $3)`,
    [EVENT_ID, REALISTIC_CHROME_UA, NEW_DATACENTER_ASN],
  );
}

async function classify(pool: Pool): Promise<ClassifiedRow> {
  const result = await pool.query<ClassifiedRow>(
    `SELECT classification, why FROM events_classified WHERE event_id = $1`,
    [EVENT_ID],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`events_classified returned no row for event_id "${EVENT_ID}"`);
  }
  return row;
}

async function captureXmin(pool: Pool): Promise<string> {
  const result = await pool.query<XminRow>(`SELECT xmin::text AS xmin FROM events WHERE event_id = $1`, [
    EVENT_ID,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`events returned no row for event_id "${EVENT_ID}" while reading xmin`);
  }
  return row.xmin;
}

describe('asn reclassification with no rewrite (T4.1.4, INV-5)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    'inserting a new datacenter ASN reclassifies the existing event on the next read, ' +
      'while the raw events row is never rewritten (xmin unchanged)',
    async () => {
      await insertRawEvent(handle.pool);

      // Before: the ASN is not yet known-datacenter, so rule 6 can't
      // match (d.asn IS NULL from the unmatched LEFT JOIN) and nothing
      // else fires either — the row reads as humano.
      const before = await classify(handle.pool);
      expect(before.classification).toBe('humano');
      expect(before.why).toBe('humano');

      const xminBefore = await captureXmin(handle.pool);

      // The flip: a plain INSERT into the lookup table, touching NOTHING
      // in `events`.
      await handle.pool.query(`INSERT INTO asn_datacenter (asn, name) VALUES ($1, $2)`, [
        NEW_DATACENTER_ASN,
        NEW_DATACENTER_NAME,
      ]);

      // After: the SAME event_id, re-read through the SAME view, now
      // classifies as bot — rule 6 fires because d.asn now resolves and
      // sec_ch_ua is still NULL.
      const after = await classify(handle.pool);
      expect(after.classification).toBe('bot');
      expect(after.why).toBe(
        `ASN ${NEW_DATACENTER_ASN} (${NEW_DATACENTER_NAME}) sin fingerprint de browser`,
      );

      // The proof: xmin on the raw events row is byte-for-byte identical
      // before and after the flip — only asn_datacenter changed, the
      // events row itself was never touched, let alone rewritten.
      const xminAfter = await captureXmin(handle.pool);
      expect(xminAfter).toBe(xminBefore);
    },
  );
});
