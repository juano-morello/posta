-- T1.2.2 — the append-only, monthly-partitioned event log. Hand-written
-- because drizzle-kit cannot emit `PARTITION BY` (packages/core/drizzle.config.ts
-- excludes schema/events.ts from its glob for this exact reason). Applied
-- by T1.2.1's runSqlMigrations, tracked in _posta_sql_migrations.
--
-- NO ip column [INV-6], NO classification/verdict column [INV-4] — their
-- absence IS the enforcement mechanism; see events-forbidden-columns.test.ts
-- (T1.2.5). PRIMARY KEY (event_id, occurred_at) includes the partition
-- key, which is also exactly what `ON CONFLICT (event_id, occurred_at)`
-- needs [INV-8]. Capture signals are nullable — the absence of a header
-- is itself signal, not missing data. Enrichment columns are nullable and
-- written by the worker, never at capture time.
--
-- Matches spec §8 (docs/superpowers/specs/2026-07-21-posta-design.md)
-- verbatim.
CREATE TABLE events (
  event_id        text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  tenant_id       text        NOT NULL,
  link_id         text        NOT NULL,
  slug            text        NOT NULL,
  visitor_hash    text,
  http_method     text,
  user_agent      text,
  referer         text,
  accept          text,
  accept_language text,
  sec_fetch_site  text,  sec_fetch_mode     text,
  sec_fetch_dest  text,  sec_fetch_user     text,
  sec_purpose     text,
  sec_ch_ua       text,  sec_ch_ua_mobile   text,  sec_ch_ua_platform text,
  purpose         text,  x_purpose          text,  x_moz              text,
  country         text,  asn                integer,
  -- enrichment, written by the worker
  browser text, browser_version text, os text, device_type text,
  source_platform text, is_in_app boolean, dest_host text,
  PRIMARY KEY (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);
