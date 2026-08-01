import type { CaptureEvent } from '@posta/contracts';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { EnrichmentResult } from '../enrichment';

// T3.4.2 (E3, S3.4) [INV-4][INV-6] — the R2 NDJSON writer for invariant 7
// ("the R2 NDJSON log is the source of truth for events; Postgres is a
// rebuildable projection — every event goes to both"). serializeBatch()
// turns a batch of fully-enriched event rows into the exact bytes a later
// task (T3.4.3+) hands to createR2Client()'s PutObjectCommand.
//
// --- Why the input type is CaptureEvent & EnrichmentResult -----------------
//
// This function's own "after" dependency is only T3.2.5 (enrich()), and it
// needs both the 20-ish capture-time signals AND the 7 enrichment columns
// per event — the full row shape a flush (T3.3.2, a sibling task) has
// assembled by the time it is ready to write to BOTH Postgres and R2. Both
// halves already use snake_case field names matching the `events` table's
// actual Postgres column names (CaptureEvent per its own header;
// EnrichmentResult per enrich.ts's), so LoggedEvent needs no renaming to
// become a durable NDJSON row that can later be replayed straight back into
// Postgres — see this file's header on invariant 7 above. Deliberately not
// EventRow (schema/events.ts's Drizzle-inferred type): that type's
// `occurredAt` is a `Date`/camelCase shape meant for a query result, not for
// a value that has to survive a BullMQ round-trip and become durable JSON;
// LoggedEvent's `occurred_at` stays the ISO-8601 string CaptureEvent already
// carries, which is also the only sane JSON representation of a timestamp
// (JSON has no native Date type).
export type LoggedEvent = CaptureEvent & EnrichmentResult;

// The exact `events` column set (schema/events.ts, 31 columns: the 24
// capture-time fields CaptureEventSchema validates, plus the worker's 7
// enrichment columns), expressed as an explicit interface — not
// `Record<string, unknown>` — so that an object LITERAL assigned to this
// type gets a compile-time excess-property error if it ever names an
// unexpected key. This is the allowlist ndjson.test.ts's key-set assertion
// checks against; keep it in lockstep with schema/events.ts by hand (the
// test derives ITS OWN expected list from the live Drizzle table via
// getTableColumns(), so any drift between the two fails loudly there,
// rather than silently).
interface EventLogLine {
  event_id: string;
  occurred_at: string;
  tenant_id: string;
  link_id: string;
  slug: string;
  visitor_hash: string | null;
  http_method: string | null;
  user_agent: string | null;
  referer: string | null;
  accept: string | null;
  accept_language: string | null;
  sec_fetch_site: string | null;
  sec_fetch_mode: string | null;
  sec_fetch_dest: string | null;
  sec_fetch_user: string | null;
  sec_purpose: string | null;
  sec_ch_ua: string | null;
  sec_ch_ua_mobile: string | null;
  sec_ch_ua_platform: string | null;
  purpose: string | null;
  x_purpose: string | null;
  x_moz: string | null;
  country: string | null;
  asn: number | null;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  device_type: string | null;
  source_platform: string;
  is_in_app: boolean;
  dest_host: string | null;
}

/**
 * Copies exactly the 31 `events` columns off `event`, by name, one field
 * per line of this object literal — NOT a spread, NOT `Object.keys()`
 * filtering. This is the mechanism, not merely a convention: even if some
 * future bug attaches an extra field (an `ip`, a `classification`/verdict)
 * to the object that reaches this function, that field is structurally
 * unreachable here — this literal has no key for it, and there is no
 * spread anywhere in this file that could re-admit it. Widening
 * {@link LoggedEvent} itself would not change that; this function would
 * still only read the 31 property accesses written below.
 */
