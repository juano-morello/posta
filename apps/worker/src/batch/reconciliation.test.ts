import path from 'node:path';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  eventPrefixes,
  links,
  newId,
  runSqlMigrations,
  streamEventLog,
  user,
  type LoggedEvent,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from './flush';

// T3.4.7 [E3, S3.4][INV-7] — "both stores agree after 10k events." T3.4.6
// (flush.ts, commit 2f8ea40) coupled the two writes: R2 PUT first, awaited
// to completion, Postgres INSERT only once that PUT succeeded. That
// coupling is proven at unit/small-batch scale by flush.test.ts and against
// a genuinely stopped MinIO by coupled-writes.test.ts. Neither proves the
// thing invariant 7 actually promises operators: after a REAL VOLUME
// successful run, R2's NDJSON log and Postgres's `events` table hold the
// EXACT SAME set of event_ids, not merely "every Postgres row has SOME R2
// object" or vice versa. This file is that end-to-end proof, entirely
// against a HEALTHY R2/MinIO throughout — the failure/DLQ path is
// out of scope here (coupled-writes.test.ts's own job).
//
// --- Why a bidirectional set diff, not a one-directional membership check -
//
// This task's own brief: "a one-directional check passes while Postgres
// silently holds extra rows, which is exactly the divergence T3.4.6 exists
// to prevent." Concretely: checking only "is every R2 event_id present in
// Postgres?" would PASS even if Postgres holds an event R2 never logged —
// R2's set stays a subset of Postgres's either way. `diffEventIdSets` below
// computes BOTH directions (`onlyInFirst`/`onlyInSecond`) so a Postgres-only
// row and an R2-only object are equally visible failures, never just one of
// the two. The "diffEventIdSets — proves..." describe block below is the
// RED-phase proof this task's own dispatch brief asks for: a fast, non-
// container unit test demonstrating the helper genuinely discriminates a
// one-directional-only pass from a real divergence, run and confirmed
// BEFORE this file's own real-MinIO/real-Postgres scenario was written
// against the actual coupled path. (The real-path RED proof — sabotaging
// an actual 10k-event run with one synthetic Postgres-only row and watching
// THESE SAME assertions fail for real — was performed manually during
// development, per this task's own process instructions; it left no trace
// in this committed file, since the file's job is to assert the CORRECT
// behavior, not to carry a permanently-broken scenario.)
//
// --- Batching choice: flushBatch() directly, in EVENT_BATCH_SIZE-capped
// chunks — NOT through BatchAccumulator/BullMQ -------------------------
//
// This task's own dispatch brief flags this as a judgment call with either
// answer defensible; this file takes the direct-flushBatch route, for a
// reason the plan text itself settles: S3.5's own T3.5.x task (line 218 of
// docs/plan/03-event-pipeline.md) explicitly describes ITS OWN 10k-event
// scenario as going "through the real queue rather than by calling
// flushBatch directly," contrasting it with THIS task by name — "T3.4.7
// tested the flush path; this tests the whole pipe including the consumer
// and the queue." The plan already assigns "real queue, real consumer" to
// a LATER task and "the flush path" to this one. Calling flushBatch()
// directly is therefore not a shortcut here, it is the scope this task was
// actually given — and it has real, load-bearing benefits: no BullMQ/Redis
// dependency at all (this suite never touches EVENTS_QUEUE or
// EVENTS_DLQ_QUEUE), so the "obliterate() resets BullMQ's job-ID counter"
// isolation hazard events.consumer.test.ts's own suite has to guard
// against (this task's own dispatch brief, point 6) simply does not apply
// to this file — there is no queue here to obliterate. It also keeps the
// test's own wall-clock time down: 10,000 events chunked into
// EVENT_BATCH_SIZE's own production ceiling (500 — apps/worker/src/env.ts's
// Zod schema, `.max(500)`) means 20 real flushBatch() calls (20 R2 PUTs, 20
// batched destination SELECTs, 20 batched INSERTs) rather than 100 at the
// more conservative .env.example default of 100, or 10,000 one-row calls.
const BATCH_SIZE = 500;
const TOTAL_EVENTS = 10_000;
const NUM_BATCHES = TOTAL_EVENTS / BATCH_SIZE;

const CONTAINER_TEST_TIMEOUT_MS = 120_000;
// [dispatch brief, point 5] Explicit and generous: 10,000 events through
// the REAL coupled path (sequential R2-PUT-then-Postgres-INSERT per flush,
// never concurrent — flush.ts's own T3.4.6 header) is real wall-clock work
// across 20 flushes, each a real MinIO round trip and a real 500-row
// Postgres INSERT, done inside beforeAll. Vitest's own default (5s) would
// make this flaky-by-construction rather than reflect a genuine failure.
const RECONCILIATION_SETUP_TIMEOUT_MS = 300_000;

