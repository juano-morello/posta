import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { eventPrefixes, newId, streamEventLog, type EnrichmentResult, type LoggedEvent } from '@posta/core';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCaptureEventFromCorpus, loadCorpus, seedLink } from './pipeline-harness-fixtures';
import { startPipelineHarness, type PipelineHarness } from './pipeline-harness';

// T3.5.5 [E3, S3.5] — "the unit test proves the function; this proves
// nothing between the consumer and the two writers drops or reorders a
// field." T3.2.6's own corpus.test.ts already proves enrich() itself is
// correct over all ~40 fixture entries, calling it directly with no queue,
// no worker process, no Postgres, no R2 in the loop. This file pushes the
// SAME corpus entries through the REAL pipeline this story built
// (startPipelineHarness()'s real BullMQ producer, the real spawned worker
// process, its real @Processor consumer, its real accumulator/flush) and
// asserts each fixture's seven enrichment columns [INV-4] (browser,
// browser_version, os, device_type, source_platform, is_in_app, dest_host
// — spec §8) land correctly in BOTH stores for the SAME event_id: the
// Postgres row (T3.3.2's insert) and the R2 NDJSON line (T3.4.4's PUT).
// Anything that drops a field, reorders a column, or lets Postgres and R2
// disagree about one fails HERE even though every individual piece already
// has its own green unit test — that gap is exactly this task's job.
//
// --- ONE LINK PER FIXTURE ENTRY, NOT THE HARNESS'S SHARED ONE -----------
//
// pipeline-harness.ts's own push() resolves every event's dest_host
// against ONE shared seeded link (HARNESS_DESTINATION) — correct for that
// file's own job (proving the PIPELINE moves events, not re-deriving
// dest_host correctness a unit test already owns), but wrong here: this
// corpus's own `expected.dest_host` is derived per-entry from that same
// entry's own `input.destination` (see corpus.test.ts's `enrich(input)`
// call), so a shared destination would make every entry's expected
// dest_host identical and this test would never catch a per-entry
// dest_host bug. This file instead calls `harness.redeliver()` (T3.5.3's
// exact-event re-enqueue primitive — enqueues the CaptureEvents given,
// byte-identical, with no new event minted) with hand-built events, each
// pointed at its OWN freshly seeded link whose destination is that
// fixture's own `input.destination` — the real pipeline then resolves each
// event's dest_host from ITS OWN link row via the same
// resolveDestinationsByLinkIds() batched SELECT flush.ts always uses, so a
// per-entry dest_host mismatch is exactly as visible here as it would be
// in production.
//
// --- THREE ENTRIES THAT CANNOT CARRY A REAL LINK ROW ---------------------
//
// `links.destination` (packages/core/src/schema/links.ts) carries a real
// CHECK constraint — `links_destination_absolute_url_check`, requiring
// `^https?://` case-insensitively — defense in depth so that no real link
// row, ever, in production, can hold anything else. Three corpus entries
// exist specifically to prove enrich()'s OWN defensive handling of a
// destination that never went through that check: two carry
// `destination: null` outright ("a null destination...", "user_agent,
// referer, and destination all null"), and one carries deliberately
// non-URL text ("genuinely malformed/unparseable destination... resolves
// dest_host to null"). corpus.test.ts (T3.2.6) already fully proves
// enrich() handles all three correctly in isolation; this REAL pipeline
// cannot reproduce any of them with a genuine link row, by construction of
// that same CHECK — inserting one deliberately to force the scenario would
// mean this test defeating a real, deliberately-placed invariant just to
// exercise it. All three share one thing that make this resolvable without
// weakening anything: every one of them expects `dest_host: null`. For
// exactly these three, this file skips seeding a real link and instead
// points the event's `link_id` at an id that was NEVER inserted —
// resolveDestination() (flush.ts) already treats an unresolved link_id
// (deleted, or here, never-existed) identically: destination resolves to
// null, dest_host follows, matching the fixture's own expectation via the
// SAME "not-found" code path a genuinely deleted link takes in production,
// not a special case invented for this test. `canSeedRealLink` names this
// split; the setup asserts (not merely assumes) that every entry taking
// this path expects `dest_host: null`, so a future corpus edit that broke
// that assumption would fail loudly here rather than silently comparing
// against the wrong link.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const SETUP_TIMEOUT_MS = 240_000;
const TEARDOWN_TIMEOUT_MS = 120_000;

