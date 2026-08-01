import type { S3Client } from '@aws-sdk/client-s3';
import {
  insertEventsBatch,
  streamEventLog,
  type DbClient,
  type LoggedEvent,
  type NewEvent,
} from '@posta/core';
import { toNewEventRow } from '../batch/flush';

// T3.6.3 (E3, S3.6) [INV-7][INV-8] — "replay feeds records through the
// live insert path." This is the driver half of replay: given the
// prefixes T3.6.1's eventPrefixes() computes for a range, it streams
// every archived record (T3.6.2's streamEventLog), maps each one onto the
// Drizzle insert shape, and writes it through the SAME
// `INSERT ... ON CONFLICT (event_id, occurred_at) DO NOTHING` the live
// path uses (T3.3.2's insertEventsBatch, packages/core/src/db/events.ts)
// — never a second, drifting implementation of either the column mapping
// or the INSERT itself.
//
// --- Why this reuses toNewEventRow AND insertEventsBatch, but NEVER
// flushBatch -------------------------------------------------------
//
// The plan's own prose (docs/plan/03-event-pipeline.md, T3.6.3) says
// replay should call "the SAME flushBatch from T3.3.2 (Postgres side
// only)". That is not what this file does, on purpose, per an explicit,
// already-made design decision (recorded in
// docs/plan/IMPLEMENTATION-NOTES.md's T3.3.2 entry, and in
// packages/core/src/r2/ndjson.ts's own header on streamEventLog):
// `flushBatch` ALSO calls `resolveDestinationsByLinkIds()` and `enrich()`
// to resolve each event's destination as it stands RIGHT NOW — exactly
// right for the live path (a link's destination legitimately changes
// between capture and a 2-second flush window, invariant 3 is why), and
// exactly wrong for replay, where "right now" could be months after the
// event was ever captured. Calling flushBatch on a stream of
// months-old LoggedEvents would silently rewrite `dest_host` (and every
// other enrichment column) to whatever the link resolves to TODAY,
// which is precisely the failure invariant 7 ("R2 is the source of
// truth; Postgres is a rebuildable projection") forbids: a projection
// that resolves differently on rebuild than it did on first write is not
// a projection of the same log.
//
// `LoggedEvent` (packages/core/src/r2/ndjson.ts, T3.4.2) — exactly what
// `streamEventLog` yields back off an archived NDJSON line — is ALREADY
// the merged `CaptureEvent & EnrichmentResult` shape, `dest_host` and all,
// read verbatim off the line it was written to. `toNewEventRow`
// (apps/worker/src/batch/flush.ts, exported for this file, T3.6.3) maps
// that shape onto `NewEvent` by name, one property per column — the exact
// same mapping the live path uses, so there is no second, drifting copy
// of the 31-column mapping to keep in sync. `insertEventsBatch`
// (packages/core/src/db/events.ts) is the one call site anywhere in this
// codebase that constructs `.insert(events)...onConflictDoNothing(...)` —
// see replay-driver.test.ts's own "no drifting INSERT implementation"
// describe block, which scans the whole repo for a second one and finds
// none. Composing these two — never flushBatch, never enrich(), never
// resolveDestinationsByLinkIds — is what "identical to live by
// construction" and "a parallel restore implementation drifts... and you
// find out on the day you need it" actually resolve to, given the
// destination-resolution constraint above.
//
// --- Batching -------------------------------------------------------
//
// `streamEventLog` is memory-bounded by construction (T3.6.2's own
// header: O(1) in the range size). This function preserves that:
// `buffer` never holds more than `batchSize` rows before a flush, so
// replaying a year-wide range is still bounded by `batchSize`, not by
// the range. `DEFAULT_REPLAY_BATCH_SIZE` (500) mirrors
// `EVENT_BATCH_SIZE`'s own production ceiling (apps/worker/src/env.ts's
// Zod schema, `.max(500)`) — the same upper bound the live path already
// respects for Postgres's bind-parameter limit (31 columns x 500 rows =
// 15,500 parameters per statement, comfortably under Postgres's ~65,535
// ceiling), so replay never issues a larger single INSERT than the live
// path ever does. `batchSize` is still caller-overridable (T3.6.4's CLI
// can expose it, and this suite's own tests use a much smaller value to
// prove batching happens at all without needing thousands of fixture
// rows).
export const DEFAULT_REPLAY_BATCH_SIZE = 500;

