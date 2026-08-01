import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T4.1.1 — events_classified (packages/core/migrations/sql/006_events_classified.sql)
// is a read-time view [INV-5]: `events` itself carries no verdict column
// (T1.2.2/T1.2.5 [INV-4]), so this suite seeds real rows into the real
// `events` table (via the same testcontainers harness every other E1-E4
// integration test reuses, packages/core/src/test/pg-container.ts) and
// reads the verdict back through the view — never a mock, never a unit
// test against the CASE logic in isolation.
//
// Two of the cases below are not "just another rule" — they are the
// ORDERING TRAPS the migration file's own header comment names as the
// single most important correctness property here: a Chrome UA carrying
// Sec-Purpose: prefetch proves rule 1 runs before rule 8's catch-all
// (moving rule 1 later would misclassify it as humano), and a bare
// "WhatsApp/2.24.1.78" UA proves rule 2 runs before rule 4 (none of rule
// 4's bot/crawl/spider/... tokens match "WhatsApp", so if rule 2 moved
// after rule 4 this row would fall all the way through to humano too).
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

const DATACENTER_ASN = 64512; // reserved/private-use ASN — test-only, never a real allocation
const DATACENTER_NAME = 'Test Datacenter Inc.';

const REALISTIC_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Safari/537.36';
const REALISTIC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.0 Safari/605.1.15';
const REALISTIC_CLIENT_HINTS = '"Chromium";v="125", "Not.A/Brand";v="24"';

interface EventFixture {
  readonly eventId: string;
  readonly httpMethod?: string | null;
  readonly userAgent?: string | null;
  readonly acceptLanguage?: string | null;
  readonly secFetchSite?: string | null;
  readonly secChUa?: string | null;
  readonly secPurpose?: string | null;
  readonly purpose?: string | null;
  readonly xPurpose?: string | null;
  readonly xMoz?: string | null;
  readonly asn?: number | null;
}

interface ClassifiedRow {
  readonly classification: string;
  readonly why: string;
}

async function insertEvent(pool: Pool, fixture: EventFixture): Promise<void> {
  await pool.query(
    `INSERT INTO events (
       event_id, occurred_at, tenant_id, link_id, slug,
       http_method, user_agent, accept_language, sec_fetch_site, sec_ch_ua,
       sec_purpose, purpose, x_purpose, x_moz, asn
     ) VALUES ($1, now(), 'tenant-classify', 'link-classify', 'slug-classify',
       $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      fixture.eventId,
      fixture.httpMethod ?? null,
      fixture.userAgent ?? null,
      fixture.acceptLanguage ?? null,
      fixture.secFetchSite ?? null,
      fixture.secChUa ?? null,
      fixture.secPurpose ?? null,
      fixture.purpose ?? null,
      fixture.xPurpose ?? null,
      fixture.xMoz ?? null,
      fixture.asn ?? null,
    ],
  );
}

async function classify(pool: Pool, eventId: string): Promise<ClassifiedRow> {
  const result = await pool.query<ClassifiedRow>(
    `SELECT classification, why FROM events_classified WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`events_classified returned no row for event_id "${eventId}"`);
  }
  return row;
}

