import { paginateListObjectsV2, type S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { CaptureEventSchema } from '@posta/contracts';
import {
  insertEventsBatchWithCounts,
  streamEventLog,
  type DbClient,
  type NewEvent,
} from '@posta/core';
import { toNewEventRow } from '../batch/flush';
import { DEFAULT_REPLAY_BATCH_SIZE } from './replay-driver';

// T3.6.5 (E3, S3.6) [INV-7][INV-8] — replay's own reconciliation report:
// periodic progress to stderr while a replay runs, and a final report on
// stdout an operator can trust — objects read, records parsed, rows
// inserted, rows skipped as already-present, and rows rejected with
// reasons. `inserted + skipped = parsed` is asserted before this module
// hands back an exit code — a rebuild that quietly lost rows is a worse
// failure than one that stopped and said so.
//
// --- Scope: a NEW, self-contained module, not yet wired into replay.ts -
//
// This task's own file list names only replay-report.ts/.test.ts, and
// T3.6.3's own `ReplaySummary` docstring (replay-driver.ts) already
// flags this exact distinction ("inserted vs. skipped-as-already-present
// … that distinction is explicitly T3.6.5's task, not this one's") as
// deliberately NOT this module's job to retrofit onto `replayEventLog`.
// `replayWithReport` below is therefore its OWN read/batch/insert loop —
// composed from the SAME primitives replay-driver.ts uses
// (`streamEventLog`, `toNewEventRow`), never a parallel reimplementation
// of either — plus the record-level validation and counting neither
// `replayEventLog` nor `insertEventsBatch` do today. `posta replay`
// (replay.ts) composing this module in instead of `replayEventLog` is a
// later task's decision, not this one's — see this task's own final
// report for why the scope stayed here.
//
// --- Why a NEW `insertEventsBatchWithCounts`, not a widened
// `insertEventsBatch` -----------------------------------------------
//
// `insertEventsBatch` (packages/core/src/db/events.ts) returns `void`
// and has no way to tell "inserted" apart from "skipped by ON CONFLICT
// DO NOTHING" — exactly the gap replay-driver.ts's own header names.
// Rather than widen that function's signature (which would force
// `flushBatch`, apps/worker/src/batch/flush.ts, the live production
// write path, to start handling a return value it has no use for),
// `insertEventsBatchWithCounts` is a NEW function in the SAME file, the
// one place a `.insert(events)...onConflictDoNothing(...)` call is
// permitted to live (replay-driver.test.ts's own "no drifting INSERT
// implementation" repo-wide scan enforces this) — identical statement,
// with a `RETURNING event_id` clause added, so `skipped = batch.length -
// insertedEventIds.length` per batch. `insertEventsBatch` itself keeps
// its exact pre-existing signature and behavior; the live flush path is
// untouched by this task.
//
// --- What "rejected" means here, and why it is NOT streamEventLog's job
//
// `streamEventLog` (packages/core/src/r2/ndjson.ts) already has a
// documented, deliberate contract for a genuinely corrupt NDJSON LINE:
// it throws, naming the key and line number, rather than silently
// skipping — "a partial replay that quietly drops records is a worse
// failure mode than a loud one that stops and names exactly where the
// corruption is" (that function's own docstring). This module does not
// change that: a truly unparseable line still aborts the whole run,
// unchanged. "Rejected" here means something narrower and only visible
// AFTER a line parses as valid JSON: a structurally-valid object that
// does not carry the fields `toNewEventRow`/Postgres require (a missing
// `tenant_id`, a non-ULID `event_id`, a non-ISO `occurred_at`, …) —
// exactly the "LoggedEvent/NewEvent shape that fails Zod validation"
// case this task's own brief names. `ReplayRecordSchema` below checks
// only the columns `events` declares NOT NULL (schema/events.ts) that
// this module can reach a Zod validator for — the five capture-time
// ones reuse CaptureEventSchema's OWN field validators (single source of
// truth for the ULID pattern / ISO-datetime check, no second regex to
// drift out of sync with it), plus the two enrichment-time NOT NULL
// columns (`source_platform`, `is_in_app`) CaptureEventSchema does not
// cover (they are not part of capture — see enrich.ts's own header).
// Deliberately NOT `.strict()`: every genuinely valid `LoggedEvent` also
// carries dest_host/browser/… — this schema only asserts the minimum
// insertable shape, it does not re-validate (or reject on) every column
// streamEventLog's own docstring already explains it deliberately does
// not re-validate either.
const ReplayRecordSchema = z.object({
  event_id: CaptureEventSchema.shape.event_id,
  occurred_at: CaptureEventSchema.shape.occurred_at,
  tenant_id: CaptureEventSchema.shape.tenant_id,
  link_id: CaptureEventSchema.shape.link_id,
  slug: CaptureEventSchema.shape.slug,
  source_platform: z.string().min(1),
  is_in_app: z.boolean(),
});

/** Joins every Zod issue into one human-readable reason string — the key
 * two genuinely-different-shaped bad records are bucketed SEPARATELY
 * under (`rejectionReasons` below groups by this exact string), while two
 * records failing the SAME check (e.g. both missing `tenant_id`) collapse
 * into one bucket with a count, matching "rows rejected with reasons"
 * (plural reasons, not one line per row). */
function describeRejection(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Counts R2 objects under `prefixes` via the AWS SDK's own
 * `paginateListObjectsV2` helper — NOT a hand-rolled ContinuationToken
 * loop mirroring `ndjson.ts`'s private `listObjectKeys`. This is a
 * deliberate, narrow duplication: `ndjson.ts`'s own object-body reading
 * (readline over a GetObjectCommand stream, one line at a time — the
 * genuinely intricate, invariant-carrying half of that file) is reused
 * unchanged via `streamEventLog` below; only the mechanical "how many
 * keys exist under this prefix" question is answered independently here,
 * because `streamEventLog`'s own yielded type (`LoggedEvent`, one per
 * record) carries no per-object boundary a caller could count against
 * without changing that generator's signature — out of this task's scope
 * (see this file's own header). Counted ONCE, before the record loop
 * starts: `streamEventLog` always reads every object under `prefixes` to
 * completion (it has no partial/filtered object-skipping), so this total
 * is accurate for the WHOLE run, not merely "as of when this ran". */
async function countObjectsUnderPrefixes(
  client: S3Client,
  bucket: string,
  prefixes: readonly string[],
): Promise<number> {
  let count = 0;

  for (const prefix of prefixes) {
    for await (const page of paginateListObjectsV2({ client }, { Bucket: bucket, Prefix: prefix })) {
      count += page.Contents?.length ?? 0;
    }
  }

  return count;
}

/** One rejection bucket: every record that failed {@link ReplayRecordSchema}
 * with the exact same {@link describeRejection} reason, counted once. */
export interface RejectionReasonCount {
  readonly reason: string;
  readonly count: number;
}

/** The raw counts a replay run accumulates — everything {@link
 * buildReplayReport} needs to compute the reconciliation verdict and
 * nothing it has to derive itself. Exported as its own type (rather than
 * inlined into {@link replayWithReport}) specifically so the
 * reconciliation arithmetic can be exercised directly, with fabricated
 * numbers, independent of a real replay run — see this module's own test
 * file's "forced mismatch" case, which proves the exit-code guard fires
 * without needing a real Postgres/R2 failure to actually produce one
 * (the real pipeline below can never organically produce a mismatch —
 * `rowsInserted`/`rowsSkipped` are derived by partitioning
 * `recordsParsed` batch by batch, so the identity holds by construction;
 * this assertion is a belt-and-suspenders guard against a future change
 * to that construction, not a condition today's code path can trigger). */
export interface ReplayCounts {
  readonly objectsRead: number;
  readonly recordsParsed: number;
  readonly rowsInserted: number;
  readonly rowsSkipped: number;
  readonly rejectionReasons: readonly RejectionReasonCount[];
}

/** The final reconciliation report — {@link ReplayCounts} plus the
 * derived `rowsRejected` total, the `reconciled` verdict, and the exit
 * code a CLI composing this module should surface. */
export interface ReplayReport extends ReplayCounts {
  readonly rowsRejected: number;
  /** `rowsInserted + rowsSkipped === recordsParsed`. `false` means replay
   * lost (or gained — an equally real bug) rows somewhere between parsing
   * and insertion; see this module's own header for why this can only
   * fire on a future regression, never on today's code path. */
  readonly reconciled: boolean;
  readonly exitCode: number;
}

export const EXIT_OK = 0;
/** Deliberately distinct from replay.ts's own EXIT_ARGS_ERROR (1) and
 * EXIT_RUNTIME_ERROR (2) — a future CLI composing this module needs to
 * tell "bad arguments" and "R2/Postgres unreachable" apart from "the
 * reconciliation arithmetic itself did not add up", which is a strictly
 * more specific, more alarming failure than either (see this file's own
 * header on why `inserted + skipped ≠ parsed` should never happen on
 * today's code path at all). */
export const EXIT_RECONCILIATION_MISMATCH = 3;

/** Pure — no I/O, no Date.now(). Computes the reconciliation verdict and
 * exit code from already-accumulated {@link ReplayCounts}. Exported
 * separately from {@link replayWithReport} so the exit-code guard is
 * directly testable against fabricated, deliberately-inconsistent counts
 * (see this file's own header on {@link ReplayCounts}). */
export function buildReplayReport(counts: ReplayCounts): ReplayReport {
  const rowsRejected = counts.rejectionReasons.reduce((sum, entry) => sum + entry.count, 0);
  const reconciled = counts.rowsInserted + counts.rowsSkipped === counts.recordsParsed;

  return {
    objectsRead: counts.objectsRead,
    recordsParsed: counts.recordsParsed,
    rowsInserted: counts.rowsInserted,
    rowsSkipped: counts.rowsSkipped,
    rejectionReasons: counts.rejectionReasons,
    rowsRejected,
    reconciled,
    exitCode: reconciled ? EXIT_OK : EXIT_RECONCILIATION_MISMATCH,
  };
}

/** One periodic stderr line — never the final report (that is stdout,
 * see {@link formatFinalReportLines}), so a caller piping stdout to a
 * report file never captures interim progress noise. */
function formatProgressLine(objectsRead: number, recordsParsed: number, elapsedMs: number): string {
  return `posta replay-report: progress — objects read: ${objectsRead}, records parsed: ${recordsParsed}, elapsed: ${elapsedMs}ms`;
}

/** The final report's own lines, stdout-bound — one metric per line plus
 * one line per distinct rejection reason (never one line per rejected
 * ROW, which would be unbounded noise for a genuinely bad range), ending
 * with the reconciliation verdict. Returns lines rather than a single
 * joined string so a caller (or a test) can assert against individual
 * lines without a brittle whole-block string match. */
function formatFinalReportLines(report: ReplayReport): string[] {
  const lines = [
    `posta replay-report: objects read: ${report.objectsRead}`,
    `posta replay-report: records parsed: ${report.recordsParsed}`,
    `posta replay-report: rows inserted: ${report.rowsInserted}`,
    `posta replay-report: rows skipped (already present): ${report.rowsSkipped}`,
    `posta replay-report: rows rejected: ${report.rowsRejected}`,
  ];

  for (const entry of report.rejectionReasons) {
    lines.push(`posta replay-report:   rejected (${entry.count}x): ${entry.reason}`);
  }

  lines.push(
    report.reconciled
      ? `posta replay-report: reconciliation OK — inserted (${report.rowsInserted}) + skipped (${report.rowsSkipped}) = parsed (${report.recordsParsed})`
      : `posta replay-report: RECONCILIATION MISMATCH — inserted (${report.rowsInserted}) + skipped (${report.rowsSkipped}) ≠ parsed (${report.recordsParsed}); replay exits non-zero rather than report a rebuild that may have silently lost rows`,
  );

  return lines;
}

/** Thrown by {@link replayWithReport} when `options.batchSize` exceeds
 * {@link MAX_BATCH_SIZE} — always names the offending value and the
 * limit, mirroring replay.ts's own `ReplayArgsError` message style for
 * the identical class of guard, and thrown before ANY R2 read or
 * Postgres write (see {@link MAX_BATCH_SIZE}'s own comment for why the
 * ceiling itself is a local, deliberately-duplicated constant rather
 * than an import from replay.ts). */
export class ReplayReportBatchSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayReportBatchSizeError';
  }
}

