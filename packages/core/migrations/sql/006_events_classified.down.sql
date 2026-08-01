-- T4.1.1 — pairs with 006_events_classified.sql. A view holds no data of
-- its own, so there is no "refuse while it has rows" guard like
-- 001_events.down.sql's — dropping and recreating it is always safe.
DROP VIEW IF EXISTS events_classified;