const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// A random UTC day 2050-2057 (an 8-year/2920-day window), picked fresh
// every run — this worktree's docker-compose MinIO bucket is shared with
// concurrent sibling agents (this task's own dispatch brief), and this
// file's own isolation additionally filters every R2 record it reads back
// by `tenant_id` (see `collectR2State` below) before comparing, so even a
// same-day collision with another test's fixture could not corrupt this
// file's own assertions — this random, wide window just keeps that
// vanishingly unlikely in the first place. Distinct from stream-read.test.ts's
// own fixture window (2033, +/- ~8 years) and its empty-prefix test's fixed
// 2034 date, so neither file could ever collide with this one even by
// coincidence.
const FIXTURE_DAY_MS = Date.UTC(2050, 0, 1) + Math.floor(Math.random() * 2920) * ONE_DAY_MS;

// Three distinct hours inside the SAME UTC calendar day — genuinely
// exercises `eventPrefixes`'s multi-hour-prefix coverage (this task's own
// verify text: "lists every NDJSON object in the covered hour prefixes",
// plural) rather than trivially confirming a single-hour read. All three
// stay well inside one day so `eventPrefixes(dayStart, dayStart)` (called
// once, below) already covers all of them — see keys.ts's own header for
// why a same-day range always yields the full 24-hour set for that day.
const BATCH_HOUR_OFFSETS = [2, 10, 18] as const;

function occurredAtForBatch(batchIndex: number): string {
  const hourOffset = BATCH_HOUR_OFFSETS[batchIndex % BATCH_HOUR_OFFSETS.length]!;
  return new Date(FIXTURE_DAY_MS + hourOffset * ONE_HOUR_MS).toISOString();
}

// Reuses the EXACT UA/referer pairs flush.test.ts's own profiles 0-3
// already assert real enrich() output for (Chrome/Windows/desktop +
// Instagram referer; a real Instagram in-app UA with no referer;
// null/null; a real Android Chrome UA + TikTok referer) — this file does
// not need to re-derive or hardcode expected browser/os/device_type
// strings anywhere below, only that Postgres and R2 report the SAME
// values as each other for a given event_id, and that real (not
// vacuously-null) diversity was actually exercised (see the "diversity"
// assertion near the bottom).
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const INSTAGRAM_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.114 (iPhone14,3; iOS 17_4; en_US; en-US; scale=3.00; 1284x2778; 498540814)';
const PIXEL_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36';

interface EventProfile {
  readonly userAgent: string | null;
  readonly referer: string | null;
  readonly country: string | null;
  readonly asn: number | null;
  readonly linkIndex: 0 | 1;
}

const EVENT_PROFILES: readonly EventProfile[] = [
  { userAgent: DESKTOP_CHROME_UA, referer: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com', country: 'AR', asn: 262254, linkIndex: 0 },
  { userAgent: INSTAGRAM_IN_APP_UA, referer: null, country: 'BR', asn: 28573, linkIndex: 0 },
  { userAgent: null, referer: null, country: null, asn: null, linkIndex: 1 },
  { userAgent: PIXEL_CHROME_UA, referer: 'https://www.tiktok.com/@someone/video/123', country: 'MX', asn: 8151, linkIndex: 1 },
];

/** A fully-signalled CaptureEvent, every field defaulted to `null` except
 * the required identity/context frame — same discipline flush.test.ts's
 * and coupled-writes.test.ts's own `buildCaptureEvent` follow. */
function buildCaptureEvent(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: null,
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
    visitor_hash: null,
    ...overrides,
  };
}

async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

async function seedLink(
  handle: PgContainerHandle,
  tenantId: string,
  slug: string,
  destination: string,
): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({ id: linkId, tenantId, slug, destination });
  return linkId;
}

interface BatchFixture {
  readonly batchId: string;
  readonly occurredAt: string;
  readonly events: readonly CaptureEvent[];
}

/** Builds all `NUM_BATCHES` batches of `BATCH_SIZE` events up front —
 * `EVENT_PROFILES` cycled by global index, so every batch carries the same
 * 1/4-1/4-1/4-1/4 profile mix real traffic-shaped fixtures would. Kept
 * in-memory as plain arrays (10,000 small CaptureEvent objects, comparable
 * to stream-read.test.ts's own 50,000-fixture-object build) — this is
 * fixture-building cost, not the thing under test. */