// [review round, database-reviewer finding] `batchSize` had NO runtime
// upper bound here, even though `ReplayReportOptions.batchSize`'s own doc
// comment (below) claimed it carried "the SAME 500-row ceiling" replay.ts's
// own `--batch-size` flag enforces on `ReplayCliOptions.batchSize` — that
// claim was true of the DEFAULT only, never of a caller-supplied value. A
// caller passing e.g. `batchSize: 50000` flowed straight into
// `insertEventsBatchWithCounts` (packages/core/src/db/events.ts) and
// produced a single INSERT with `50000 × 31 ≈ 1.55M` bind parameters,
// failing with an opaque Postgres "too many parameters" error instead of a
// clear, named rejection — exactly the class of failure replay.ts's own
// `MAX_BATCH_SIZE` (that file, ~line 107) already closed for its OWN
// `--batch-size` flag, for the identical reason (an operator override
// should never make a replay less safe, parameter-wise, than the live
// flush path already is).
//
// This constant is a DELIBERATE, DOCUMENTED duplicate of replay.ts's own
// `MAX_BATCH_SIZE`, not an import of it: this file's own header already
// establishes that `replay.ts` is expected to eventually compose
// `replayWithReport` IN ("posta replay (replay.ts) composing this module
// in instead of replayEventLog is a later task's decision, not this
// one's"), so the dependency direction runs replay.ts → replay-report.ts.
// Importing replay.ts's `MAX_BATCH_SIZE` from here would point that arrow
// the other way for one constant today, and risks a circular import the
// moment that later task lands. Same narrow-duplication discipline this
// file already applies to `countObjectsUnderPrefixes` above (see that
// function's own comment) — two numbers that must never drift apart, kept
// in sync by this comment rather than by a shared import.
const MAX_BATCH_SIZE = 500;

