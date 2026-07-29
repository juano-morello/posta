import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { events, type NewEvent } from '../schema/events';

// T3.3.2 [E3, S3.3][INV-8] — insertEventsBatch is the worker flush
// path's (apps/worker/src/batch/flush.ts) one write to `events` per
// batch: a single parameterised multi-row
// `INSERT INTO events (...) VALUES (...), (...), ...
// ON CONFLICT (event_id, occurred_at) DO NOTHING`. schema/events.ts's
// own header spells out this exact conflict target — the partitioned
// table's PRIMARY KEY (event_id, occurred_at), never declared as a
// `.primaryKey()` on the Drizzle table object itself (that file is a
// read-only mirror of hand-written SQL, not a second DDL source) — so
// this is the one call site that actually supplies it. Re-flushing the
// IDENTICAL batch a second time (a retry after a crash between the
// insert and the queue ack, for example) produces the SAME
// (event_id, occurred_at) pairs, hits the SAME conflict, and inserts
// zero new rows — that is invariant 8, proved directly by
// flush.test.ts's "same batch twice" assertion.
//
// Lives in packages/core, not apps/worker, for the same reason
// resolveLinkBySlug (./tenant.ts) does: apps/api and apps/worker never
// import drizzle-orm directly — see apps/api/src/redirect/resolve-link.ts,
// which only ever imports `DbClient`'s TYPE plus this package's own
// query functions. Drizzle stays an implementation detail of
// packages/core; every app calls a plain, already-typed function
// instead of building its own query.
//
// ONE `.values([...])` CALL FOR THE WHOLE BATCH, never looped per row —
// that is the literal source of the "not 100" property. Proving the
// underlying Postgres driver ALSO issues exactly one round trip for a
// 100-row array (not silently chunked) is flush.test.ts's own job, done
// by wrapping the testcontainers pool's `query()` method — this
// function's contract is only "one call in, one `.values()` call out".
export async function insertEventsBatch(db: NodePgDatabase, rows: readonly NewEvent[]): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insert(events)
    .values([...rows])
    .onConflictDoNothing({ target: [events.eventId, events.occurredAt] });
}

// T3.6.5 [E3, S3.6][INV-7][INV-8] — insertEventsBatchWithCounts exists
// SOLELY for replay's reconciliation report (apps/worker/src/cli/
// replay-report.ts). `insertEventsBatch` above stays untouched — same
// signature, same `Promise<void>` contract, same live flush-path call
// site (apps/worker/src/batch/flush.ts's `flushBatch`) — because that
// caller has never needed to distinguish "inserted" from "skipped by ON
// CONFLICT": flushBatch's own idempotency proof (flush.test.ts's "same
// batch twice" assertion) only cares that a re-flush inserts zero NEW
// rows, never how many were skipped for reporting purposes. Widening
// insertEventsBatch's own return type would force that call site (and
// every future one) to start handling a value it has no use for, for a
// need only replay/reporting tooling has — the same "add a new function
// rather than widen an existing production call site's contract"
// precedent T3.4.4 already set for `batchId` (optional-with-default,
// not a forced signature change on every caller).
//
// The ONLY difference from insertEventsBatch is a `RETURNING event_id`
// clause: Postgres's `ON CONFLICT ... DO NOTHING ... RETURNING` returns a
// row for every INPUT row that was actually inserted, and returns NO row
// for one that hit the conflict target and was skipped — so
// `insertedEventIds.length` is the batch's real insert count, and a
// caller can derive `skipped = rows.length - insertedEventIds.length`
// without this function needing to know or care what "skipped" means to
// its caller. Same ONE `.values([...])` call for the whole batch as
// insertEventsBatch (never looped per row) and the SAME conflict target
// — this is not a second, drifting INSERT implementation, it is the
// identical statement with one clause added; replay-driver.test.ts's own
// "no drifting INSERT implementation" scan (which this file is the one
// permitted owner of) is unaffected by adding a second call site WITHIN
// this same file — it only forbids a call site OUTSIDE it.
export async function insertEventsBatchWithCounts(
  db: NodePgDatabase,
  rows: readonly NewEvent[],
): Promise<{ readonly insertedEventIds: readonly string[] }> {
  if (rows.length === 0) return { insertedEventIds: [] };

  const inserted = await db
    .insert(events)
    .values([...rows])
    .onConflictDoNothing({ target: [events.eventId, events.occurredAt] })
    .returning({ eventId: events.eventId });

  return { insertedEventIds: inserted.map((row) => row.eventId) };
}
