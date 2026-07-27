import type { CaptureEvent } from '@posta/contracts';
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
