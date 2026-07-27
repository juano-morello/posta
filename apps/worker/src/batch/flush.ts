import type { CaptureEvent } from '@posta/contracts';
import {
  enrich,
  insertEventsBatch,
  resolveDestinationsByLinkIds,
  type DbClient,
  type LoggedEvent,
  type LinkDestinationLookup,
  type NewEvent,
} from '@posta/core';

// T3.3.2 [E3, S3.3][INV-8] — flushBatch is the worker's actual write to
// Postgres: T3.2.5's enrich() composes the seven enrichment columns per
// event, and packages/core's insertEventsBatch (T3.3.2, db/events.ts)
// issues the ONE multi-row `INSERT ... ON CONFLICT (event_id,
// occurred_at) DO NOTHING` this file's own task names. See flush.test.ts
// for the two things this task had to independently prove: idempotency
// (the SAME batch flushed twice produces the SAME rows, invariant 8) and
// "one statement, not 100" (the INSERT is never chunked into one round
// trip per event).
//
// DESTINATION LOOKUP — THE GAP enrich.ts'S OWN HEADER NAMES THIS FILE AS
// OWNING: CaptureEvent has no `destination` field (E2 capture doesn't
// know it), but enrich()'s dest_host column needs one. This resolves
// every event's CURRENT destination with ONE batched Postgres SELECT per
// flush (packages/core's resolveDestinationsByLinkIds, keyed by
// `link_id` — see that function's own header, packages/core/src/db/
// tenant.ts, for why it is NOT forTenant()-scoped and why matching by
// `id` alone is still safe), never one SELECT per event. A direct
// Postgres read, not a Redis cache read: this flush already needs a
// Postgres connection for the INSERT itself, so adding Redis as a SECOND
// dependency to trace through (with its own cache-miss/staleness
// questions) buys nothing this task's scope needs.
//
// An event with no resolvable destination — its link_id wasn't in the
// batch's own SELECT result (a deleted/never-existed link), or it WAS
// found but under a tenant_id that doesn't match this event's own
// (defense in depth against a CaptureEvent that crossed a process
// boundary with a mismatched pairing) — enriches with `destination:
// null`, exactly like a CaptureEvent that already carried no
// destination: enrich() already treats `null` and `''` identically,
// resolving `dest_host` to `null` rather than throwing. That fallback is
// the CORRECT behavior, not a bug — but it was previously silent at
// scale, with no way for an operator to notice a pattern (link
// deletions racing flushes, or a genuine upstream data-integrity
// problem). [review round 2, observability fix] `logger` (see
// `FlushBatchLogger` below) now reports ONE batch-level summary line
// per flush — never per event, which would just be noise — whenever at
// least one event in the batch didn't resolve, naming how many and why
// (not-found vs. tenant-mismatch are counted separately, since a
// tenant-mismatch is a much stronger signal something is actually wrong
// upstream than an ordinary deleted link).
//
// TWO STATEMENTS PER FLUSH, NOT ONE — recorded here so it is never
// mistaken for an oversight. The destination SELECT above must run
// BEFORE enrich() (dest_host needs the destination as a plain string,
// and enrich() is pure — no I/O of its own), so it cannot be folded into
// the INSERT itself without either reimplementing destHost()'s
// URL-parsing in SQL (a second, drifting copy of T3.2.4 — the
// enrichment barrel's own header explicitly warns against a second
// composition of these functions) or a second WRITE pass (an UPDATE
// after the INSERT, touching the same 100 rows again — strictly worse).
// Both statements are batched for the WHOLE flush, never one per event —
// that is the "not 100" property this task's verify command actually
// checks for; flush.test.ts asserts both the INSERT side and the SELECT
// side of it directly, and asserts the total (2, not 1) is exactly this
// and nothing more.
//
// enrich() ALSO NEEDS A CaptureEvent & EnrichmentResult INTERMEDIATE —
// LoggedEvent (packages/core/src/r2/ndjson.ts, T3.4.2) already names
// this exact merged shape and this file (T3.3.2) as the sibling task
// that assembles it; reusing it here (rather than inventing a second,
// unnamed "enriched event" shape) is what lets a later task
// (R2's own write, T3.4.3) hand this same array straight to
// serializeBatch() without redoing enrichment.

