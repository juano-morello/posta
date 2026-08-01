import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createR2Client, eventBatchKey, links, newId, runSqlMigrations, user, type R2ClientConfig } from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from './flush';
import { R2_PUT_FAILED_DLQ_REASON, type R2BatchDlqSink } from './r2-retry';

// T3.2.8 [E3, S3.2] — the failure mode this file guards against is not a
// wrong field, it is a STALLED PIPELINE: one exception thrown anywhere in
// the flush of a 100-event batch must never take the whole batch down (and,
// with BullMQ retries upstream of flushBatch in production, the whole
// queue with it). Real, garbage-shaped User-Agent strings are pushed
// through the REAL, coupled flushBatch path T3.4.6 built (R2 PUT, then the
// Postgres INSERT — see flush.ts's own header) exactly like flush.test.ts's
// own 100-event batch, so this is a genuine integration proof, not a stub.
//
// RED-PHASE FINDING, recorded here because it changes what "the gap" this
// task closes actually is: T3.2.1's parseUserAgent (packages/core/src/
// enrichment/ua.ts) ALREADY wraps ua-parser-js in a try/catch that
// degrades to an all-null ParsedUserAgent — its own suite (ua.test.ts)
// already proves this against 4 KB of random binary garbage. enrich()
// itself never threw for any of this file's five fixtures either. The
// REAL gap was one layer downstream, in the Postgres write: a `text`
// column outright rejects a value containing a literal NUL byte
// (confirmed against a real local Postgres while building this test —
// `error: invalid byte sequence for encoding "UTF8": 0x00`, SQLSTATE
// 22021), and flushBatch's INSERT is ONE multi-row statement for the
// WHOLE batch (T3.3.2's own "never chunked, never per-row" property) — so
// a NUL byte hiding in even one row's raw `user_agent` rejected all 100
// rows, not just the poisoned one. That is precisely the "stalled
// pipeline" failure mode this task's own brief describes, just one layer
// downstream of where the brief pointed. flush.ts's `toNewEventRow` now
// nulls out (never mangles) any raw header-derived text field that
// contains a NUL byte before it reaches Postgres — see that function's
// own new `sanitizeForPostgresText` helper for the full reasoning,
// including why this is deliberately NOT limited to `user_agent` alone.
//
// SCHEMA-BOUNDARY CHECK (this task's own instruction, point 3): none of
// these five strings are rejected earlier, at CaptureEventSchema's own
// validation boundary. `user_agent` there is `z.string().nullable()`
// (packages/contracts/src/capture.ts's `zNullableSignal`) — no `.max()`,
// no charset restriction — so binary garbage, a 64 KB string, embedded NUL
// bytes, and lone surrogates all parse successfully as a plain Zod
// string and reach enrich() unfiltered in production too. The ONLY
// production-path defense against a literal NUL byte specifically is one
// layer further upstream than CaptureEventSchema, and outside the queue
// payload entirely: Node's own HTTP parser rejects a NUL byte in a raw
// header value with 400 before app code ever runs (see docs/plan/
// 02-redirect-hot-path.md's own note on the visitor-hash NUL delimiter).
// That guarantee does not cover this test's own harness (a directly
// constructed CaptureEvent, matching flush.test.ts's own established
// pattern, never a raw HTTP request) or T3.6.3's future R2 replay
// tooling, which is exactly why flush.ts defends at its own boundary
// instead of assuming an upstream layer it does not control already
// caught it.
//
// DLQ, NOT THE REAL EVENTS_DLQ_QUEUE: this test calls flushBatch directly
// (bypassing BullMQ entirely, the SAME choice flush.test.ts/r2-put.test.ts
// already make), so the "zero DLQ entries" the plan's own verify text asks
// for is asserted against a recording R2BatchDlqSink double, mirroring
// r2-retry.test.ts's own `createRecordingDlqSink` — not against a real
// `DlqService`/`EVENTS_DLQ_QUEUE`. Per this task's own point 5, the
// `queue.obliterate({ force: true })` cross-test hazard in
// events.consumer.test.ts only applies to the real BullMQ queue path,
// which this file never touches.
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

const CLEAN_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Five concrete hostile UA fixtures — no vague "weird string" placeholders.
//
// 1. Binary garbage: raw random bytes decoded as latin1 (one byte -> one
//    UTF-16 code unit, so every value 0x00-0xFF round-trips to a valid, if
//    garbage, JS string) — the same construction ua.test.ts's own
//    GARBAGE_UA already established as never crashing parseUserAgent.
//    With 4096 random bytes, this also very likely contains at least one
//    literal 0x00 byte on its own (independent of fixture 3 below) — a
//    second, naturally-occurring proof that the NUL-byte fix generalizes
//    rather than special-casing a hand-placed byte.
const BINARY_GARBAGE_UA = randomBytes(4096).toString('latin1');

// 2. A 64 KB string: pure SIZE stress, deliberately made of ordinary
//    printable ASCII (not random bytes, no NUL, no surrogate) so this
//    fixture exercises only the "huge" dimension, distinct from the other
//    four.
const SIXTY_FOUR_KB_UA = 'A'.repeat(64 * 1024);

// 3. Embedded NUL bytes: literal U+0000 characters spliced through an
//    otherwise plausible-length string — the exact byte Postgres `text`
//    columns reject outright (see this file's own header). Deliberately
//    contains NO real browser/OS/engine marker (no "Chrome/", "Mozilla/",
//    "AppleWebKit", ...): ua-parser-js's own regex matching does not care
//    that a NUL byte sits between two characters, so a fixture that kept
//    a real "Chrome/125.0" substring intact elsewhere in the string would
//    still parse successfully — proving nothing about how this specific
//    hostile byte is handled. This fixture is garbage-shaped throughout,
//    the same way ua.test.ts's own GARBAGE_UA is.
const NULL_BYTE_UA = `${String.fromCharCode(0)}garbage-ua${String.fromCharCode(0)}with-embedded-nul-bytes${String.fromCharCode(0)}`;