/** The seven enrichment columns spec §8 names — the exact set this file
 * compares between Postgres and R2, and against each fixture's own
 * `expected`. No `country`/`asn` here (unlike reconciliation.test.ts's
 * broader comparison set): those two are populated by IP geolocation, a
 * separate concern the UA corpus never varies — every fixture's own
 * `expected` object (EnrichmentResult, packages/core/src/enrichment/enrich.ts)
 * carries exactly these seven keys and nothing else. */
const ENRICHMENT_FIELDS = [
  'browser',
  'browser_version',
  'os',
  'device_type',
  'source_platform',
  'is_in_app',
  'dest_host',
] as const;

type EnrichmentFieldName = (typeof ENRICHMENT_FIELDS)[number];
type EnrichmentFieldRecord = Record<EnrichmentFieldName, unknown>;

/** pipeline-harness-fixtures.ts's own `loadCorpus()` intentionally narrows
 * every entry's TYPE to `{ input: { user_agent, referer } }` — the only two
 * fields `buildCaptureEventFromCorpus` reads. This file needs the REST of
 * the exact same fixture objects that function already read, parsed, and
 * memoized (`name`, `category`, `input.destination`, `expected`) — so
 * rather than re-reading and re-parsing `ua-corpus.json` a second time
 * (exactly the duplicate work `loadCorpus()`'s own memoization exists to
 * avoid), this widens the TYPE VIEW of the SAME cached array to
 * corpus.test.ts's own full `CorpusEntry` shape. Every object `loadCorpus()`
 * returns already carries every one of these fields at runtime — JSON.parse
 * does not know about TypeScript's narrower declared type — so this cast is
 * exactly as safe as reading the file directly a second time, without the
 * duplicate I/O or the duplicate parse. */
interface FullCorpusEntry {
  readonly name: string;
  readonly category: string;
  readonly input: {
    readonly user_agent: string | null;
    readonly referer: string | null;
    readonly destination: string | null;
  };
  readonly expected: EnrichmentResult;
}

function loadFullCorpus(): readonly FullCorpusEntry[] {
  return loadCorpus() as unknown as readonly FullCorpusEntry[];
}

/** True only for a destination this file can legally seed as a real
 * `links.destination` row — see this file's own header, "THREE ENTRIES
 * THAT CANNOT CARRY A REAL LINK ROW", for why `null` and non-URL text both
 * fail this and what happens to those entries instead. Mirrors the exact
 * regex `links.ts`'s own CHECK constraint enforces. */
function canSeedRealLink(destination: string | null): destination is string {
  return destination !== null && /^https?:\/\//i.test(destination);
}

interface FixtureEvent {
  readonly entry: FullCorpusEntry;
  readonly event: CaptureEvent;
}

/** Seeds one link per corpus entry (its own unique slug, and its own
 * destination when the entry's destination can legally be a real link row)
 * and builds that entry's `CaptureEvent` pointed at it — see this file's
 * own header for why one link per entry, not the harness's shared one. */
async function buildFixtureEvents(
  harness: PipelineHarness,
  corpus: readonly FullCorpusEntry[],
): Promise<readonly FixtureEvent[]> {
  return Promise.all(
    corpus.map(async (entry, index) => {
      const destination = entry.input.destination;
      const seedable = canSeedRealLink(destination);

      if (!seedable) {
        // See this file's own header — every entry taking the
        // never-inserted-link_id path must expect a null dest_host, or
        // this fixture correlation would silently compare against the
        // wrong thing.
        expect(entry.expected.dest_host).toBeNull();
      }

      const slug = `enrich-${index}`;
      const linkId = seedable
        ? await seedLink(harness.pg, harness.tenantId, slug, destination)
        : newId();

      const event = buildCaptureEventFromCorpus(entry, {
        tenantId: harness.tenantId,
        linkId,
        slug,
        occurredAt: harness.occurredAt,
      });

      return { entry, event };
    }),
  );
}

