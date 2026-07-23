import type { Pool } from 'pg';

// T1.3.3 — the SAME "current month plus N months ahead" policy as
// 005_bootstrap_partitions.sql's one-time bootstrap migration, expressed
// as a reusable function so T1.3.4's scheduled worker job (which runs
// this periodically, not once) and the bootstrap migration share ONE
// definition of "N months ahead" instead of two independently hardcoded
// loops that could silently drift apart.

/** "3 months ahead" — matches the bootstrap migration's own 0..3 loop. */
const DEFAULT_MONTHS_AHEAD = 3;

function monthStartDateString(year: number, monthIndexZeroBased: number): string {
  // A plain 'YYYY-MM-01' string, not a Date/timestamp handed to the pg
  // driver's own serialization — a bare `date` literal has no timezone
  // component at all, so there is no session-TimeZone ambiguity to get
  // wrong here (unlike timestamptz). monthIndexZeroBased may be >= 12
  // (e.g. 13 for "next January") — Date.UTC normalizes an overflowing
  // month index into the correct year/month automatically.
  const normalized = new Date(Date.UTC(year, monthIndexZeroBased, 1));
  const normalizedYear = normalized.getUTCFullYear();
  const month = String(normalized.getUTCMonth() + 1).padStart(2, '0');
  return `${normalizedYear}-${month}-01`;
}

/**
 * Ensures a monthly partition exists for the current month and every one
 * of the next `months` months (default 3 — matching
 * 005_bootstrap_partitions.sql), calling the create_events_partition SQL
 * function (T1.3.1) for each. Idempotent: create_events_partition itself
 * is a no-op for a month that already has a partition.
 */
export async function ensurePartitionsAhead(
  pool: Pool,
  months: number = DEFAULT_MONTHS_AHEAD,
): Promise<void> {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonthIndex = now.getUTCMonth();

  for (let offset = 0; offset <= months; offset += 1) {
    const monthDateString = monthStartDateString(currentYear, currentMonthIndex + offset);
    await pool.query('SELECT create_events_partition($1::date)', [monthDateString]);
  }
}

/**
 * T1.3.5 — the DEFAULT partition (T1.3.2) is a safety net, not a
 * legitimate destination: a non-zero row count here always means the
 * partition maintenance job (T1.3.4) failed to create a partition ahead
 * of need, and the row landed somewhere unqueried instead. `ONLY`
 * matters here for the same reason it does in EXPLAIN/count queries
 * elsewhere in this epic — events_default has no partitions of its own,
 * but being explicit keeps the query's intent (count exactly this
 * relation's own rows) unambiguous.
 */
export async function countDefaultPartitionRows(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ONLY events_default',
  );
  return Number(result.rows[0]?.count ?? '0');
}