function buildBatchFixtures(tenantId: string, linkA: string, linkB: string): BatchFixture[] {
  const slugA = 'promo-a';
  const slugB = 'promo-b';
  const batches: BatchFixture[] = [];

  for (let batchIndex = 0; batchIndex < NUM_BATCHES; batchIndex++) {
    const occurredAt = occurredAtForBatch(batchIndex);
    const events: CaptureEvent[] = [];

    for (let offset = 0; offset < BATCH_SIZE; offset++) {
      const globalIndex = batchIndex * BATCH_SIZE + offset;
      const profile = EVENT_PROFILES[globalIndex % EVENT_PROFILES.length]!;
      const linkId = profile.linkIndex === 0 ? linkA : linkB;
      const slug = profile.linkIndex === 0 ? slugA : slugB;

      events.push(
        buildCaptureEvent({
          tenant_id: tenantId,
          link_id: linkId,
          slug,
          occurred_at: occurredAt,
          user_agent: profile.userAgent,
          referer: profile.referer,
          country: profile.country,
          asn: profile.asn,
        }),
      );
    }

    batches.push({ batchId: newId(), occurredAt, events });
  }

  return batches;
}

/** The columns this file compares between a Postgres `events` row and its
 * R2 NDJSON counterpart — "at least the enrichment columns: browser, os,
 * device_type, dest_host, country, asn" (this task's own dispatch brief,
 * point 4), plus browser_version/source_platform/is_in_app since they are
 * the same `enrich()`-produced set flush.ts's own `toNewEventRow`/
 * `toLoggedEvent` write identically to both stores. Deliberately NOT the
 * full 31-column row — event_id identity is already covered by the
 * bidirectional set diff above; this only needs to prove the SEVEN
 * enrichment columns plus the two capture-time network signals agree. */
interface ComparableEventFields {
  readonly browser: string | null;
  readonly browser_version: string | null;
  readonly os: string | null;
  readonly device_type: string | null;
  readonly source_platform: string | null;
  readonly is_in_app: boolean | null;
  readonly dest_host: string | null;
  readonly country: string | null;
  readonly asn: number | null;
}

const ENRICHMENT_COMPARISON_FIELDS: readonly (keyof ComparableEventFields)[] = [
  'browser',
  'browser_version',
  'os',
  'device_type',
  'source_platform',
  'is_in_app',
  'dest_host',
  'country',
  'asn',
];

/** True only if every field in `ENRICHMENT_COMPARISON_FIELDS` is identical
 * between `a` and `b`. Plain `===` per field (never a deep-equal library):
 * every field here is already a primitive (string, boolean, number, or
 * null), so `===` is both correct and lets a failing comparison name
 * exactly which field diverged if this function's own result is inspected
 * field-by-field by a caller — see the "proves ... discriminates" unit
 * tests below for exactly that. */
function fieldsMatch(a: ComparableEventFields, b: ComparableEventFields): boolean {
  return ENRICHMENT_COMPARISON_FIELDS.every((field) => a[field] === b[field]);
}

interface EventIdDiff {
  readonly onlyInFirst: readonly string[];
  readonly onlyInSecond: readonly string[];
}

/**
 * The bidirectional symmetric-difference check this task's own dispatch
 * brief names directly: "compares the event_id set against Postgres in
 * both directions — a one-directional check passes while Postgres
 * silently holds extra rows." `onlyInFirst`/`onlyInSecond` are named
 * generically (not `onlyInPostgres`/`onlyInR2`) so this function itself
 * stays reusable/testable independent of which store is "first" at any
 * given call site — the describe block below documents the concrete
 * postgres/r2 mapping this file actually uses it for.
 */
function diffEventIdSets(first: ReadonlySet<string>, second: ReadonlySet<string>): EventIdDiff {
  const onlyInFirst = [...first].filter((id) => !second.has(id));
  const onlyInSecond = [...second].filter((id) => !first.has(id));
  return { onlyInFirst, onlyInSecond };
}