interface PgEnrichmentRow {
  readonly event_id: string;
  readonly browser: string | null;
  readonly browser_version: string | null;
  readonly os: string | null;
  readonly device_type: string | null;
  readonly source_platform: string | null;
  readonly is_in_app: boolean | null;
  readonly dest_host: string | null;
}

async function fetchPgRows(
  harness: PipelineHarness,
  eventIds: readonly string[],
): Promise<Map<string, PgEnrichmentRow>> {
  const result = await harness.pg.pool.query<PgEnrichmentRow>(
    'SELECT event_id, browser, browser_version, os, device_type, source_platform, is_in_app, dest_host ' +
      'FROM events WHERE tenant_id = $1 AND event_id = ANY($2)',
    [harness.tenantId, eventIds],
  );
  return new Map(result.rows.map((row) => [row.event_id, row]));
}

/** Streams every NDJSON record across this harness's own hour prefixes
 * (T3.6.1/T3.6.2's `eventPrefixes`/`streamEventLog`), keyed by `event_id`
 * and filtered to this run's own `tenantId` — mirrors reconciliation.test.ts's
 * and e2e-exactly-once.test.ts's own identical collection pattern, since
 * this worktree's MinIO bucket is shared with concurrent sibling agents. */
async function collectR2Records(harness: PipelineHarness): Promise<Map<string, LoggedEvent>> {
  const prefixes = eventPrefixes(harness.occurredAt, harness.occurredAt);
  const records = new Map<string, LoggedEvent>();

  for await (const record of streamEventLog(harness.r2Client, harness.r2Bucket, prefixes)) {
    if (record.tenant_id !== harness.tenantId) continue;
    records.set(record.event_id, record);
  }

  return records;
}

/** Lists every object key under `prefixes` — mirrors e2e-exactly-once.test.ts's
 * and pipeline-harness.test.ts's own identically-named cleanup helper: going
 * through the real queue/consumer means the accumulator mints its own
 * `batchId` per flush, invisible to this test, so there is no incrementally
 * -built key list to clean up by, only a prefix listing. */
async function listR2ObjectKeys(client: S3Client, bucket: string, prefixes: readonly string[]): Promise<string[]> {
  const keys: string[] = [];

  for (const prefix of prefixes) {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    for (const object of response.Contents ?? []) {
      if (object.Key !== undefined) keys.push(object.Key);
    }
  }

  return keys;
}

/** Narrows an arbitrary enrichment-shaped record down to exactly
 * `ENRICHMENT_FIELDS`, in a fixed key order — used on both the Postgres row
 * and the R2 record before comparing either against a fixture's own
 * `expected`, so `toEqual` never fails on an unrelated extra key (event_id,
 * tenant_id, every raw capture header, ...) neither side is supposed to
 * share with `EnrichmentResult`. */
function pickEnrichmentFields(source: Record<string, unknown>): EnrichmentFieldRecord {
  const picked = {} as EnrichmentFieldRecord;
  for (const field of ENRICHMENT_FIELDS) {
    picked[field] = source[field];
  }
  return picked;
}