export interface ReplayDriverOptions {
  readonly db: DbClient['db'];
  /** The already-constructed S3-compatible client (packages/core/src/r2/
   * client.ts's createR2Client, T3.4.1) — built once by whoever wires up
   * the eventual CLI (T3.6.4), never here. */
  readonly r2Client: S3Client;
  readonly r2Bucket: string;
  /** Typically `eventPrefixes(from, to)`'s own output (T3.6.1) — this
   * function takes prefixes directly, not a `[from, to]` range itself, so
   * it stays a thin, easily-testable consumer of streamEventLog with no
   * date-parsing of its own; a future CLI (T3.6.4) owns turning operator
   * flags into a `[from, to]` range and then into prefixes. */
  readonly prefixes: readonly string[];
  /** Defaults to {@link DEFAULT_REPLAY_BATCH_SIZE} — see this file's own
   * header for why 500 specifically. */
  readonly batchSize?: number;
  /** [T3.6.4] Optional predicate applied to every streamed record BEFORE
   * it is buffered/inserted — `false` means "read, but never written".
   * This driver stays deliberately generic about WHY a caller filters
   * (it has no `tenantId` concept of its own): T3.6.4's CLI is the one
   * real caller, and passes `(record) => record.tenant_id === tenantId`
   * for its own `--tenant` flag. Rejected records still count toward
   * `recordsRead` below — this driver's own `ReplaySummary` header
   * already documents `recordsRead` as "every record streamEventLog
   * yielded... NOT scoped to any one tenant", and adding an optional
   * filter does not change that meaning, only which records make it past
   * the point `recordsRead` is incremented at. Omitted (the common case:
   * no CLI `--tenant` flag) means every streamed record is buffered,
   * identical to this driver's pre-T3.6.4 behavior. */
  readonly filter?: (record: LoggedEvent) => boolean;
}

/** What this driver itself observed for one run — `recordsRead` counts
 * every record `streamEventLog` yielded under the given prefixes (NOT
 * scoped to any one tenant — this driver applies no tenant filter, that
 * is T3.6.4's job), `batchesWritten` counts how many `insertEventsBatch`
 * calls actually ran (i.e. how many non-empty batches were flushed). This
 * is deliberately NOT the full reconciliation report T3.6.5 builds
 * (objects read, rows inserted vs. skipped-as-already-present, rows
 * rejected with reasons) — `insertEventsBatch`'s own `ON CONFLICT DO
 * NOTHING` gives this driver no way to distinguish "inserted" from
 * "skipped, already present" without a `RETURNING` clause neither this
 * function nor `insertEventsBatch` adds; that distinction is explicitly
 * T3.6.5's task, not this one's. */
export interface ReplaySummary {
  readonly recordsRead: number;
  readonly batchesWritten: number;
}

/**
 * Streams every `LoggedEvent` archived under `prefixes` and writes it
 * through the live path's own column mapping and INSERT — see this
 * file's own header for the full "why toNewEventRow + insertEventsBatch,
 * never flushBatch/enrich()/resolveDestinationsByLinkIds" reasoning.
 * Never materializes the whole range in memory: at most `batchSize` rows
 * are buffered at any moment, matching `streamEventLog`'s own O(1)
 * discipline.
 */
export async function replayEventLog(options: ReplayDriverOptions): Promise<ReplaySummary> {
  const { db, r2Client, r2Bucket, prefixes, batchSize = DEFAULT_REPLAY_BATCH_SIZE, filter } = options;

  let recordsRead = 0;
  let batchesWritten = 0;
  let buffer: NewEvent[] = [];

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) return;
    await insertEventsBatch(db, buffer);
    batchesWritten += 1;
    buffer = [];
  };

  for await (const logged of streamEventLog(r2Client, r2Bucket, prefixes)) {
    recordsRead += 1;
    if (filter && !filter(logged)) continue;
    buffer.push(toNewEventRow(logged));

    if (buffer.length >= batchSize) {
      await flushBuffer();
    }
  }

  await flushBuffer();

  return { recordsRead, batchesWritten };
}
