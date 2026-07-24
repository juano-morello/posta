-- T1.2.6 — pairs with 002_events_indexes.sql. Dropping `events` itself
-- (001_events.down.sql) would take these with it regardless, but down()
-- is called per-file, not implicitly cascading, so this file exists
-- independently.
DROP INDEX IF EXISTS events_tenant_link_occurred_at_idx;
DROP INDEX IF EXISTS events_tenant_occurred_at_idx;