describe('enrichment fields correct end-to-end across the UA fixture corpus (T3.5.5) [INV-4]', () => {
  const corpus = loadFullCorpus();

  let harness: PipelineHarness;
  let fixtureEvents: readonly FixtureEvent[];
  let pgRowsById: Map<string, PgEnrichmentRow>;
  let r2RecordsById: Map<string, LoggedEvent>;
  let r2Keys: string[];

  beforeAll(async () => {
    harness = await startPipelineHarness();
    fixtureEvents = await buildFixtureEvents(harness, corpus);

    await harness.redeliver(fixtureEvents.map((fixture) => fixture.event));
    await harness.drain();

    const eventIds = fixtureEvents.map((fixture) => fixture.event.event_id);
    pgRowsById = await fetchPgRows(harness, eventIds);
    r2RecordsById = await collectR2Records(harness);

    const prefixes = eventPrefixes(harness.occurredAt, harness.occurredAt);
    r2Keys = await listR2ObjectKeys(harness.r2Client, harness.r2Bucket, prefixes);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (r2Keys !== undefined && r2Keys.length > 0) {
      await harness.r2Client
        .send(
          new DeleteObjectsCommand({
            Bucket: harness.r2Bucket,
            Delete: { Objects: r2Keys.map((Key) => ({ Key })) },
          }),
        )
        .catch(() => undefined);
    }
    harness.r2Client.destroy();
    await harness.stop();
  }, TEARDOWN_TIMEOUT_MS);

  it('has at least 40 fixture entries — the same floor corpus.test.ts (T3.2.6) itself asserts', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
  });

  it(`lands all ${corpus.length} fixture rows in Postgres, one per corpus entry`, () => {
    expect(pgRowsById.size).toBe(fixtureEvents.length);
  });

  it(`lands all ${corpus.length} fixture rows in the R2 NDJSON log, one per corpus entry`, () => {
    const landed = fixtureEvents.filter((fixture) => r2RecordsById.has(fixture.event.event_id));
    expect(landed).toHaveLength(fixtureEvents.length);
  });

  it.each(
    // Bound to a lazily-populated array so it.each can enumerate the
    // corpus's own names/categories at collection time — fixtureEvents is
    // only ready once beforeAll has run, so this reads loadFullCorpus()
    // directly for the *labels*, joined with the real per-run event_id via
    // a lookup inside the test body itself.
    corpus.map((entry, index) => ({ entry, index })),
  )('Postgres row for "$entry.name" ($entry.category) matches the fixture\'s expected enrichment exactly', ({ entry, index }) => {
    const fixture = fixtureEvents[index]!;
    expect(fixture.entry).toBe(entry);

    const row = pgRowsById.get(fixture.event.event_id);
    expect(row, `no Postgres row landed for fixture "${entry.name}"`).toBeDefined();
    expect(pickEnrichmentFields(row as unknown as Record<string, unknown>)).toEqual(
      pickEnrichmentFields(entry.expected as unknown as Record<string, unknown>),
    );
  });

  it.each(corpus.map((entry, index) => ({ entry, index })))(
    'R2 NDJSON line for "$entry.name" ($entry.category) matches the fixture\'s expected enrichment exactly',
    ({ entry, index }) => {
      const fixture = fixtureEvents[index]!;
      expect(fixture.entry).toBe(entry);

      const record = r2RecordsById.get(fixture.event.event_id);
      expect(record, `no R2 NDJSON record landed for fixture "${entry.name}"`).toBeDefined();
      expect(pickEnrichmentFields(record as unknown as Record<string, unknown>)).toEqual(
        pickEnrichmentFields(entry.expected as unknown as Record<string, unknown>),
      );
    },
  );

  it('no row carries a non-null value in a column the fixture expects null — in either store', () => {
    const violations: string[] = [];

    for (const fixture of fixtureEvents) {
      const row = pgRowsById.get(fixture.event.event_id);
      const record = r2RecordsById.get(fixture.event.event_id);

      for (const field of ENRICHMENT_FIELDS) {
        if (fixture.entry.expected[field] !== null) continue;

        if (row !== undefined && row[field] !== null) {
          violations.push(`postgres:"${fixture.entry.name}":${field}=${JSON.stringify(row[field])}`);
        }
        if (record !== undefined && (record as unknown as EnrichmentFieldRecord)[field] !== null) {
          violations.push(`r2:"${fixture.entry.name}":${field}=${JSON.stringify((record as unknown as EnrichmentFieldRecord)[field])}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('exercised real enrichment diversity, not a vacuous all-null comparison', () => {
    const browsers = new Set(fixtureEvents.map((fixture) => fixture.entry.expected.browser));
    const deviceTypes = new Set(fixtureEvents.map((fixture) => fixture.entry.expected.device_type));
    const sourcePlatforms = new Set(fixtureEvents.map((fixture) => fixture.entry.expected.source_platform));
    const inAppFlags = new Set(fixtureEvents.map((fixture) => fixture.entry.expected.is_in_app));

    expect(browsers.size).toBeGreaterThan(1);
    expect(deviceTypes.size).toBeGreaterThan(1);
    expect(sourcePlatforms.size).toBeGreaterThan(1);
    expect(inAppFlags).toEqual(new Set([true, false]));
  });
});
