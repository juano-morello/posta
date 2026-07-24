-- T1.3.2 — the safety net. Without a DEFAULT partition, an insert whose
-- occurred_at falls outside every existing monthly partition (a gap in
-- the schedule, a clock skew, an out-of-range backfill) fails outright:
-- "inserts start failing at midnight on the 1st" the moment the next
-- month's partition doesn't exist yet. With one, the row lands here
-- instead — "inserts keep working and something beeps" (T1.3.5 wires the
-- beep: a non-empty events_default always means the maintenance job
-- failed). Created before T1.3.3's bootstrap runs, so there is never a
-- window where an out-of-range insert has nowhere to land.
CREATE TABLE events_default PARTITION OF events DEFAULT;