/** Minimal logger shape this file needs — the SAME `{ error(message,
 * meta?): void }` shape apps/worker/src/consumer/events.consumer.ts's
 * own `EventsConsumerLogger` and apps/worker/src/batch/accumulator.ts's
 * own `BatchAccumulatorLogger` already use, deliberately not a fourth
 * shape — a test can pass a plain spy object, and there is still no
 * real pino instance wired up anywhere in this codebase to depend on. */
export interface FlushBatchLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Production default — writes to stderr via `console.error`, mirroring
 * the identical `consoleErrorLogger` both files named above already
 * export, as a separate instance rather than a shared import since none
 * of the three have any other reason to depend on each other. */
export const consoleErrorLogger: FlushBatchLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

/** Maps a `LoggedEvent` (the merged, snake_case `CaptureEvent &
 * EnrichmentResult` shape) onto `NewEvent` (schema/events.ts's
 * camelCase Drizzle insert shape) — one property per `events` column,
 * by name, deliberately not a spread: an object literal here gets a
 * compile-time excess-property error if it ever names an unexpected
 * key, the same discipline ndjson.ts's toLogLine() follows for the
 * identical reason. */
function toNewEventRow(logged: LoggedEvent): NewEvent {
  return {
    eventId: logged.event_id,
    occurredAt: new Date(logged.occurred_at),
    tenantId: logged.tenant_id,
    linkId: logged.link_id,
    slug: logged.slug,
    visitorHash: logged.visitor_hash,
    httpMethod: logged.http_method,
    userAgent: logged.user_agent,
    referer: logged.referer,
    accept: logged.accept,
    acceptLanguage: logged.accept_language,
    secFetchSite: logged.sec_fetch_site,
    secFetchMode: logged.sec_fetch_mode,
    secFetchDest: logged.sec_fetch_dest,
    secFetchUser: logged.sec_fetch_user,
    secPurpose: logged.sec_purpose,
    secChUa: logged.sec_ch_ua,
    secChUaMobile: logged.sec_ch_ua_mobile,
    secChUaPlatform: logged.sec_ch_ua_platform,
    purpose: logged.purpose,
    xPurpose: logged.x_purpose,
    xMoz: logged.x_moz,
    country: logged.country,
    asn: logged.asn,
    browser: logged.browser,
    browserVersion: logged.browser_version,
    os: logged.os,
    deviceType: logged.device_type,
    sourcePlatform: logged.source_platform,
    isInApp: logged.is_in_app,
    destHost: logged.dest_host,
  };
}

/** Enriches one CaptureEvent with its already-resolved `destination`
 * (or `null` when unresolvable — see this file's own header), producing
 * the merged `LoggedEvent` shape both the Postgres insert (below) and a
 * later R2 write (T3.4.3, not this task) consume identically. */
function toLoggedEvent(event: CaptureEvent, destination: string | null): LoggedEvent {
  return {
    ...event,
    ...enrich({ user_agent: event.user_agent, referer: event.referer, destination }),
  };
}

/** One event's destination-resolution outcome — `reason` is `null` for
 * a clean resolve, or names exactly why `destination` fell back to
 * `null` otherwise. Kept as an intermediate (rather than folding
 * straight into `toLoggedEvent`) so the batch-level log summary below
 * can count outcomes without re-deriving them a second time. */
interface ResolvedEvent {
  readonly event: CaptureEvent;
  readonly destination: string | null;
  readonly reason: 'not-found' | 'tenant-mismatch' | null;
}

function resolveDestination(
  event: CaptureEvent,
  destinationsByLinkId: ReadonlyMap<string, LinkDestinationLookup>,
): ResolvedEvent {
  const resolved = destinationsByLinkId.get(event.link_id);

  if (resolved === undefined) {
    return { event, destination: null, reason: 'not-found' };
  }
  if (resolved.tenantId !== event.tenant_id) {
    return { event, destination: null, reason: 'tenant-mismatch' };
  }
  return { event, destination: resolved.destination, reason: null };
}

