# E1 — Data model

**Milestone:** M1 · **Depends on:** E0 · **Unblocks:** E2

**Goal:** the schema that makes the invariants structurally impossible to violate — no `ip` column, no `classification` column, a primary key shaped for idempotent upserts.

**Done when:** migrations run clean from empty, the `events` table is partitioned by month with partitions provisioned ahead, and a schema test asserts the forbidden columns **do not exist**.

---

## S1.1 — Core tables

**As a** developer **I want** the non-event tables in Drizzle **so that** CRUD has somewhere to live.

Tables: `users` (Better Auth owns its own), `links`, `bio_pages`, `bio_links`, `domains`, `asn_datacenter`.

**Acceptance:**
- [ ] Drizzle schema in `packages/core/schema/`, migrations via `drizzle-kit`
- [ ] `links`: `UNIQUE (tenant_id, slug)` [INV-9] — per-tenant, not global
- [ ] Every tenant-owned table carries `tenant_id` and every query path is tenant-scoped from day one
- [ ] IDs are ULID, generated in application code, `text` columns
- [ ] `domains` table exists with a `type` column, unused in v1 — it is the v1.5 custom-domain seam, kept so v1.5 is not a migration
- [ ] `links.destination` validated as an absolute http(s) URL at the schema boundary
- [ ] Timestamps are `timestamptz`, never naive

**Tasks:**
- [ ] T1.1.1 `users` / auth table alignment with Better Auth's expected shape
- [ ] T1.1.2 `links` — id, tenant_id, slug, destination, title, created_at, updated_at, archived_at
- [ ] T1.1.3 `UNIQUE (tenant_id, slug)` + index on `(tenant_id, created_at DESC)`
- [ ] T1.1.4 `bio_pages` — tenant_id, handle, display_name, bio, avatar_url, theme_id
- [ ] T1.1.5 `bio_links` — bio_page_id, link_id, position (ordering) [INV: bio links reference existing links only]
- [ ] T1.1.6 `domains` with `type`, seeded empty
- [ ] T1.1.7 ULID helper in `packages/core`, exported type-safe
- [ ] T1.1.8 tenant-scoping test — a query without `tenant_id` fails review

> `bio_links` references `links.id` rather than storing a URL. That is what makes "every bio link is already tracked" true by construction instead of by discipline.

---

## S1.2 — The events table (manual SQL)

**As an** analyst **I want** an append-only partitioned event log of raw signals **so that** the verdict can be recomputed forever without a data rewrite.

`drizzle-kit` cannot emit `PARTITION BY`. This is a hand-written migration.

**Acceptance:**
- [ ] `events` created `PARTITION BY RANGE (occurred_at)`, monthly
- [ ] `PRIMARY KEY (event_id, occurred_at)` — partition key included, which is also exactly what `ON CONFLICT` needs [INV-8]
- [ ] **No `ip` column** [INV-6] · **No `classification`/`verdict` column** [INV-4]
- [ ] All §5.1 signal columns present, nullable (absence of a header is itself signal)
- [ ] Enrichment columns present but nullable — written by the worker, not at capture
- [ ] A schema test asserts `ip` and `classification` are absent — the test is the enforcement
- [ ] Per-partition indexes: `(tenant_id, link_id, occurred_at DESC)`, `(tenant_id, occurred_at DESC)`
- [ ] Drizzle has a **read-only** typed view of `events` so app code gets types without drizzle-kit owning the DDL

**Tasks:**
- [ ] T1.2.1 migration runner for hand-written SQL, ordered and idempotent, tracked in its own table
- [ ] T1.2.2 `CREATE TABLE events (...) PARTITION BY RANGE (occurred_at)` per spec §8
- [ ] T1.2.3 index strategy on the partition template
- [ ] T1.2.4 Drizzle read-only type mapping
- [ ] T1.2.5 forbidden-column test [INV-4][INV-6]
- [ ] T1.2.6 rollback script

> The absence of those two columns **is** the enforcement mechanism. A careless worker cannot store a verdict or an IP because there is nowhere to put one. Keep it that way — if a future story wants to "just cache the classification", that is invariant 5 dying quietly.

---

## S1.3 — Partition lifecycle

**As an** operator **I want** partitions created ahead of time **so that** inserts never fail at midnight on the 1st.

**Acceptance:**
- [ ] Function creating a month's partition + its indexes, idempotent
- [ ] Scheduled job maintaining **3 months ahead**
- [ ] A `DEFAULT` partition exists as a safety net, and its row count is alerted on — rows landing there mean the job failed
- [ ] Bootstrap creates current + next 3 on first migrate
- [ ] Test: insert dated 2 months out succeeds; insert with no matching partition lands in `DEFAULT` and raises the alert condition

**Tasks:**
- [ ] T1.3.1 `create_events_partition(month)` SQL function
- [ ] T1.3.2 bootstrap current + 3
- [ ] T1.3.3 scheduled maintenance job (worker cron)
- [ ] T1.3.4 `DEFAULT` partition + non-empty alert
- [ ] T1.3.5 partition boundary tests

> A `DEFAULT` partition turns "inserts start failing" into "inserts keep working and something beeps". Silent success in the wrong place beats loud data loss, but only if the beep is wired up.

---

## S1.4 — Datacenter ASN table

**As a** classifier **I want** datacenter ASNs in a table **so that** adding one is an insert, not a migration.

**Acceptance:**
- [ ] `asn_datacenter (asn integer PRIMARY KEY, name text, added_at timestamptz)`
- [ ] Seeded from a public datacenter/hosting ASN list (AWS, GCP, Azure, DigitalOcean, Hetzner, OVH, Linode, Vultr, Cloudflare, …)
- [ ] Seed is a re-runnable script with a documented source, not a hand-typed blob
- [ ] The view joins this table (E4) rather than hardcoding a list

**Tasks:**
- [ ] T1.4.1 table + migration
- [ ] T1.4.2 sourced seed script with provenance comment
- [ ] T1.4.3 idempotent re-seed
- [ ] T1.4.4 document the refresh procedure

---

## S1.5 — Migration tooling

**As a** developer **I want** one command for both migration flavors **so that** hand-written SQL is not second-class.

**Acceptance:**
- [ ] `pnpm migrate` runs drizzle-kit migrations **then** hand-written SQL, in a defined order
- [ ] Applied migrations tracked; re-running is a no-op
- [ ] `pnpm migrate:status` and `pnpm migrate:down` exist
- [ ] CI runs migrations from empty on every build — drift is caught immediately
- [ ] Seed script creates the single v1 account [INV-9]

**Tasks:**
- [ ] T1.5.1 unified migrate command, ordered
- [ ] T1.5.2 tracking table + status/down
- [ ] T1.5.3 CI migrate-from-empty step
- [ ] T1.5.4 `pnpm seed` — one tenant, handle, bio page
- [ ] T1.5.5 document the two-flavor split and why it exists
