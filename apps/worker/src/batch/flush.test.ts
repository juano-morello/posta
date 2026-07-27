import path from 'node:path';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Pool, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  links,
  newId,
  runSqlMigrations,
  user,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch, type FlushBatchLogger } from './flush';

// T3.3.2 [E3, S3.3][INV-8] — flushBatch's own suite. `events` is
// hand-written SQL (packages/core/migrations/sql/001_events.sql,
// T1.2.2), applied through runSqlMigrations — startPgContainer() alone
// only runs drizzle-kit's OWN migrations, so without this the `events`
// table and create_events_partition() genuinely do not exist (mirrors
// events-schema.test.ts / partition-maintenance.job.test.ts's identical
// setup).
//
// Every assertion below reads `events` back via the RAW pool
// (`handle.pool.query('SELECT ... FROM events ...')`), never
// drizzle's own query builder — apps/worker (this file included) never
// imports drizzle-orm directly, matching flush.ts's own boundary
// discipline (see that file's header): every OTHER apps/worker test
// touching Postgres (partition-maintenance.job.test.ts,
// default-partition-alert.test.ts) reads back through raw SQL too, for
// the identical reason.
//
// All flush-related work (both flushBatch() calls, proving [INV-8]'s
// "same batch twice" idempotency) happens ONCE, in beforeAll — every
// `it()` below only asserts against state already captured there, so
// none of them depend on declaration order or on each other, even
// though they share one expensive testcontainers Postgres boot.
//
// [T3.4.4] flushBatch now also PUTs to R2 on every flush (see flush.ts's
// own header) — createFlushBatch's `r2Client`/`r2Bucket` are REQUIRED
// options as of that task, so this suite's own assertions (still entirely
// about the POSTGRES side — see file header above) now need a real R2
// client too, or every flushBatch() call below would reject before ever
// reaching the SELECT/INSERT this file actually tests. `REAL_R2_CONFIG`
// mirrors packages/core/src/r2/client.test.ts's own `REAL_CONFIG`
// (same local-dev-only MinIO root credentials, already in .env.example).
// Both flushes of `events100` are given the SAME explicit `batchId` —
// `eventBatchKey`'s own idempotency property (retrying the same batch_id
// overwrites the same R2 key rather than duplicating an object) means
// this needs only ONE key tracked for cleanup, not two.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
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

// The real, verified `events` column count — schema/events.ts (T1.2.4)
// and packages/core/src/r2/ndjson.ts (T3.4.2) both independently state
// it: 24 capture-time fields CaptureEventSchema validates (NOT 20 — see
// this task's own report) plus 7 enrichment columns = 31. Used below to
// prove the batch INSERT carries every row's full parameter set in one
// statement, not a partial or chunked one.
const EVENTS_COLUMN_COUNT = 31;

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const INSTAGRAM_IN_APP_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.114 (iPhone14,3; iOS 17_4; en_US; en-US; scale=3.00; 1284x2778; 498540814)';
const PIXEL_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36';

interface QuerySpyCall {
  readonly text: string;
  readonly paramCount: number;
}

interface QuerySpy {
  readonly calls: QuerySpyCall[];
  reset(): void;
  restore(): void;
}

/**
 * Intercepts every SQL statement `pool.query()` issues, recording the
 * text and the parameter count of each call — the mechanism this task's
 * own brief asks for ("wrapping the pool's own query() method to count
 * invocations during the flush"). Reassigning the INSTANCE property
 * (not the prototype method) means drizzle's own internal calls — which
 * read `this.client.query(...)` off the SAME pool object at call time
 * (verified against the installed drizzle-orm@0.45.2 node-postgres
 * driver source) — are captured too, without drizzle ever being told
 * anything changed.
 *
 * The first argument is `string | { text: string }`: drizzle-orm's
 * node-postgres driver ALWAYS calls `client.query(rawQueryConfig,
 * params)` with a `QueryConfig`-shaped object (verified against that
 * same installed source — `NodePgPreparedQuery#execute`/`#all` both
 * pass `this.rawQueryConfig`, never a bare string), even though pg's own
 * `Pool#query` also accepts a plain string — this test's own
 * `handle.pool.query('SELECT ...', [...])` calls (used for setup/
 * assertions, outside the flush window this spy is active for) DO pass
 * a bare string, so both shapes have to be handled. Narrowed to this one
 * promise-returning call shape deliberately — pg's `Pool#query` is
 * otherwise so heavily overloaded that `Parameters<Pool['query']>`
 * resolves to its LAST declared overload (a 3-arg callback form), the
 * wrong shape entirely.
 */