// 4. Lone (unpaired) UTF-16 surrogates: a high surrogate with no matching
//    low surrogate half, spliced through an otherwise plausible-length
//    string. Not well-formed Unicode text, but the JS string type permits
//    it — and, confirmed against real Postgres while building this test,
//    `pg` silently re-encodes it to U+FFFD rather than throwing, so this
//    fixture's row is expected to commit even without the new
//    `sanitizeForPostgresText` fix. Kept marker-free for the same reason
//    fixture 3 is: a real "Chrome/125.0" substring living anywhere in the
//    string would still be found by ua-parser-js's regex regardless of an
//    unrelated lone surrogate elsewhere, proving nothing about this
//    fixture's own hostile property.
const LONE_SURROGATE_UA = '\uD800garbage-ua-with-an-orphan-surrogate\uD800';

// 5. Combined: a NUL byte AND a lone surrogate in the SAME value — proves
//    the Postgres-write fix generalizes to more than one hostile byte
//    pattern living in one string, rather than a fix narrowly shaped
//    around fixture 3 alone. Also marker-free, same reasoning as 3 and 4.
const COMBINED_HOSTILE_UA = `${String.fromCharCode(0)}garbage\uD800ua${String.fromCharCode(0)}both-hostile-bytes-at-once`;

const HOSTILE_UAS: readonly string[] = [
  BINARY_GARBAGE_UA,
  SIXTY_FOUR_KB_UA,
  NULL_BYTE_UA,
  LONE_SURROGATE_UA,
  COMBINED_HOSTILE_UA,
];

const BATCH_SIZE = 100;

interface RecordedDlqCall {
  readonly reason: typeof R2_PUT_FAILED_DLQ_REASON;
  readonly payload: unknown;
}

/** A plain recording double for {@link R2BatchDlqSink} — mirrors
 * r2-retry.test.ts's own `createRecordingDlqSink`, kept as a second,
 * separate copy rather than an import: neither file has any other reason
 * to depend on the other, matching this codebase's own established
 * per-file test-double precedent (flush.test.ts's `makeRecordingLogger`,
 * etc.). */
function createRecordingDlqSink(): R2BatchDlqSink & { calls: RecordedDlqCall[] } {
  const calls: RecordedDlqCall[] = [];
  return {
    calls,
    async send(reason, payload) {
      calls.push({ reason, payload });
    },
  };
}

/** A fully-signalled CaptureEvent, every field defaulted to `null` except
 * the required identity/context frame — the same helper shape flush.test.ts
 * and r2-put.test.ts already establish. */
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

describe('flushBatch — garbage UA yields nulls and the batch still commits (T3.2.8)', () => {
  let handle: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  let dlqSink: R2BatchDlqSink & { calls: RecordedDlqCall[] };
  let hostileEventIds: string[];
  const r2CreatedKeys: string[] = [];

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    const tenantId = newId();
    await handle.db.insert(user).values({
      id: tenantId,
      name: 'Test Tenant',
      email: `${tenantId.toLowerCase()}@example.test`,
    });
    const linkId = newId();
    await handle.db.insert(links).values({
      id: linkId,
      tenantId,
      slug: 'promo',
      destination: 'https://example.com/promo',
    });

    // The first HOSTILE_UAS.length events carry one hostile UA each; the
    // rest carry a normal, fully-parseable desktop Chrome UA.
    const events: CaptureEvent[] = Array.from({ length: BATCH_SIZE }, (_, index) => {
      const userAgent = index < HOSTILE_UAS.length ? HOSTILE_UAS[index]! : CLEAN_CHROME_UA;
      return buildCaptureEvent({ tenant_id: tenantId, link_id: linkId, user_agent: userAgent });
    });
    hostileEventIds = events.slice(0, HOSTILE_UAS.length).map((event) => event.event_id);

    dlqSink = createRecordingDlqSink();
    const flushBatch: FlushBatch = createFlushBatch({
      db: handle.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      dlqSink,
    });

    const batchId = newId();
    r2CreatedKeys.push(eventBatchKey(batchId, events[0]!.occurred_at));

    await flushBatch(events, batchId);
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

  it('all 100 rows commit — five hostile UA strings never take down the batch', async () => {
    const result = await handle.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM events');
    expect(Number(result.rows[0]?.count ?? '0')).toBe(BATCH_SIZE);
  });

  it('browser IS NULL for exactly the 5 hostile-UA events, and only those five', async () => {
    const nullRows = await handle.pool.query<{ event_id: string }>(
      'SELECT event_id FROM events WHERE browser IS NULL ORDER BY event_id',
    );
    expect(nullRows.rows.map((row) => row.event_id).sort()).toEqual([...hostileEventIds].sort());
  });

  it('the 95 clean events keep their real, parsed browser fact', async () => {
    const chromeCount = await handle.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE browser = 'Chrome'",
    );
    expect(Number(chromeCount.rows[0]?.count ?? '0')).toBe(BATCH_SIZE - HOSTILE_UAS.length);
  });

  it('zero DLQ entries — the R2 PUT succeeded and every row was accepted, so nothing was ever routed to the DLQ', () => {
    expect(dlqSink.calls).toHaveLength(0);
  });
});
