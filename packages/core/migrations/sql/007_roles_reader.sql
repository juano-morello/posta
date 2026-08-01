-- T4.2.2 — posta_app: the reader role apps/api will authenticate as once
-- T4.2.4 wires DATABASE_URL to it (see .env.example's own note: today
-- DATABASE_URL and DATABASE_URL_WORKER both point at the migration-owner
-- role — "the privilege separation doesn't exist yet"). This migration is
-- the REAL enforcement of invariant 5 ("query the view, never raw
-- `events`") — T4.2.1's grep test only checks application source; this is
-- a database-enforced wall no query can route around.
--
-- The mechanism: Postgres checks a VIEW's access to its OWN base tables
-- as the VIEW's OWNER, never as the querying session's role. Whatever
-- role runs this migration (and 006_events_classified.sql before it) owns
-- `events_classified`, so posta_app can `SELECT * FROM events_classified`
-- fine with ZERO grant of its own on `events` — and the instant posta_app
-- tries `SELECT * FROM events` directly, Postgres raises 42501
-- (insufficient_privilege). See ../../src/db/roles.test.ts.
--
-- LOGIN, no password set here: a raw SQL migration has no access to a
-- secret store. The password is set out-of-band (T4.2.4's deploy step,
-- `ALTER ROLE posta_app PASSWORD ...` sourced from a Secret/env var) —
-- never a literal in this file. Postgres has no `CREATE ROLE IF NOT
-- EXISTS`, hence the pg_roles existence check below (re-running this
-- migration is a no-op either way, via _posta_sql_migrations' checksum
-- tracking — this guard is for a hypothetical manual re-run, not the
-- normal path).
--
-- No `GRANT USAGE ON SEQUENCE` needed: every table's primary key is an
-- application-generated ULID (`text`), never a serial/identity column
-- (schema/auth.ts's header comment) — even asn_datacenter.asn, an integer
-- PK, is a plain column, not a SERIAL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'posta_app') THEN
    CREATE ROLE posta_app LOGIN;
  END IF;
END $$;

-- The entire control: SELECT on the classified view, nothing on `events`.
GRANT SELECT ON events_classified TO posta_app;

-- Every normal CRUD table in the schema (packages/core/src/schema/) — full
-- read/write. Deliberately excludes `events` (raw) and
-- `_posta_sql_migrations` (migration bookkeeping, never queried by the app).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user", session, account, verification,
  links, domains, bio_pages, bio_links, asn_datacenter
TO posta_app;

-- No grant of any kind on `events` itself here — the absence IS invariant
-- 5's enforcement. Do not add one.