function spyOnPoolQueries(pool: Pool): QuerySpy {
  const originalQuery = pool.query.bind(pool) as (
    textOrConfig: string | { text: string },
    params?: unknown[],
  ) => Promise<QueryResult>;
  const calls: QuerySpyCall[] = [];

  const spied = (textOrConfig: string | { text: string }, params?: unknown[]): Promise<QueryResult> => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    calls.push({ text, paramCount: params?.length ?? 0 });
    return originalQuery(textOrConfig, params);
  };

  pool.query = spied as unknown as Pool['query'];

  return {
    calls,
    reset() {
      calls.length = 0;
    },
    restore() {
      pool.query = originalQuery as unknown as Pool['query'];
    },
  };
}

interface LoggerCall {
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

interface RecordingLogger extends FlushBatchLogger {
  readonly calls: LoggerCall[];
  reset(): void;
}

/** A plain recording double for {@link FlushBatchLogger} — the SAME
 * shape as the querySpy above (a `reset()`-able array), no `vi.fn()`
 * needed for a single-method interface this simple. */
function makeRecordingLogger(): RecordingLogger {
  const calls: LoggerCall[] = [];
  return {
    calls,
    error(message, meta) {
      calls.push(meta !== undefined ? { message, meta } : { message });
    },
    reset() {
      calls.length = 0;
    },
  };
}

function insertStatements(calls: readonly QuerySpyCall[]): QuerySpyCall[] {
  return calls.filter((call) => /^\s*insert\s+into\s+"?events"?/i.test(call.text));
}

function selectFromLinksStatements(calls: readonly QuerySpyCall[]): QuerySpyCall[] {
  return calls.filter((call) => /^\s*select\b/i.test(call.text) && /"?links"?/i.test(call.text));
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

/** A fully-signalled CaptureEvent, every field defaulted to `null`
 * except the required identity/context frame — callers override just
 * the fields their profile cares about, so nothing is left implicitly
 * `undefined` (CaptureEventSchema is `.strict()` with every signal an
 * explicit nullable, never optional). */
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

interface EventEnrichmentRow {
  readonly browser: string | null;
  readonly browser_version: string | null;
  readonly os: string | null;
  readonly device_type: string | null;
  readonly source_platform: string | null;
  readonly is_in_app: boolean | null;
  readonly dest_host: string | null;
}

async function fetchEventEnrichment(
  handle: PgContainerHandle,
  eventId: string,
): Promise<EventEnrichmentRow | undefined> {
  const result = await handle.pool.query<EventEnrichmentRow>(
    'SELECT browser, browser_version, os, device_type, source_platform, is_in_app, dest_host ' +
      'FROM events WHERE event_id = $1',
    [eventId],
  );
  return result.rows[0];
}

describe('createFlushBatch / flushBatch (T3.3.2)', () => {
  let handle: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  const r2CreatedKeys: string[] = [];

  let profile0EventId: string; // desktop Chrome + Instagram referer, resolvable destination
  let profile1EventId: string; // Instagram in-app UA, no referer
  let profile2EventId: string; // resolvable destination, every UA/referer signal null
  let profile3EventId: string; // TikTok referer + Android Chrome UA
  let profile4EventId: string; // link_id with no matching `links` row at all
  let profile5EventId: string; // link_id exists, but under the WRONG tenant

  let firstFlushCalls: QuerySpyCall[];
  let secondFlushCalls: QuerySpyCall[];
  let finalRowCount: number;
  let emptyBatchCalls: QuerySpyCall[];

  let firstFlushLoggerCalls: LoggerCall[];
  let secondFlushLoggerCalls: LoggerCall[];
  let emptyBatchLoggerCalls: LoggerCall[];

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    const tenantA = await seedTenant(handle);
    const tenantB = await seedTenant(handle);

    const linkInstagramShop = await seedLink(
      handle,
      tenantA,
      'shop',
      'https://Shop.Example.com:443/promo?utm_source=ig',
    );
    const linkBlogInApp = await seedLink(handle, tenantA, 'blog', 'https://blog.example.org/post');
    const linkNullSignals = await seedLink(
      handle,
      tenantA,
      'null-case',
      'https://null-signals.example.net',
    );
    const linkTikTok = await seedLink(handle, tenantA, 'tiktok', 'https://another.example.com/x');
    const linkNeverInserted = newId(); // a syntactically valid ULID, never written to `links`

    const events100: CaptureEvent[] = Array.from({ length: 100 }, (_, index) => {
      const profile = index % 6;
      switch (profile) {
        case 0:
          return buildCaptureEvent({
            tenant_id: tenantA,
            link_id: linkInstagramShop,
            slug: 'shop',
            user_agent: DESKTOP_CHROME_UA,
            referer: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com',
          });
        case 1:
          return buildCaptureEvent({
            tenant_id: tenantA,
            link_id: linkBlogInApp,
            slug: 'blog',
            user_agent: INSTAGRAM_IN_APP_UA,
            referer: null,
          });
        case 2:
          return buildCaptureEvent({
            tenant_id: tenantA,
            link_id: linkNullSignals,
            slug: 'null-case',
            user_agent: null,
            referer: null,
          });
        case 3:
          return buildCaptureEvent({
            tenant_id: tenantA,
            link_id: linkTikTok,
            slug: 'tiktok',
            user_agent: PIXEL_CHROME_UA,
            referer: 'https://www.tiktok.com/@someone/video/123',
          });
        case 4:
          return buildCaptureEvent({
            tenant_id: tenantA,
            link_id: linkNeverInserted,
            slug: 'gone',
            user_agent: DESKTOP_CHROME_UA,
            referer: null,
          });
        default:
          // profile 5 — tenant mismatch: linkInstagramShop is really
          // tenantA's, but this event claims tenantB.
          return buildCaptureEvent({
            tenant_id: tenantB,
            link_id: linkInstagramShop,
            slug: 'shop',
            user_agent: DESKTOP_CHROME_UA,
            referer: null,
          });
      }
    });

    profile0EventId = events100[0]!.event_id;
    profile1EventId = events100[1]!.event_id;
    profile2EventId = events100[2]!.event_id;
    profile3EventId = events100[3]!.event_id;
    profile4EventId = events100[4]!.event_id;
    profile5EventId = events100[5]!.event_id;

    const flushLogger = makeRecordingLogger();
    const flushBatch: FlushBatch = createFlushBatch({
      db: handle.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      logger: flushLogger,
    });
    const querySpy = spyOnPoolQueries(handle.pool);

    // Same explicit batchId for both flushes of events100 below — see
    // this file's own header (T3.4.4 addendum) for why that means only
    // ONE R2 key needs tracking for cleanup, not two.
    const events100BatchId = newId();
    r2CreatedKeys.push(eventBatchKey(events100BatchId, events100[0]!.occurred_at));

    querySpy.reset();
    flushLogger.reset();
    await flushBatch(events100, events100BatchId);
    firstFlushCalls = [...querySpy.calls];
    firstFlushLoggerCalls = [...flushLogger.calls];

    querySpy.reset();
    flushLogger.reset();
    await flushBatch(events100, events100BatchId); // [INV-8] the SAME batch, again
    secondFlushCalls = [...querySpy.calls];
    secondFlushLoggerCalls = [...flushLogger.calls];

    querySpy.reset();
    flushLogger.reset();
    await flushBatch([]);
    emptyBatchCalls = [...querySpy.calls];
    emptyBatchLoggerCalls = [...flushLogger.calls];

    querySpy.restore();

    const countResult = await handle.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM events',
    );
    finalRowCount = Number(countResult.rows[0]?.count ?? '0');
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await Promise.all(
        r2CreatedKeys.splice(0).map((key) =>
          r2Client.send(new DeleteObjectCommand({ Bucket: REAL_R2_CONFIG.bucket, Key: key })),
        ),
      );
    }
    r2Client.destroy();
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('[INV-8] exactly 100 rows exist after the first flush, still exactly 100 after flushing the identical batch again', () => {
    expect(finalRowCount).toBe(100);
  });

  it('the first flush issues exactly ONE INSERT statement, carrying every row\'s full parameter set — never chunked, never per-row', () => {
    const inserts = insertStatements(firstFlushCalls);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.paramCount).toBe(100 * EVENTS_COLUMN_COUNT);
  });

