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

/** Parses `value` as an ISO-8601 instant, throwing loudly — rather than
 * letting a `NaN`-poisoned `Date` silently produce a "NaN" key segment or a
 * wrong/partial range — if it does not parse to a valid instant. Shared by
 * `eventBatchKey` and `eventPrefixes` so both interpret "a valid ISO-8601
 * instant" identically; that shared interpretation is exactly what makes
 * the two functions genuine inverses of each other. */
function parseInstant(value: string, fnName: string, paramName: string): Date {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fnName}: ${paramName} is not a valid ISO-8601 timestamp: "${value}"`);
  }

  return parsed;
}

const HOURS_PER_DAY = 24;
const MS_PER_DAY = HOURS_PER_DAY * 60 * 60 * 1000;

// [review round 1, silent-failure-hunter finding] MAX_RANGE_DAYS bounds
// eventPrefixes()'s day-granularity walk below so an obvious operator typo
// in a `from`/`to` pair (wrong century, wrong year — e.g.
// `from='0001-01-01T00:00:00Z'`, `to='9999-12-31T00:00:00Z'`) fails LOUD
// with the actual span named, instead of silently allocating tens of
// millions of prefix strings and hanging. 3,660 UTC days is 10 calendar
// years (accounting for leap days: 10 * 366 = 3,660, the worst case):
// comfortably more than any single replay call this product would ever
// legitimately need (a replay CLI reprocesses a bounded window it names
// explicitly, not "the product's entire history" in one call), while a
// genuine typo that swaps a digit or a century overshoots it by orders of
// magnitude and gets caught here rather than downstream in an OOM or a
// multi-minute hang with no diagnosable cause.
const MAX_RANGE_DAYS = 3660;

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
  const parsed = parseInstant(occurredAt, 'eventBatchKey', 'occurredAt');

  const year = parsed.getUTCFullYear();
  const month = zeroPad(parsed.getUTCMonth() + 1, 2);
  const day = zeroPad(parsed.getUTCDate(), 2);
  const hour = zeroPad(parsed.getUTCHours(), 2);

  return `events/dt=${year}-${month}-${day}/hour=${hour}/${batchId}.ndjson`;
}

/**
 * T3.6.1 (E3, S3.6) [INV-7] — the exact inverse of `eventBatchKey`'s key
 * layout. Enumerates the `events/dt=YYYY-MM-DD/hour=HH/` partition
 * prefixes (the two-level directory prefix only — no filename, no
 * batchId) touched by the inclusive UTC range `[from, to]`. A replay tool
 * walks this list to know which R2 prefixes to LIST/GET when rebuilding
 * Postgres from the NDJSON log for a given window: if this file's key
 * LAYOUT (the `dt=.../hour=...` scheme) ever changes, this function must
 * change with it, and prefixes.test.ts's own cross-check against a real
 * `eventBatchKey` output is what turns a missed update into one loud
 * failing test instead of a replay tool that silently narrows and misses
 * real events.
 *
 * --- Why the range operates at UTC DAY granularity, not raw instant/hour -
 *
 * `from`/`to` accept arbitrary ISO-8601 instants — same convention as
 * `eventBatchKey`'s `occurredAt`, so a caller threading a real timestamp
 * through needs no rounding of its own — but the RANGE this function walks
 * is the whole UTC calendar days those instants fall on, not a narrower
 * per-hour slice. Two instants that land on the same UTC day, even the
 * exact same instant and even one nowhere near an hour boundary (e.g.
 * `eventPrefixes('2026-07-21T05:45:00Z', '2026-07-21T05:45:00Z')`), still
 * yield all 24 hours of that day — not 1, and not 0.
 *
 * This is deliberate. The alternative — intersecting each hour BUCKET
 * against `[from, to]` and only including buckets that genuinely overlap —
 * would make this function's output depend on the exact minute/second
 * `from`/`to` happen to carry, which is exactly the SILENT-NARROWING
 * failure mode this function exists to avoid: a `from`/`to` pair that
 * isn't perfectly hour-aligned would quietly drop the partial hours at
 * each end instead of covering them. Emitting the full day on both ends
 * means `eventPrefixes` only ever OVER-covers a range, never under-covers
 * it — for a replay tool, a few extra hours of a boundary day is a
 * correctness no-op (writes are idempotent, invariant 8); a missing real
 * hour is data loss. A consequence worth knowing: a range that crosses a
 * UTC day boundary by even one second emits prefixes for BOTH full days —
 * 48 prefixes, not the ~2 hours' worth actually spanned.
 *
 * The `from > to` validity check compares UTC CALENDAR DAYS, not raw
 * instants, to match this same day granularity: two same-day instants in
 * either time-of-day order are not an error, since they produce
 * byte-identical output either way (both truncate to the same day).
 *
 * Throws if `from` or `to` does not parse to a valid instant, if `from`
 * falls on a UTC calendar day after `to`, or if the resulting range spans
 * more than `MAX_RANGE_DAYS` days — a bound that exists to catch an
 * obvious operator typo (wrong century/year) before it allocates an
 * unbounded array and hangs; see `MAX_RANGE_DAYS`'s own comment above for
 * the arithmetic behind the number. Same "throw loudly rather than
 * silently produce a wrong/partial range" discipline as `eventBatchKey`.
 */
export function eventPrefixes(from: string, to: string): string[] {
  const fromParsed = parseInstant(from, 'eventPrefixes', 'from');
  const toParsed = parseInstant(to, 'eventPrefixes', 'to');

  const fromDayMs = Date.UTC(fromParsed.getUTCFullYear(), fromParsed.getUTCMonth(), fromParsed.getUTCDate());
  const toDayMs = Date.UTC(toParsed.getUTCFullYear(), toParsed.getUTCMonth(), toParsed.getUTCDate());

  if (fromDayMs > toDayMs) {
    throw new Error(`eventPrefixes: from ("${from}") falls on a UTC calendar day after to ("${to}")`);
  }

  const rangeDays = (toDayMs - fromDayMs) / MS_PER_DAY + 1;

  if (rangeDays > MAX_RANGE_DAYS) {
    throw new Error(
      `eventPrefixes: range from "${from}" to "${to}" spans ${rangeDays} UTC days, which exceeds the ${MAX_RANGE_DAYS}-day maximum (check for a typo in the year or century)`
    );
  }

  const prefixes: string[] = [];

  for (let dayMs = fromDayMs; dayMs <= toDayMs; dayMs += MS_PER_DAY) {
    const day = new Date(dayMs);
    const year = day.getUTCFullYear();
    const month = zeroPad(day.getUTCMonth() + 1, 2);
    const date = zeroPad(day.getUTCDate(), 2);

    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      prefixes.push(`events/dt=${year}-${month}-${date}/hour=${zeroPad(hour, 2)}/`);
    }
  }

  return prefixes;
}