describe('diffEventIdSets — proves the bidirectional check actually discriminates [T3.4.7 RED-phase proof]', () => {
  it('reports no difference when both sets are identical', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['a', 'b', 'c']);
    expect(diffEventIdSets(a, b)).toEqual({ onlyInFirst: [], onlyInSecond: [] });
  });

  it('catches Postgres silently holding an extra row a ONE-directional (is every R2 id in Postgres?) check would miss entirely', () => {
    // r2 IS a subset of postgres here — a one-directional "every R2 id
    // exists in Postgres" check would report success. That is exactly the
    // silent-divergence failure mode this task's own dispatch brief warns
    // about, and exactly the scenario T3.4.6's write-coupling exists to
    // make impossible in practice.
    const postgres = new Set(['a', 'b', 'c', 'extra-only-in-postgres']);
    const r2 = new Set(['a', 'b', 'c']);

    const diff = diffEventIdSets(postgres, r2);

    expect(diff.onlyInFirst).toEqual(['extra-only-in-postgres']);
    expect(diff.onlyInSecond).toEqual([]);
  });

  it('catches R2 holding an object Postgres never received', () => {
    const postgres = new Set(['a', 'b', 'c']);
    const r2 = new Set(['a', 'b', 'c', 'extra-only-in-r2']);

    const diff = diffEventIdSets(postgres, r2);

    expect(diff.onlyInFirst).toEqual([]);
    expect(diff.onlyInSecond).toEqual(['extra-only-in-r2']);
  });
});

describe('fieldsMatch — proves the enrichment-field comparison actually discriminates [T3.4.7 RED-phase proof]', () => {
  const base: ComparableEventFields = {
    browser: 'Chrome',
    browser_version: '125.0.0.0',
    os: 'Windows',
    device_type: 'desktop',
    source_platform: 'instagram',
    is_in_app: false,
    dest_host: 'shop.example.com',
    country: 'AR',
    asn: 262254,
  };

  it('matches two identical field sets', () => {
    expect(fieldsMatch(base, { ...base })).toBe(true);
  });

  it('detects a dest_host mismatch (the field this task\'s own brief names first)', () => {
    expect(fieldsMatch(base, { ...base, dest_host: 'another.example.org' })).toBe(false);
  });

  it('detects an is_in_app mismatch', () => {
    expect(fieldsMatch(base, { ...base, is_in_app: true })).toBe(false);
  });

  it('detects an asn mismatch', () => {
    expect(fieldsMatch(base, { ...base, asn: 999 })).toBe(false);
  });

  it('detects a country mismatch', () => {
    expect(fieldsMatch(base, { ...base, country: 'CL' })).toBe(false);
  });
});

interface PgEventRow extends ComparableEventFields {
  readonly event_id: string;
}

async function fetchAllEventRows(handle: PgContainerHandle, tenantId: string): Promise<PgEventRow[]> {
  const result = await handle.pool.query<PgEventRow>(
    'SELECT event_id, browser, browser_version, os, device_type, source_platform, is_in_app, dest_host, country, asn ' +
      'FROM events WHERE tenant_id = $1',
    [tenantId],
  );
  return result.rows;
}

/** Streams every NDJSON object across the covered hour prefixes (via
 * `streamEventLog`/`eventPrefixes`, T3.6.2/T3.6.1 — the exact composition
 * that module's own header names this task as an earlier consumer of),
 * keyed by `event_id`. Filtered to THIS test's own `tenantId` — this
 * worktree's MinIO bucket is shared with concurrent sibling agents (this
 * task's own dispatch brief), and this filter is what makes this file's
 * own assertions correct regardless of whatever else happens to land in
 * the same UTC day's other hour prefixes; it does not change what gets
 * LISTED (every object under every covered prefix is still read), only
 * what is kept for comparison. */
async function collectR2State(
  client: ReturnType<typeof createR2Client>,
  bucket: string,
  prefixes: readonly string[],
  tenantId: string,
): Promise<Map<string, LoggedEvent>> {
  const records = new Map<string, LoggedEvent>();

  for await (const record of streamEventLog(client, bucket, prefixes)) {
    if (record.tenant_id !== tenantId) continue;
    records.set(record.event_id, record);
  }

  return records;
}

