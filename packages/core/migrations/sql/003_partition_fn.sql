-- T1.3.1 — create_events_partition(month) computes date_trunc('month',
-- p_month) and the following month as EXPLICIT UTC bounds, and runs
-- CREATE TABLE IF NOT EXISTS events_YYYY_MM PARTITION OF events FOR
-- VALUES FROM (...) TO (...). Indexes are inherited from the parent
-- (002_events_indexes.sql / T1.2.3) — this function deliberately creates
-- none, or every insert would pay double the write cost of maintaining a
-- second copy per partition. Calling it twice for the same month is a
-- no-op via IF NOT EXISTS.
--
-- Bounds are constructed as literal strings with an explicit '+00'
-- offset (never a bare `date` value, which Postgres would otherwise
-- interpret at midnight in the CURRENT SESSION's TimeZone before
-- converting to UTC for storage) — this is what makes the partition
-- boundary genuinely UTC regardless of whatever TimeZone happens to be
-- active in the session that calls this function.
CREATE OR REPLACE FUNCTION create_events_partition(p_month date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_partition_name text := 'events_' || to_char(v_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
    v_partition_name,
    (to_char(v_start, 'YYYY-MM-DD') || ' 00:00:00+00')::timestamptz,
    (to_char(v_end, 'YYYY-MM-DD') || ' 00:00:00+00')::timestamptz
  );
END;
$$;
