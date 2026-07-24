-- T1.2.6 — pairs with 001_events.sql. Dropping `events` drops every one
-- of its partitions along with it, so this refuses to run when the
-- table has rows unless the runner explicitly passes --force (T1.2.6's
-- downSqlMigration sets the posta.force_migration_down setting via
-- set_config() before running this file) — an accidental rollback in
-- staging should be loud, not clean.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM events LIMIT 1)
     AND coalesce(current_setting('posta.force_migration_down', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'Refusing to drop events: table has rows. Pass --force to override.';
  END IF;
END $$;

DROP TABLE events;
