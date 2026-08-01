-- T4.2.3 — posta_worker: the writer role apps/worker will authenticate as
-- once DATABASE_URL_WORKER (apps/worker/src/env.ts, T0.3.6) is wired to it
-- (today it still points at the migration-owner role, same
-- privilege-separation-doesn't-exist-yet gap 007_roles_reader.sql's own
-- header notes for posta_app/DATABASE_URL). This is the mirror-image role
-- to posta_app: the worker's batch flush (apps/worker/src/batch/flush.ts)
-- INSERTs into raw `events`, and the replay CLI's reconciliation report
-- (apps/worker/src/cli/replay-report.ts) SELECTs from `events` to count
-- rows for its own row-count comparison — nothing else. Two separate
-- roles (posta_app read-only on the classified view, posta_worker
-- write-only on the raw table) is what lets posta_app be genuinely
-- powerless over raw `events` (007's own invariant-5 enforcement) without
-- breaking the pipeline that has to write those rows in the first place.
--
-- No grant of `events_classified` here: the worker enriches, it does not
-- judge (invariant 4) — it has no reason to ever read the classified
-- view, and granting it anyway would be an unused privilege sitting
-- around waiting to be misused. No grant of `asn_datacenter` either: the
-- classification view's own ASN join (006_events_classified.sql) runs as
-- the view's OWNER, never as the querying role (007's own header comment
-- explains the mechanism), and grep across apps/worker/src confirms the
-- worker never queries asn_datacenter directly — nothing there needs this
-- grant. No grant of any CRUD table (`user`, session, account,
-- verification, links, domains, bio_pages, bio_links) either: the worker
-- has no business touching any of them.
--
-- LOGIN, no password set here, same reasoning as 007_roles_reader.sql:
-- a raw SQL migration has no access to a secret store, so the password is
-- set out-of-band at deploy time (`ALTER ROLE posta_worker PASSWORD ...`
-- sourced from a Secret/env var), never a literal in this file. Postgres
-- has no `CREATE ROLE IF NOT EXISTS`, hence the pg_roles existence check
-- below (re-running this migration is a no-op either way, via
-- _posta_sql_migrations' checksum tracking — this guard is for a
-- hypothetical manual re-run, not the normal path).
--
-- No `GRANT USAGE ON SEQUENCE` needed: `events`' primary key is an
-- application-generated ULID (`event_id`, text), never a serial/identity
-- column (001_events.sql) — there is no sequence to grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'posta_worker') THEN
    CREATE ROLE posta_worker LOGIN;
  END IF;
END $$;

-- The entire control: INSERT for the batch flush, SELECT for replay's
-- reconciliation row-counting. Nothing else, on nothing else.
GRANT INSERT, SELECT ON events TO posta_worker;

-- No grant of any kind on events_classified, asn_datacenter, or any CRUD
-- table here — the absence IS this role's enforcement. Do not add one.