function toLogLine(event: LoggedEvent): EventLogLine {
  return {
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    tenant_id: event.tenant_id,
    link_id: event.link_id,
    slug: event.slug,
    visitor_hash: event.visitor_hash,
    http_method: event.http_method,
    user_agent: event.user_agent,
    referer: event.referer,
    accept: event.accept,
    accept_language: event.accept_language,
    sec_fetch_site: event.sec_fetch_site,
    sec_fetch_mode: event.sec_fetch_mode,
    sec_fetch_dest: event.sec_fetch_dest,
    sec_fetch_user: event.sec_fetch_user,
    sec_purpose: event.sec_purpose,
    sec_ch_ua: event.sec_ch_ua,
    sec_ch_ua_mobile: event.sec_ch_ua_mobile,
    sec_ch_ua_platform: event.sec_ch_ua_platform,
    purpose: event.purpose,
    x_purpose: event.x_purpose,
    x_moz: event.x_moz,
    country: event.country,
    asn: event.asn,
    browser: event.browser,
    browser_version: event.browser_version,
    os: event.os,
    device_type: event.device_type,
    source_platform: event.source_platform,
    is_in_app: event.is_in_app,
    dest_host: event.dest_host,
  };
}

/**
 * `JSON.stringify(toLogLine(event))`, with the failing event identified in
 * the error if it throws (e.g. a BigInt smuggled onto the object via an
 * unsafe cast — none of {@link EventLogLine}'s 31 fields can naturally
 * produce a circular reference, but nothing stops a caller from handing
 * this function something that violates {@link LoggedEvent}'s own type at
 * runtime). Deliberately does NOT catch-and-skip: {@link serializeBatch}'s
 * own docstring explains why one poisoned event failing the WHOLE batch,
 * loudly, is the correct behavior for this codebase — this wrapper only
 * makes that failure diagnosable, it does not change what fails or when.
 */
function serializeEvent(event: LoggedEvent): string {
  try {
    return JSON.stringify(toLogLine(event));
  } catch (cause) {
    throw new Error(
      `serializeBatch: failed to serialize event_id=${event.event_id} occurred_at=${event.occurred_at}`,
      { cause },
    );
  }
}

/**
 * Serializes a batch of fully-enriched event rows to NDJSON: one JSON
 * object per line, every line (including the last) newline-terminated, no
 * trailing blank line — the standard NDJSON convention (ndjson.org: "the
 * last character in the file MAY be a line separator, and it will be
 * treated the same as if there was no line separator present"), which is
 * also what lets a plain `output.split('\n')`/`readline` consumer read this
 * back without special-casing the final line. An empty batch returns the
 * empty string, not a lone `'\n'`.
 *
 * Returns a plain `string`. No explicit UTF-8 encoding step happens here on
 * purpose: `JSON.stringify` already produces a valid JSON string for any
 * input (control characters, unicode, emoji all get correctly
 * escaped/represented per the JSON spec), and Node's own string handling is
 * UTF-16 internally regardless — the ONLY place an actual UTF-8 BYTE
 * encoding decision gets made is whoever calls `Buffer.from(output,
 * 'utf-8')` (or hands this string straight to a `Body` that defaults to
 * UTF-8) ahead of a PutObjectCommand, which is a later task (T3.4.3+), not
 * this function. Adding an encoding step here would just be redundant
 * work this function has no way to verify actually matters until that
 * caller exists.
 *
 * Fields are copied through {@link toLogLine}'s explicit allowlist — see
 * that function's own docstring for why a spread can never leak an
 * unexpected field (invariant 4, invariant 6) into this durable log.
 *
 * If serializing ANY single event throws, the WHOLE batch throws — this is
 * deliberate, not an oversight. Invariant 7 ("every event goes to both
 * Postgres and R2") means a silent per-event skip here (write N-1 of N
 * events to R2 while a sibling flush's Postgres write for the SAME batch
 * either succeeds or fails as a whole) would create exactly the
 * store-inconsistency invariant 7 exists to prevent: an event durably in
 * Postgres with no corresponding record it was ever dropped from the R2
 * log. "One poisoned event in an otherwise-good batch" has a planned home
 * — the split-retry/poison-DLQ handling later E3 tasks add on the Postgres
 * side — and this function deferring to that mechanism (by failing loudly
 * and completely) is the correct, visible failure mode, not a gap to
 * paper over with a try/catch-and-continue here. {@link serializeEvent}
 * only makes that failure diagnosable (which `event_id` caused it), it
 * does not change whether or when it happens.
 */