describe('flushBatch — both stores agree after 10k events (T3.4.7) [INV-7]', () => {
  let pg: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  let tenantId: string;
  const r2CreatedKeys: string[] = [];

  let pgRows: PgEventRow[];
  let pgEventIds: Set<string>;
  let r2State: Map<string, LoggedEvent>;
  let r2EventIds: Set<string>;
  let idDiff: EventIdDiff;
  let mismatchedEnrichmentEventIds: string[];

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantId = await seedTenant(pg);
    const linkA = await seedLink(pg, tenantId, 'promo-a', 'https://Shop.Example.com/promo-a');
    const linkB = await seedLink(pg, tenantId, 'promo-b', 'https://Another.Example.org/promo-b');

    const flushBatch: FlushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });

    const batches = buildBatchFixtures(tenantId, linkA, linkB);

    // Sequential, not concurrent — mirrors how a single worker instance's
    // BatchAccumulator actually drives flushBatch (one flush's callback
    // runs to completion; a NEW batch opens for anything that arrives
    // meanwhile, per accumulator.ts's own "swap before invoke" design) and
    // keeps this test proving the real coupled ordering (R2 PUT, then
    // Postgres INSERT) per batch without also introducing 20-way
    // concurrent-write behavior this task was never asked to prove.
    for (const batch of batches) {
      r2CreatedKeys.push(eventBatchKey(batch.batchId, batch.occurredAt));
      await flushBatch(batch.events, batch.batchId);
    }

    // A same-day range: eventPrefixes' own day-granularity semantics
    // (keys.ts's own header) mean passing the SAME instant for `from`/`to`
    // already returns the full 24-hour-prefix set for that UTC day —
    // covering all three of BATCH_HOUR_OFFSETS' hours (and the 21 empty
    // ones besides, which streamEventLog tolerates — stream-read.test.ts's
    // own "yields nothing... for a prefix range with no matching objects"
    // already proves that).
    const dayInstant = new Date(FIXTURE_DAY_MS).toISOString();
    const prefixes = eventPrefixes(dayInstant, dayInstant);
    expect(prefixes).toHaveLength(24);

    r2State = await collectR2State(r2Client, REAL_R2_CONFIG.bucket, prefixes, tenantId);
    r2EventIds = new Set(r2State.keys());

    pgRows = await fetchAllEventRows(pg, tenantId);
    pgEventIds = new Set(pgRows.map((row) => row.event_id));

    idDiff = diffEventIdSets(pgEventIds, r2EventIds);

    mismatchedEnrichmentEventIds = pgRows
      .filter((row) => {
        const r2Record = r2State.get(row.event_id);
        // Absent-on-one-side event_ids are already surfaced by idDiff
        // above — this loop only judges events present in BOTH stores, so
        // a set-membership failure and a field-mismatch failure are never
        // double-counted as the same finding.
        return r2Record !== undefined && !fieldsMatch(row, r2Record);
      })
      .map((row) => row.event_id);
  }, RECONCILIATION_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: REAL_R2_CONFIG.bucket,
          Delete: { Objects: r2CreatedKeys.map((key) => ({ Key: key })) },
        }),
      );
    }
    r2Client.destroy();
    await pg.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(`captured exactly ${TOTAL_EVENTS} distinct event_ids in Postgres`, () => {
    expect(pgRows).toHaveLength(TOTAL_EVENTS);
    expect(pgEventIds.size).toBe(TOTAL_EVENTS);
  });

  it(`captured exactly ${TOTAL_EVENTS} distinct event_ids in the R2 NDJSON log across the covered hour prefixes`, () => {
    expect(r2EventIds.size).toBe(TOTAL_EVENTS);
  });

  it('[INV-7] the Postgres event_id set and the R2 event_id set are equal', () => {
    expect(pgEventIds.size).toBe(r2EventIds.size);
    expect([...pgEventIds].sort()).toEqual([...r2EventIds].sort());
  });

  it('[INV-7] the symmetric difference is empty in both directions — no event exists in only one store', () => {
    expect(idDiff.onlyInFirst).toEqual([]); // Postgres holds nothing R2 lacks
    expect(idDiff.onlyInSecond).toEqual([]); // R2 holds nothing Postgres lacks
  });

  it("every event's enrichment fields (browser, browser_version, os, device_type, source_platform, is_in_app, dest_host, country, asn) match between its R2 NDJSON line and its Postgres row", () => {
    expect(mismatchedEnrichmentEventIds).toEqual([]);
  });

  it('exercised real enrichment diversity across profiles/links — not a vacuous all-null comparison', () => {
    const destHosts = new Set(pgRows.map((row) => row.dest_host));
    const sourcePlatforms = new Set(pgRows.map((row) => row.source_platform));
    const inAppFlags = new Set(pgRows.map((row) => row.is_in_app));

    // Two links (linkA/linkB), two distinct resolvable hosts.
    expect(destHosts.size).toBe(2);
    // instagram (profile 0/1), directo (profile 2, null/null), tiktok
    // (profile 3) — the exact three values flush.test.ts's own identical
    // UA/referer fixtures already prove real enrich() output for.
    expect(sourcePlatforms).toEqual(new Set(['instagram', 'directo', 'tiktok']));
    expect(inAppFlags).toEqual(new Set([true, false]));
  });
});