export interface ReplayReportOptions {
  readonly db: DbClient['db'];
  /** The already-constructed S3-compatible client (packages/core/src/r2/
   * client.ts's createR2Client) — built once by whoever wires this up,
   * same "construct once, close over deps" discipline replay-driver.ts's
   * own `ReplayDriverOptions` already follows. */
  readonly r2Client: S3Client;
  readonly r2Bucket: string;
  /** Typically `eventPrefixes(from, to)`'s own output (T3.6.1) — same
   * "takes prefixes, not a [from, to] range" contract replay-driver.ts's
   * own `ReplayDriverOptions.prefixes` already establishes. */
  readonly prefixes: readonly string[];
  /** Defaults to replay-driver.ts's own {@link DEFAULT_REPLAY_BATCH_SIZE}
   * (500). A value above this file's own {@link MAX_BATCH_SIZE} (also
   * 500) is rejected by {@link replayWithReport} with a {@link
   * ReplayReportBatchSizeError} BEFORE any R2 read or Postgres write —
   * the same runtime ceiling replay.ts's own `--batch-size` flag enforces
   * on `ReplayCliOptions.batchSize` — so this module never issues a
   * larger single INSERT than either the live flush path or
   * `replayEventLog` ever does, regardless of what a caller passes in. */
  readonly batchSize?: number;
  /** Emit one progress line to `stderr` after every this-many successfully
   * parsed records (not raw objects read — see this file's own header on
   * why per-object progress ticks are out of scope). Defaults to
   * {@link DEFAULT_REPLAY_BATCH_SIZE} in production; tests override this
   * to a small number for deterministic, non-timing-dependent progress
   * assertions — a wall-clock interval would make "did a progress line
   * fire during this short test run" a coin flip. */
  readonly progressEveryRecords?: number;
  /** Defaults to `console.log`. Injectable so replay-report.test.ts can
   * capture output instead of asserting against real stdout — same
   * convention replay.ts's own `ReplayCliDeps` already establishes. */
  readonly stdout?: (line: string) => void;
  /** Defaults to `console.error`. Progress lines go here, never stdout —
   * see this file's own header. */
  readonly stderr?: (line: string) => void;
}