export function serializeBatch(events: readonly LoggedEvent[]): string {
  return events.map((event) => `${serializeEvent(event)}\n`).join('');
}

// T3.6.2 (E3, S3.6) [INV-7] — the streaming reader half of this file's R2
// NDJSON log: streamEventLog() is the exact inverse of serializeBatch()
// above, generalized from one batch's body to an entire `[from, to]` range
// (eventPrefixes()'s own output, T3.6.1). It exists for replay — rebuilding
// Postgres from the R2 log (invariant 7: "R2 is the source of truth;
// Postgres is a rebuildable projection") — which means it has to work the
// day the range is a year wide: MILLIONS of objects, potentially GIGABYTES
// of NDJSON. Every choice below exists to keep this function's own memory
// use O(1) in the range size, not O(range):
//
//   - ListObjectsV2 is paginated with ContinuationToken, LIST_PAGE_SIZE
//     (1000, S3/R2's own max) keys materialized at a time — never the
//     whole prefix's key list.
//   - Each object's body is read with `node:readline` over the SDK's own
//     Readable, which buffers only up to the next '\n' — never
//     `.transformToString()`/`.transformToByteArray()`, both of which
//     would pull the entire object into memory before yielding a single
//     line.
//   - Objects are drained ONE AT A TIME (`yield*` delegating into a nested
//     generator, inside a plain `for await`) — deliberately NOT
//     `Promise.all` across objects, which would hold multiple response
//     bodies open (and their internal buffers filling) concurrently,
//     working against the exact memory goal this function exists for, even
//     though each individual GetObjectCommand stream is itself lazy.
//
// Consequently this function is intentionally SLOW relative to a
// concurrent/buffered reader — replay is a disaster-recovery/backfill path
// (T3.6.3+), not a request-latency-sensitive one; bounded memory over a
// year-wide range is the actual requirement, not throughput.
//
// --- Why this yields the bare LoggedEvent, unmodified ----------------
//
// Every line this function reads was already written by serializeBatch()
// above (toLogLine()'s allowlist), so JSON.parse()-ing it back is a true
// structural inverse: the same 31 keys, same values, same types — nothing
// to re-derive. `dest_host` (and every other enrichment column) is read
// verbatim off the line, never recomputed: a future replay consumer
// (T3.6.3) re-deriving `dest_host` from the link's CURRENT Postgres
// destination instead of reusing what this function read off the archived
// line would silently rewrite history on every replay — the value at
// capture/flush time is what R2 durably recorded, and invariant 7 makes
// that record authoritative. This function has no enrichment/re-derivation
// logic anywhere in it, on purpose; it is a pure reader.
const LIST_PAGE_SIZE = 1000;

/** True only for the shape `readline.createInterface({ input })` and
 * `Readable#destroy()` both need. The AWS SDK's own declared `Body` type is
 * a Node/browser union (`SdkStream<IncomingMessage | Readable> |
 * SdkStream<ReadableStreamOptionalType | BlobOptionalType>`) because the
 * SAME package type-checks for both runtimes; this codebase only ever runs
 * under Node (api, worker — see client.ts's own header), where `Body` is
 * always the Node branch at runtime, but nothing in the TYPE proves that at
 * the call site. Checked at runtime, once, right where the value enters
 * this function — the same "trust boundary crossed exactly once, checked
 * there" discipline `newId()`'s own cast to `Ulid` (ulid.ts) uses. */
function isNodeReadable(value: unknown): value is Readable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === 'function'
  );
}