/**
 * Logs ONE batch-level summary line — never per event, which would be
 * noise at 100 events/flush — and only when at least one event in the
 * batch actually failed to resolve a destination. An all-resolved flush
 * (the common case) logs nothing: an `error()` line on every single
 * healthy flush would itself become the noise this function exists to
 * avoid.
 *
 * `not-found` and `tenant-mismatch` are counted separately rather than
 * folded into one number: a deleted link racing a flush is ordinary
 * operation, but a tenant mismatch means a CaptureEvent's `tenant_id`/
 * `link_id` pairing didn't match Postgres at all — a much stronger
 * signal that something upstream is actually wrong, worth an operator
 * being able to tell apart from routine link churn at a glance.
 */
function logUnresolvedDestinations(
  logger: FlushBatchLogger,
  resolutions: readonly ResolvedEvent[],
  distinctLinkIdCount: number,
): void {
  const notFoundCount = resolutions.filter((r) => r.reason === 'not-found').length;
  const tenantMismatchCount = resolutions.filter((r) => r.reason === 'tenant-mismatch').length;
  const unresolvedCount = notFoundCount + tenantMismatchCount;

  if (unresolvedCount === 0) return;

  logger.error(
    `flushBatch: ${unresolvedCount} of ${resolutions.length} event(s) in this batch did not resolve a ` +
      `destination (${notFoundCount} link_id not found, ${tenantMismatchCount} tenant mismatch) — dest_host ` +
      'stays null for these rows, nothing else in the row is affected.',
    {
      batchSize: resolutions.length,
      distinctLinkIdCount,
      unresolvedCount,
      notFoundCount,
      tenantMismatchCount,
    },
  );
}

/** The `flushBatch(events)` shape this file builds — also exactly the
 * shape apps/worker/src/batch/accumulator.ts's `BatchFlushCallback<T>`
 * expects as its `flush` option (a function taking FEWER parameters
 * than a callback type declares is still structurally assignable to
 * it — TypeScript never requires this function to accept the extra
 * `batchId` argument a caller wiring it into `BatchAccumulator` would
 * pass). That wiring is a later task, not this one. */
export type FlushBatch = (events: readonly CaptureEvent[]) => Promise<void>;

export interface CreateFlushBatchOptions {
  readonly db: DbClient['db'];
  /** Defaults to {@link consoleErrorLogger} when omitted — same
   * optional-with-a-console-default shape `BatchAccumulatorOptions`
   * (accumulator.ts) already uses for its own `logger` field. */
  readonly logger?: FlushBatchLogger;
}

/**
 * Builds a `flushBatch(events)` closure bound to `db` (and, optionally,
 * a `logger` for the unresolved-destination summary — see this file's
 * own header). `db` is typed as `DbClient['db']` (an indexed-access type
 * off `@posta/core`'s own `DbClient` interface), not `NodePgDatabase`
 * written out directly — apps/worker never imports drizzle-orm itself,
 * matching apps/api/src/redirect/resolve-link.ts's identical precedent
 * (it only ever imports `DbClient`'s TYPE plus this package's own query
 * functions). Drizzle stays an implementation detail of packages/core;
 * `resolveDestinationsByLinkIds` and `insertEventsBatch` are the two
 * calls that actually touch it.
 *
 * A redirect never blocks on analytics (invariant 1) is untouched here
 * on purpose — that invariant governs the HOT PATH (apps/api's redirect
 * controller), not the worker's own batch write, which runs entirely
 * off that path, downstream of the BullMQ queue.
 */
export function createFlushBatch(options: CreateFlushBatchOptions): FlushBatch {
  const { db, logger = consoleErrorLogger } = options;

  return async function flushBatch(events: readonly CaptureEvent[]): Promise<void> {
    if (events.length === 0) return;

    const linkIds = [...new Set(events.map((event) => event.link_id))];
    const destinationsByLinkId = await resolveDestinationsByLinkIds(db, linkIds);

    const resolutions = events.map((event) => resolveDestination(event, destinationsByLinkId));
    logUnresolvedDestinations(logger, resolutions, linkIds.length);

    const rows: NewEvent[] = resolutions.map(({ event, destination }) =>
      toNewEventRow(toLoggedEvent(event, destination)),
    );

    await insertEventsBatch(db, rows);
  };
}