describe('events_classified view (T4.1.1)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
    await handle.pool.query(`INSERT INTO asn_datacenter (asn, name) VALUES ($1, $2)`, [
      DATACENTER_ASN,
      DATACENTER_NAME,
    ]);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    'rule 1 + ordering trap: a realistic Chrome UA carrying Sec-Purpose: prefetch classifies ' +
      'as prefetch, not humano — proves rule 1 runs before rule 8 even with a full browser ' +
      'fingerprint (client hints, accept-language, fetch metadata all present)',
    async () => {
      await insertEvent(handle.pool, {
        eventId: 'evt-rule1-prefetch-trap',
        httpMethod: 'GET',
        userAgent: REALISTIC_CHROME_UA,
        secPurpose: 'prefetch',
        acceptLanguage: 'en-US,en;q=0.9',
        secFetchSite: 'same-origin',
        secChUa: REALISTIC_CLIENT_HINTS,
      });

      const row = await classify(handle.pool, 'evt-rule1-prefetch-trap');
      expect(row.classification).toBe('prefetch');
      expect(row.why).toBe('preview de link · Purpose: prefetch');
    },
  );

  it('rule 2: a known unfurler user-agent (facebookexternalhit) classifies as unfurler', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule2-facebook',
      httpMethod: 'GET',
      userAgent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    });

    const row = await classify(handle.pool, 'evt-rule2-facebook');
    expect(row.classification).toBe('unfurler');
    expect(row.why).toBe(`user-agent 'facebookexternalhit'`);
  });

  it(
    'rule 2 ordering trap: "WhatsApp/2.24.1.78" classifies as unfurler, not humano — proves ' +
      'rule 2 runs before rule 4, since "WhatsApp" matches none of rule 4\'s ' +
      'bot/crawl/spider/curl/... substrings and would otherwise fall through to humano',
    async () => {
      await insertEvent(handle.pool, {
        eventId: 'evt-rule2-whatsapp-trap',
        httpMethod: 'GET',
        userAgent: 'WhatsApp/2.24.1.78',
      });

      const row = await classify(handle.pool, 'evt-rule2-whatsapp-trap');
      expect(row.classification).toBe('unfurler');
      expect(row.why).toBe(`user-agent 'WhatsApp'`);
    },
  );

  it('rule 3: a HEAD request from an otherwise browser-looking UA classifies as unfurler', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule3-head',
      httpMethod: 'HEAD',
      userAgent: REALISTIC_SAFARI_UA,
    });

    const row = await classify(handle.pool, 'evt-rule3-head');
    expect(row.classification).toBe('unfurler');
    expect(row.why).toBe('método HEAD');
  });

  it('rule 4: a self-declared automation UA (python-requests) classifies as bot', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule4-python-requests',
      httpMethod: 'GET',
      userAgent: 'python-requests/2.31.0',
    });

    const row = await classify(handle.pool, 'evt-rule4-python-requests');
    expect(row.classification).toBe('bot');
    expect(row.why).toBe(`user-agent 'python-requests'`);
  });

  it('rule 5: a NULL user-agent classifies as bot', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule5-null-ua',
      httpMethod: 'GET',
      userAgent: null,
    });

    const row = await classify(handle.pool, 'evt-rule5-null-ua');
    expect(row.classification).toBe('bot');
    expect(row.why).toBe('sin user-agent');
  });

  it('rule 5: an empty-string user-agent classifies as bot', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule5-empty-ua',
      httpMethod: 'GET',
      userAgent: '',
    });

    const row = await classify(handle.pool, 'evt-rule5-empty-ua');
    expect(row.classification).toBe('bot');
    expect(row.why).toBe('sin user-agent');
  });

  it('rule 6: a known-datacenter ASN with no client hints classifies as bot', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule6-datacenter-asn',
      httpMethod: 'GET',
      userAgent: 'SomeInternalMonitor/1.0',
      acceptLanguage: 'en-US',
      secFetchSite: 'none',
      secChUa: null,
      asn: DATACENTER_ASN,
    });

    const row = await classify(handle.pool, 'evt-rule6-datacenter-asn');
    expect(row.classification).toBe('bot');
    expect(row.why).toBe(`ASN ${DATACENTER_ASN} (${DATACENTER_NAME}) sin fingerprint de browser`);
  });

  it('rule 7: no accept-language, fetch metadata, or client hints classifies as bot', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule7-no-metadata',
      httpMethod: 'GET',
      userAgent: 'SomeGenericAgent/1.0',
      acceptLanguage: null,
      secFetchSite: null,
      secChUa: null,
      asn: null,
    });

    const row = await classify(handle.pool, 'evt-rule7-no-metadata');
    expect(row.classification).toBe('bot');
    expect(row.why).toBe('sin accept-language ni fetch metadata');
  });

  it('rule 8: a full browser fingerprint with no other signal classifies as humano', async () => {
    await insertEvent(handle.pool, {
      eventId: 'evt-rule8-humano',
      httpMethod: 'GET',
      userAgent: REALISTIC_CHROME_UA,
      acceptLanguage: 'en-US,en;q=0.9',
      secFetchSite: 'same-origin',
      secChUa: REALISTIC_CLIENT_HINTS,
      asn: null,
    });

    const row = await classify(handle.pool, 'evt-rule8-humano');
    expect(row.classification).toBe('humano');
    expect(row.why).toBe('humano');
  });

  it(
    'all 8 rules produce a distinct, non-null why — collecting one why per rule proves no ' +
      'two rules ever collapse to the same Spanish explanation (T4.1.2)',
    async () => {
      // Self-contained fixture set (fresh event_ids, not reused from the tests above) so this
      // assertion never depends on execution order of the other `it` blocks in this file.
      const fixturesByRule: readonly EventFixture[] = [
        // 1. prefetch/preview signal
        {
          eventId: 'evt-distinct-rule1-prefetch',
          httpMethod: 'GET',
          userAgent: REALISTIC_CHROME_UA,
          secPurpose: 'prefetch',
          acceptLanguage: 'en-US,en;q=0.9',
          secFetchSite: 'same-origin',
          secChUa: REALISTIC_CLIENT_HINTS,
        },
        // 2. known unfurler token
        {
          eventId: 'evt-distinct-rule2-unfurler',
          httpMethod: 'GET',
          userAgent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        },
        // 3. HEAD request
        {
          eventId: 'evt-distinct-rule3-head',
          httpMethod: 'HEAD',
          userAgent: REALISTIC_SAFARI_UA,
        },
        // 4. self-declared automation token
        {
          eventId: 'evt-distinct-rule4-bot',
          httpMethod: 'GET',
          userAgent: 'python-requests/2.31.0',
        },
        // 5. no user-agent at all
        {
          eventId: 'evt-distinct-rule5-no-ua',
          httpMethod: 'GET',
          userAgent: null,
        },
        // 6. known-datacenter ASN, no client hints
        {
          eventId: 'evt-distinct-rule6-datacenter',
          httpMethod: 'GET',
          userAgent: 'SomeInternalMonitor/1.0',
          acceptLanguage: 'en-US',
          secFetchSite: 'none',
          secChUa: null,
          asn: DATACENTER_ASN,
        },
        // 7. no accept-language, fetch metadata, or client hints
        {
          eventId: 'evt-distinct-rule7-no-metadata',
          httpMethod: 'GET',
          userAgent: 'SomeGenericAgent/1.0',
          acceptLanguage: null,
          secFetchSite: null,
          secChUa: null,
          asn: null,
        },
        // 8. else -> humano
        {
          eventId: 'evt-distinct-rule8-humano',
          httpMethod: 'GET',
          userAgent: REALISTIC_CHROME_UA,
          acceptLanguage: 'en-US,en;q=0.9',
          secFetchSite: 'same-origin',
          secChUa: REALISTIC_CLIENT_HINTS,
          asn: null,
        },
      ];

      for (const fixture of fixturesByRule) {
        await insertEvent(handle.pool, fixture);
      }

      const whyValues = await Promise.all(
        fixturesByRule.map(async (fixture) => (await classify(handle.pool, fixture.eventId)).why),
      );

      for (const why of whyValues) {
        expect(why).not.toBeNull();
      }
      expect(new Set(whyValues).size).toBe(8);
    },
  );
});
