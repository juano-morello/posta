-- T1.3.3 — bootstraps the FIRST set of monthly partitions on the very
-- first migrate: the current month plus the next three (4 total),
-- matching the "3 months ahead" policy T1.3.4's scheduled worker job
-- maintains going forward (packages/core/src/db/partitions.ts's
-- ensurePartitionsAhead(3) is the TypeScript expression of the same
-- policy, run periodically instead of once).
--
-- Computes date_trunc('month', now()) at MIGRATION-RUN time, never a
-- fixed date baked into this file — this migration only ever runs ONCE
-- (tracked by checksum in _posta_sql_migrations), so it has to be
-- correct whenever that one run happens to land: a fresh dev database
-- today, a fresh production database whenever it is first stood up.
DO $$
DECLARE
  i integer;
BEGIN
  FOR i IN 0..3 LOOP
    PERFORM create_events_partition(
      (date_trunc('month', now()) + (i || ' months')::interval)::date
    );
  END LOOP;
END $$;