/**
 * Streams every `LoggedEvent` archived under `prefixes`, validates each
 * against {@link ReplayRecordSchema} (bucketing a failure as "rejected",
 * never inserting it), batches the rest through
 * `insertEventsBatchWithCounts` (packages/core/src/db/events.ts) to learn
 * "inserted" apart from "skipped by ON CONFLICT", emits periodic progress
 * to `stderr`, and prints the final reconciliation report to `stdout`
 * before returning it. Never calls `enrich()`, `resolveDestinationsByLinkIds`,
 * or `flushBatch` — see this file's own header for why re-resolving a
 * destination at replay time would silently rewrite history (invariant 7).
 */
export async function replayWithReport(options: ReplayReportOptions): Promise<ReplayReport> {
  const {
    db,
    r2Client,
    r2Bucket,
    prefixes,
    batchSize = DEFAULT_REPLAY_BATCH_SIZE,
    progressEveryRecords = DEFAULT_REPLAY_BATCH_SIZE,
  } = options;

  // Guard FIRST, before anything below touches R2 or Postgres — see
  // MAX_BATCH_SIZE's own comment above for why 500 is a local constant
  // here rather than an import of replay.ts's identical one.
  if (batchSize > MAX_BATCH_SIZE) {
    throw new ReplayReportBatchSizeError(
      `posta replay-report: batchSize ${batchSize} exceeds the maximum of ${MAX_BATCH_SIZE} ` +
        "(matches replay.ts's own --batch-size ceiling — apps/worker/src/cli/replay.ts's " +
        'MAX_BATCH_SIZE) — refusing to run before any R2 read or Postgres write',
    );
  }

  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));

  const objectsRead = await countObjectsUnderPrefixes(r2Client, r2Bucket, prefixes);
  const startedAt = Date.now();

  let recordsParsed = 0;
  let rowsInserted = 0;
  let rowsSkipped = 0;
  let recordsSinceProgress = 0;
  const rejectionCounts = new Map<string, number>();
  let buffer: NewEvent[] = [];

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const { insertedEventIds } = await insertEventsBatchWithCounts(db, buffer);
    rowsInserted += insertedEventIds.length;
    rowsSkipped += buffer.length - insertedEventIds.length;
    buffer = [];
  };

  for await (const record of streamEventLog(r2Client, r2Bucket, prefixes)) {
    const validated = ReplayRecordSchema.safeParse(record);

    if (!validated.success) {
      const reason = describeRejection(validated.error);
      rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
      continue;
    }

    recordsParsed += 1;
    recordsSinceProgress += 1;
    buffer.push(toNewEventRow(record));

    if (buffer.length >= batchSize) {
      await flushBuffer();
    }

    if (recordsSinceProgress >= progressEveryRecords) {
      stderr(formatProgressLine(objectsRead, recordsParsed, Date.now() - startedAt));
      recordsSinceProgress = 0;
    }
  }

  await flushBuffer();

  const report = buildReplayReport({
    objectsRead,
    recordsParsed,
    rowsInserted,
    rowsSkipped,
    rejectionReasons: [...rejectionCounts.entries()].map(([reason, count]) => ({ reason, count })),
  });

  for (const line of formatFinalReportLines(report)) stdout(line);

  return report;
}
