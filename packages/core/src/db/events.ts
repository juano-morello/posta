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
