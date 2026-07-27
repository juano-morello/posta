// T3.4.3 (E3, S3.4) [INV-7] — the partitioned R2 object key scheme for the
// NDJSON batch writer (T3.4.2's serializeBatch(), whose output is the
// exact string a later task hands to createR2Client()'s (T3.4.1)
// PutObjectCommand as this key's Body).
//
// --- Why occurredAt is typed `string`, not `Date` ---------------------
//
// `CaptureEvent.occurred_at` (packages/contracts/src/capture.ts) is
// already an ISO-8601 string — a `Date` value does not survive a BullMQ
// round-trip through Redis intact, so every occurred_at this codebase
// carries end-to-end (capture → queue → LoggedEvent, ndjson.ts's own
// `LoggedEvent = CaptureEvent & EnrichmentResult`) is a string, never a
// `Date` instance. Accepting `string` here means a caller threading a real
// event's `occurred_at` straight into this function needs no intermediate
// `new Date(...)` of its own — it hands through the exact value it already
// has. `new Date(occurredAt)` below is this function's OWN parse step, not
// a burden pushed onto callers.
//
// --- Which event's occurred_at represents a whole BATCH? ---------------
//
// A batch (apps/worker/src/batch/accumulator.ts, T3.3.1) holds many
// events, each with its own `occurred_at`, but this function takes exactly
// ONE `occurredAt` value — deciding which event's timestamp represents the
// batch (most naturally the first event's, i.e. when the batch opened,
// matching BatchAccumulator's own "batch_id minted when the batch opens"
// framing) is the CALLER's job, not this function's. This function only
// turns whichever single timestamp it is given into a partition.
//
// --- Purity is the idempotency mechanism --------------------------------
//
// "Every retry of the same batch PUTs to the same key" requires this
// function to be a PURE, deterministic function of its two arguments only
// — no `Date.now()`, no bare `new Date()` (no-argument), no randomness
// anywhere below. `batchId` is threaded straight into the key rather than
// re-derived, so retrying a flush with the SAME already-minted batch_id
// (BatchAccumulator mints it once, before any flush attempt) always
// produces a byte-identical key regardless of how much wall-clock time has
// passed between attempts — an overwrite, never a duplicate object.

/** Zero-pads `value` to at least `length` digits — used for the calendar
 * fields below where a single digit (month 1-9, day 1-9, hour 0-9) must
 * still occupy two characters in the key (`hour=05`, never `hour=5`). */
function zeroPad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * Builds the partitioned R2 key a batch's NDJSON body is written to:
 * `events/dt=YYYY-MM-DD/hour=HH/<batchId>.ndjson`.
 *
 * Partitions by `occurredAt`'s UTC instant, ALWAYS — never by a naive
 * slice of the input string's own date/hour digits, and never by any
 * local-timezone reading of it. This is the one property that actually
 * matters here: a São Paulo (`-03:00`) timestamp taken shortly before
 * local midnight is already the next calendar day in UTC (e.g.
 * `2026-07-20T23:45:00-03:00` is `2026-07-21T02:45:00Z` — a DIFFERENT UTC
 * date AND hour than a string-slice of the input's own digits would
 * produce). Every timezone this product ever serves has visitors near
 * local midnight every single day, so getting this wrong silently
 * misfiles a predictable slice of every day's events, corrupting the
 * replay/rebuild story invariant 7 depends on. `new Date(occurredAt)`'s
 * own `getUTC*()` accessors do this conversion correctly; nothing in this
 * function ever reads a local-timezone accessor (`getMonth()`,
 * `getHours()`, ...) or slices the input string directly.
 *
 * Throws if `occurredAt` does not parse to a valid instant — emitting a
 * key containing the literal string "NaN" (what an unguarded
 * `Number.isNaN`-unchecked `Date` would produce) would silently misfile
 * the batch into an unrecoverable, unpartitionable object instead of
 * failing loudly at the point the bad input was introduced.
 *
 * Does not validate `batchId`'s shape (e.g. that it is a well-formed
 * ULID) — minting and validating it is `newId()`'s (packages/core/src/
 * ulid.ts) and BatchAccumulator's own concern; this function only needs
 * an opaque, already-trusted string to key the object with.
 */
export function eventBatchKey(batchId: string, occurredAt: string): string {
  const parsed = new Date(occurredAt);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`eventBatchKey: occurredAt is not a valid ISO-8601 timestamp: "${occurredAt}"`);
  }

  const year = parsed.getUTCFullYear();
  const month = zeroPad(parsed.getUTCMonth() + 1, 2);
  const day = zeroPad(parsed.getUTCDate(), 2);
  const hour = zeroPad(parsed.getUTCHours(), 2);

  return `events/dt=${year}-${month}-${day}/hour=${hour}/${batchId}.ndjson`;
}