  it('the second (re-)flush ALSO issues exactly ONE INSERT statement — ON CONFLICT DO NOTHING stays a single statement, not one attempt per row', () => {
    const inserts = insertStatements(secondFlushCalls);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.paramCount).toBe(100 * EVENTS_COLUMN_COUNT);
  });

  it('the first flush issues exactly ONE batched destination SELECT — never one per event', () => {
    const selects = selectFromLinksStatements(firstFlushCalls);
    expect(selects).toHaveLength(1);
  });

  it('the first flush issues exactly two statements total (the batched SELECT, then the batched INSERT) — see flush.ts\'s own header for why not one', () => {
    expect(firstFlushCalls).toHaveLength(2);
  });

  it('an empty batch issues zero statements and is a pure no-op', () => {
    expect(emptyBatchCalls).toHaveLength(0);
  });

  // [review round 2, observability fix] profiles 4 (not-found, 16 of the
  // 100 events) and 5 (tenant-mismatch, 16 of the 100 events) are exactly
  // the "some link_ids didn't resolve" case flushBatch must now surface —
  // one summary line per flush, not per event.
  it('logs exactly ONE batch-level summary when some events fail to resolve a destination, naming both failure reasons', () => {
    expect(firstFlushLoggerCalls).toHaveLength(1);
    const [call] = firstFlushLoggerCalls;
    expect(call?.message).toContain('32 of 100');
    expect(call?.meta).toMatchObject({
      batchSize: 100,
      distinctLinkIdCount: 5,
      unresolvedCount: 32,
      notFoundCount: 16,
      tenantMismatchCount: 16,
    });
  });

  it('the second (re-)flush logs the SAME summary again — resolution is recomputed every flush, not remembered from the first', () => {
    expect(secondFlushLoggerCalls).toHaveLength(1);
    expect(secondFlushLoggerCalls[0]?.meta).toMatchObject({
      unresolvedCount: 32,
      notFoundCount: 16,
      tenantMismatchCount: 16,
    });
  });

  it('an empty batch logs nothing', () => {
    expect(emptyBatchLoggerCalls).toHaveLength(0);
  });

  it('logs nothing when every event in a batch resolves cleanly — no noise on the happy path', async () => {
    const tenant = await seedTenant(handle);
    const link = await seedLink(handle, tenant, 'clean', 'https://clean.example.com/ok');
    const logger = makeRecordingLogger();
    const flush = createFlushBatch({ db: handle.db, r2Client, r2Bucket: REAL_R2_CONFIG.bucket, logger });
    const cleanEvent = buildCaptureEvent({ tenant_id: tenant, link_id: link, slug: 'clean' });
    const batchId = newId();
    r2CreatedKeys.push(eventBatchKey(batchId, cleanEvent.occurred_at));

    await flush([cleanEvent], batchId);

    expect(logger.calls).toHaveLength(0);
  });

  it('defaults to consoleErrorLogger (writes to console.error) when no logger is injected', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const flush = createFlushBatch({ db: handle.db, r2Client, r2Bucket: REAL_R2_CONFIG.bucket });
      const orphanEvent = buildCaptureEvent({}); // random tenant_id/link_id, never seeded -> not-found
      const batchId = newId();
      r2CreatedKeys.push(eventBatchKey(batchId, orphanEvent.occurred_at));

      await flush([orphanEvent], batchId);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('populates enrichment columns for a real desktop-Chrome + Instagram-referer + resolvable-destination hit', async () => {
    const row = await fetchEventEnrichment(handle, profile0EventId);

    expect(row).toMatchObject({
      browser: 'Chrome',
      browser_version: '125.0.0.0',
      os: 'Windows',
      device_type: 'desktop',
      source_platform: 'instagram',
      is_in_app: false,
      dest_host: 'shop.example.com',
    });
  });

  it('populates enrichment columns for a real in-app UA hit with no referer', async () => {
    const row = await fetchEventEnrichment(handle, profile1EventId);

    expect(row).toMatchObject({
      is_in_app: true,
      source_platform: 'instagram',
      device_type: 'mobile',
      dest_host: 'blog.example.org',
    });
  });

  it('resolves dest_host to a real host when the destination is resolvable but every UA/referer signal is null, falling back source_platform to directo', async () => {
    const row = await fetchEventEnrichment(handle, profile2EventId);

    expect(row).toMatchObject({
      browser: null,
      os: null,
      device_type: null,
      source_platform: 'directo',
      is_in_app: false,
      dest_host: 'null-signals.example.net',
    });
  });

  it('resolves source_platform from a referer host (TikTok) with device/browser facts from a real mobile UA', async () => {
    const row = await fetchEventEnrichment(handle, profile3EventId);

    expect(row?.source_platform).toBe('tiktok');
    expect(row?.device_type).toBe('mobile');
    expect(row?.dest_host).toBe('another.example.com');
  });

  it('resolves dest_host to null when link_id has no matching links row at all', async () => {
    const row = await fetchEventEnrichment(handle, profile4EventId);

    expect(row?.dest_host).toBeNull();
    // UA-derived facts are unaffected by an unresolvable destination.
    expect(row?.browser).toBe('Chrome');
  });

  it('[security] resolves dest_host to null when link_id exists but under a DIFFERENT tenant than the event claims', async () => {
    const row = await fetchEventEnrichment(handle, profile5EventId);

    // The link genuinely resolves (it exists, owned by tenant A) but this
    // event claims tenant B — the mismatch must be rejected, not trusted.
    expect(row?.dest_host).toBeNull();
    expect(row?.browser).toBe('Chrome');
  });
});
