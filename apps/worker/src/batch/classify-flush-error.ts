// T3.7.2 [E3, S3.7] — the classification `retryWithSplit` (split-retry.ts)
// consults, once per sub-batch, BEFORE deciding whether to split it or
// declare it poison. Splitting assumes a failure belongs to a row — true
// for a single bad value, false for a Postgres OUTAGE, which fails every
// sub-batch identically and, left unclassified, would binary-search all
// the way down and declare EVERY event in the batch poison: a recoverable
// outage converted into a mass dead-letter. `classifyFlushError` exists to
// tell those two cases apart before `attemptBatch` acts on either.
//
// A CLOSED ALLOWLIST, NOT AN OPEN ONE — `'row-fault'` is returned for
// EXACTLY two Postgres SQLSTATE classes: 22 (data exception — a value
// that does not fit its column, e.g. `22003` integer out of range,
// `22021` invalid byte sequence) and 23 (integrity constraint violation,
// e.g. `23505` unique violation). Both are properties of the OFFENDING
// ROW, which is exactly what makes binary search a sound way to isolate
// them: remove that one row and the rest of the batch commits fine.
// EVERYTHING else classifies `'infrastructure'` — and that "everything
// else" is the load-bearing half of this function, not an afterthought:
//   - Class 42 (syntax/access rule violation — `42703` undefined column,
//     `42501` insufficient privilege) is a property of the STATEMENT, not
//     any one row. No binary search can isolate a missing column or a
//     lost INSERT grant; a row-fault verdict here would split every
//     sub-batch to singletons and dead-letter the entire batch. `42501`
//     is not hypothetical: a rolling deploy where the worker starts
//     before its migration finishes raises it on every INSERT.
//   - Classes 08/53/57/58 (connection exception, insufficient resources,
//     operator intervention, system error — e.g. `08006`, `08003`,
//     `57P03`, `53100`) are transport/server failures, never a row's
//     fault.
//   - Class 40 (transaction rollback — `40001` serialization failure,
//     `40P01` deadlock_detected) is transient contention, not a row
//     property either.
//   - An unrecognised SQLSTATE, and an error carrying NO SQLSTATE at all
//     (a bare `Error`, or a Node system-error like `ECONNREFUSED` — a
//     NODE system-error CODE, not a SQLSTATE, and the actual shape `pg`
//     rejects with when the server is unreachable).
// Enumerating "infrastructure" instead of allowlisting "row-fault" would
// leave every class nobody thought of (25, 55, XX, ...) falling through to
// `'row-fault'` by omission — the exact mass-dead-letter bug this module
// exists to prevent, just arrived at a different way. Deny-by-default,
// not a SQLSTATE-prefix lookup that happens to miss.
//
// PARSES NOTHING BEYOND `.code` — this module reads one duck-typed string
// property off a (possibly nested) `Error`, never an `instanceof` check
// against `pg`'s or drizzle's own error classes, and inspects no other
// property of any Postgres error shape.

/** What a flush failure classifies as, once `retryWithSplit`
 * (split-retry.ts) has exhausted a sub-batch's retry budget. `'row-fault'`
 * proceeds through the pre-existing split-or-poison path; `'infrastructure'`
 * makes that caller reject instead — see this file's own header. */
export type FlushErrorClassification = 'row-fault' | 'infrastructure';

/** Only these two SQLSTATE classes genuinely belong to one row — see this
 * file's own header for why every other class, including ones not
 * enumerated here, must fall through to `'infrastructure'` instead. */
const ROW_FAULT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(['22', '23']);

/** Bounds `extractSqlState`'s `Error.cause` walk so an accidental `cause`
 * cycle cannot loop forever. */
const MAX_CAUSE_DEPTH = 5;

/** [T3.7.2, moved from dlq.service.ts — never copied, both callers need
 * the identical walk] Reads the SQLSTATE off `error`'s own `.code`
 * property, or the first `.code` found by walking a BOUNDED chain of
 * standard `Error.prototype.cause` links — `pg`'s `DatabaseError` sets
 * `.code` to the real 5-character SQLSTATE directly, but the error a real
 * `flushBatch` (apps/worker/src/batch/flush.ts) rejects with is
 * drizzle-orm's own `DrizzleQueryError`, which wraps the ORIGINAL `pg`
 * error via the standard ES2022 `cause` chain rather than copying `.code`
 * onto itself (verified against the installed drizzle-orm@0.45.2 source,
 * `errors.cjs`'s `DrizzleQueryError` constructor: `this.cause = cause`).
 * A plain structural `.code` check, not an `instanceof` against `pg`'s or
 * drizzle's own error classes: this module has no dependency on either
 * (it is transport-agnostic, see this file's own header), and duck-typing
 * one property at each link costs nothing an import would buy here.
 * Bounded at {@link MAX_CAUSE_DEPTH} links so an accidental `cause` cycle
 * cannot loop forever. Any error whose whole chain has no string `.code`
 * (a plain `Error`, a `ZodError`, ...) yields `null`. Also the function
 * that surfaces a NODE system-error code (e.g. `ECONNREFUSED`, which
 * lives at the identical `.code` property on Node's own connection-
 * refused errors) — this walk does not, and cannot, tell a genuine
 * 5-character SQLSTATE apart from one; `classifyFlushError` (below) is
 * what tells them apart, by allowlisting the two classes that are
 * genuinely SQLSTATEs belonging to a row. */
export function extractSqlState(error: Error): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
}

/**
 * Classifies a flush failure as {@link FlushErrorClassification} — see
 * this file's own header for the full closed-allowlist rationale. A
 * non-`Error` rejection, an `Error` whose whole `cause` chain carries no
 * string `.code` at all, and an `Error` whose `.code` is a SQLSTATE
 * outside classes 22/23 (including a Node system-error code like
 * `ECONNREFUSED`, which is not a SQLSTATE at all) all classify
 * `'infrastructure'` — only classes 22 and 23 classify `'row-fault'`.
 */
export function classifyFlushError(error: unknown): FlushErrorClassification {
  if (!(error instanceof Error)) return 'infrastructure';

  const sqlstate = extractSqlState(error);
  if (sqlstate === null) return 'infrastructure';

  const sqlstateClass = sqlstate.slice(0, 2);
  return ROW_FAULT_SQLSTATE_CLASSES.has(sqlstateClass) ? 'row-fault' : 'infrastructure';
}