/** Parses one NDJSON line back into a {@link LoggedEvent}. Throws loudly,
 * naming the source key and line number, rather than silently skipping a
 * corrupt line — a partial replay that quietly drops records is a worse
 * failure mode than a loud one that stops and names exactly where the
 * corruption is (same "fail whole and diagnosably" discipline
 * serializeEvent's own docstring argues for on the write side). Does not
 * re-validate the 31-key shape against a schema: this reader's whole
 * contract is "hand back exactly what was archived", and a NDJSON file
 * spanning years of history may have been written by an EARLIER version of
 * toLogLine()'s own column set — schema-validating against today's shape
 * here would reject perfectly valid old records, which is a worse outcome
 * for a replay/rebuild tool than trusting a line this SAME codebase's own
 * writer produced. */
function parseLoggedEventLine(line: string, key: string, lineNumber: number): LoggedEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new Error(
      `streamEventLog: line ${lineNumber} of key "${key}" is not valid JSON`,
      { cause },
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `streamEventLog: line ${lineNumber} of key "${key}" parsed to a JSON ${Array.isArray(parsed) ? 'array' : typeof parsed}, not an object`,
    );
  }

  return parsed as LoggedEvent;
}

/** Paginates `ListObjectsV2` under `prefix`, yielding one key at a time.
 * S3/R2 returns keys within a single ListObjectsV2 response in
 * lexicographic (UTF-8 binary) order, and `eventBatchKey`'s own batchId
 * segment is a ULID (lexicographically = chronologically ordered), so
 * `streamEventLog`'s overall output preserves the order objects were
 * originally written in — see stream-read.test.ts's own ordering
 * assertion, which depends on exactly this. */
async function* listObjectKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
): AsyncGenerator<string, void, void> {
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: LIST_PAGE_SIZE,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );

    for (const object of page.Contents ?? []) {
      if (object.Key) yield object.Key;
    }

    if (!page.IsTruncated) {
      continuationToken = undefined;
      continue;
    }

    if (!page.NextContinuationToken) {
      throw new Error(
        `streamEventLog: ListObjectsV2 for prefix "${prefix}" reported IsTruncated=true with no NextContinuationToken`,
      );
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
}

/** Streams a single object's body line by line via `node:readline`, which
 * buffers only up to the next newline — never the whole body. Closes the
 * readline interface and the underlying stream in `finally` so an early
 * `.return()` on the OUTER generator (a caller `break`-ing out of a
 * `for await` over `streamEventLog`) does not leak an open MinIO/R2
 * connection. */
async function* streamRecordsFromObject(
  client: S3Client,
  bucket: string,
  key: string,
): AsyncGenerator<LoggedEvent, void, void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body;

  if (!isNodeReadable(body)) {
    throw new Error(`streamEventLog: GetObjectCommand for key "${key}" returned no readable body`);
  }

  const lines = createInterface({ input: body, crlfDelay: Infinity });

  try {
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length === 0) continue;
      yield parseLoggedEventLine(line, key, lineNumber);
    }
  } finally {
    lines.close();
    if (!body.destroyed) body.destroy();
  }
}

/**
 * Streams every event logged under any of `prefixes` (typically
 * `eventPrefixes(from, to)`'s own output), in the order objects were
 * originally written — see this section's own header comment above for
 * the full memory-boundedness reasoning, and `listObjectKeys`'s for why
 * that order matches `eventBatchKey`'s write order.
 *
 * Memory use is O(1) in the number of objects/records the range covers:
 * at most one `ListObjectsV2` page (1000 keys) and one object body's
 * current line are held at a time, regardless of whether `prefixes` spans
 * an hour or a decade. Never call `Array.fromAsync`/spread this generator
 * into an array for a wide range — that reintroduces exactly the
 * unbounded buffering this function exists to avoid; a caller (T3.6.3's
 * replay driver) must consume it with `for await` and act on each record
 * as it arrives.
 */
export async function* streamEventLog(
  client: S3Client,
  bucket: string,
  prefixes: readonly string[],
): AsyncGenerator<LoggedEvent, void, void> {
  for (const prefix of prefixes) {
    for await (const key of listObjectKeys(client, bucket, prefix)) {
      yield* streamRecordsFromObject(client, bucket, key);
    }
  }
}
