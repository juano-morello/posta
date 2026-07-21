# E1 — Data model

**Milestone:** M1 · **Depends on:** E0 · **Unblocks:** E2

**Goal:** the schema that makes the invariants structurally impossible to violate — no `ip` column, no `classification` column, a primary key shaped for idempotent upserts.

**Done when:** migrations run clean from empty, the `events` table is partitioned by month with partitions provisioned ahead, and a schema test asserts the forbidden columns **do not exist**.

---

## S1.1 — Core tables

**As a** developer **I want** the non-event tables in Drizzle **so that** CRUD has somewhere to live.

Tables: `users` (Better Auth owns its own), `links`, `bio_pages`, `bio_links`, `domains`, `asn_datacenter`.

**Acceptance:**
- [ ] Drizzle schema in `packages/core/src/schema/`, migrations via `drizzle-kit`
- [ ] `links`: `UNIQUE (tenant_id, slug)` [INV-9] — per-tenant, not global
- [ ] Every tenant-owned table carries `tenant_id` and every query path is tenant-scoped from day one
- [ ] IDs are ULID, generated in application code, `text` columns
- [ ] `domains` table exists with a `type` column, unused in v1 — it is the v1.5 custom-domain seam, kept so v1.5 is not a migration
- [ ] `links.destination` validated as an absolute http(s) URL at the schema boundary
- [ ] Timestamps are `timestamptz`, never naive

**Tasks:**

#### T1.1.1 · `chore: postgres client and drizzle-kit config in packages/core`
Create the db seam every later task builds on: a `pg` Pool from `DATABASE_URL` (already validated in E0), `db = drizzle(pool)`, a `closeDb()` for test teardown, and a programmatic drizzle migrator. `drizzle.config.ts` points `schema` at `src/schema/*.ts` and `out` at `migrations/drizzle/`, and adds `db:generate` / `db:migrate` scripts.

Pool `max` is **explicit and env-supplied** (`DB_POOL_MAX`), never left to the driver default. Under Kubernetes the api scales horizontally, so total connections are `pool.max × replicas + worker + migration Job` — and that product has to stay under the managed tier's connection cap. Left implicit, the HPA scaling up under load is what exhausts the database: the autoscaler succeeding *is* the outage. E10/S10.7 checks the arithmetic against the chosen tier.
→ **files** `packages/core/src/db/client.ts` · `packages/core/src/db/index.ts` · `packages/core/drizzle.config.ts` · **verify** `pnpm test db/client.test.ts` connects to the compose Postgres, asserts `SELECT 1` plus `SHOW server_version` ≥ 16, and asserts the pool reports the configured `max` rather than the driver default · **after** —

#### T1.1.2 · `test: testcontainers Postgres 16 harness for packages/core`
Shared integration-test helper that boots Postgres 16 via testcontainers, applies drizzle migrations through the programmatic migrator from T1.1.1, and returns `{ db, url, stop }`. Every integration test in E1–E4 reuses this one helper instead of each booting its own container. Vitest hook timeout raised to 120s for cold image pulls.
→ **files** `packages/core/src/test/pg-container.ts` · `packages/core/vitest.config.ts` · **verify** `pnpm test pg-container.test.ts` boots a container, asserts `SELECT version()` reports 16.x, and asserts `stop()` releases the port · **after** T1.1.1

#### T1.1.3 · `feat: ULID helper in packages/core`
`newId()` returns a 26-char Crockford ULID (via the `ulid` package) and a branded `Ulid` type plus an `isUlid()` guard. IDs are generated in application code and stored as `text` — never a database default, so the same id is available before the insert and can be logged, queued, or retried.
→ **files** `packages/core/src/ulid.ts` · `packages/core/src/ulid.test.ts` · **verify** `pnpm test ulid.test.ts` asserts 26 chars, that two ids generated in sequence sort lexicographically by creation order, and that `isUlid` rejects a UUID · **after** —

#### T1.1.4 · `feat: users table aligned with Better Auth's expected shape`
Drizzle definitions for Better Auth's `user`, `session`, `account` and `verification` tables, matching exactly what its Postgres adapter expects so auth in E5 is configuration rather than a shim. All timestamps `timestamptz`. `user.id` is the ULID that doubles as `tenant_id` for v1 [INV-9]. Note that `session` / `account` / `verification` are auth-owned, not tenant-owned, and deliberately carry no `tenant_id`.
→ **files** `packages/core/src/schema/auth.ts` · `packages/core/src/schema/auth.test.ts` · `packages/core/migrations/drizzle/` · **verify** `pnpm test auth.test.ts` migrates a testcontainer and asserts the four tables exist with Better Auth's required columns and that `user.created_at` is `timestamp with time zone` · **after** T1.1.2, T1.1.3

#### T1.1.5 · `feat: links table with UNIQUE (tenant_id, slug)`
`links(id text pk, tenant_id text not null → user.id, slug text not null, destination text not null, title text, created_at, updated_at, archived_at)`, all timestamps `timestamptz`. `UNIQUE (tenant_id, slug)` — per-tenant, never global [INV-9], because two tenants owning `/promo` on their own subdomains is correct. Index on `(tenant_id, created_at DESC)` for the links list. A `CHECK (destination ~* '^https?://')` as defense in depth behind the contracts validation in T1.1.11.
→ **files** `packages/core/src/schema/links.ts` · `packages/core/src/schema/links.test.ts` · `packages/core/migrations/drizzle/` · **verify** `pnpm test links.test.ts` asserts two tenants can both insert slug `promo`, a same-tenant duplicate raises SQLSTATE `23505`, a `javascript:` destination raises `23514`, and `EXPLAIN` of the list query uses the `(tenant_id, created_at DESC)` index · **after** T1.1.4

#### T1.1.6 · `feat: bio_pages table`
`bio_pages(id, tenant_id not null → user.id, handle text not null UNIQUE, display_name, bio, avatar_url, theme_id text not null default 'default', created_at, updated_at)`. `handle` is globally unique because it is a DNS subdomain, not a per-tenant name. `theme_id` stays a plain text key naming a React theme component (spec §11 deleted the `contracts/themes` indirection) — no FK, no themes table.
→ **files** `packages/core/src/schema/bio.ts` · `packages/core/src/schema/bio-pages.test.ts` · `packages/core/migrations/drizzle/` · **verify** `pnpm test bio-pages.test.ts` asserts the same handle under two different tenants raises `23505` and that `created_at` round-trips as `timestamptz` under a non-UTC session `TimeZone` · **after** T1.1.4

#### T1.1.7 · `feat: bio_links join table referencing links.id`
Adds `bio_links(id, tenant_id not null, bio_page_id → bio_pages.id ON DELETE CASCADE, link_id → links.id ON DELETE RESTRICT, position integer not null, created_at)` to the same schema file. There is deliberately **no** `url` or `destination` column — the FK to `links.id` is what makes "every bio link is already tracked" true by construction. `UNIQUE (bio_page_id, position)` keeps ordering unambiguous.
→ **files** `packages/core/src/schema/bio.ts` · `packages/core/src/schema/bio-links.test.ts` · `packages/core/migrations/drizzle/` · **verify** `pnpm test bio-links.test.ts` asserts `information_schema.columns` for `bio_links` contains no column matching `url|destination|href`, an unknown `link_id` raises `23503`, deleting a referenced link raises `23503`, and a duplicate position raises `23505` · **after** T1.1.5, T1.1.6

#### T1.1.8 · `feat: domains table with unused type column as the v1.5 seam`
`domains(id, tenant_id not null, host text not null UNIQUE, type text not null default 'subdomain', verified_at, created_at)`. Nothing in v1 reads or writes it; it ships empty. It exists so that Cloudflare-for-SaaS custom domains in v1.5 are an INSERT plus a read path, not a migration against a live partitioned database.
→ **files** `packages/core/src/schema/domains.ts` · `packages/core/src/schema/domains.test.ts` · `packages/core/migrations/drizzle/` · **verify** `pnpm test domains.test.ts` asserts the table exists after migrate, is empty, and accepts both `'subdomain'` and `'custom'` in `type` · **after** T1.1.4

#### T1.1.9 · `feat: tenant-scoped repository helper in packages/core/src/db`
`forTenant(tenantId)` returns query builders over `links`, `bio_pages`, `bio_links` and `domains` that inject `eq(table.tenantId, tenantId)` into every select, update and delete, and stamp `tenant_id` on every insert. All CRUD in E2 and E5 goes through it, so "every query path is tenant-scoped" becomes something the type system expresses rather than something a reviewer remembers.
→ **files** `packages/core/src/db/tenant.ts` · `packages/core/src/db/tenant.test.ts` · **verify** `pnpm test tenant.test.ts` seeds two tenants and asserts tenant A reads zero of tenant B's links, an update scoped to A does not touch B's row, and `.toSQL()` on each builder contains `"tenant_id" = $1` · **after** T1.1.5, T1.1.6, T1.1.8

#### T1.1.10 · `test: forbid direct tenant-table access outside the tenant helper`
Replaces "a query without `tenant_id` fails review" — which no CI can run — with a check that does. Scans `apps/**/*.ts` and `packages/core/src/**/*.ts` for `db.select|db.update|db.delete` referencing a tenant-owned table anywhere except `packages/core/src/db/tenant.ts`, and fails naming the offending file and line.
→ **files** `packages/core/src/db/tenant-scope.test.ts` · **verify** `pnpm test tenant-scope.test.ts` passes on the current tree and fails with the file:line when run against an inline fixture containing `db.select().from(links)` · **after** T1.1.9

#### T1.1.11 · `feat: link DTOs in contracts with absolute-URL destination validation` [security]
Zod create/update DTOs for links — the schema boundary the acceptance criterion refers to. `destination` must be an absolute `http(s)` URL: `javascript:`, `data:`, `file:`, protocol-relative `//host`, and bare relative paths are all rejected before anything reaches the database. `slug` is lowercase alnum + dash only (`[a-z0-9-]`, no underscore — it must match S5.3 exactly), 1–64 chars, no leading or trailing hyphen. Reserved paths are checked by **importing `RESERVED_PATHS` from T0.3.4**, never by inlining `favicon.ico`/`robots.txt` as literals — a second copy is exactly the drift that lets a user claim a slug which then 404s.
→ **files** `packages/contracts/src/links.ts` · `packages/contracts/src/links.test.ts` · **verify** `pnpm test contracts/src/links.test.ts` is table-driven over `javascript:alert(1)`, `data:text/html,x`, `//evil.com`, `/relative`, `ftp://x`, `https://x.com/a?b=c#d` and asserts the first five reject and the last accepts · **after** —

#### T1.1.12 · `feat: bio DTOs in contracts with reserved-handle rejection` [security]
Zod DTOs for `bio_pages` and `bio_links`. `handle` is lowercase alnum + dash, 3–30 chars, cannot start or end with a dash, and rejects the reserved list from spec §3.1 (`app` `api` `www` `admin` `static` `assets` `cdn` `mail` `blog` `docs` `status`) — a claimable `api` handle would shadow the API host. `bio_links` DTOs carry `link_id`, never a URL, mirroring T1.1.7.
→ **files** `packages/contracts/src/bio.ts` · `packages/contracts/src/bio.test.ts` · **verify** `pnpm test contracts/src/bio.test.ts` asserts all 11 reserved handles reject, `-juano` and `ju` reject, `juano-dev` accepts, and that the bio-link DTO has no URL field · **after** —

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

#### T1.2.1 · `feat: hand-written SQL migration runner in packages/core/src/db`
Reads `packages/core/migrations/sql/NNN_name.sql` in filename order, runs each inside its own transaction, and records `(filename, checksum, applied_at)` in a `_posta_sql_migrations` table. Re-running is a no-op. A checksum mismatch on an already-applied file is a hard error naming the file, not a silent skip — an edited applied migration is drift, and drift is what this table exists to catch.
→ **files** `packages/core/src/db/sql-migrate.ts` · `packages/core/src/db/sql-migrate.test.ts` · **verify** `pnpm test sql-migrate.test.ts` against a testcontainer: two runs leave one tracking row per file, a mid-file syntax error rolls the whole file back, and editing an applied file throws with its filename · **after** T1.1.2

#### T1.2.2 · `feat: partitioned events table, hand-written SQL`
`CREATE TABLE events (...) PARTITION BY RANGE (occurred_at)` with the exact column list from spec §8: `event_id`, `occurred_at`, `tenant_id`, `link_id`, `slug` NOT NULL; every capture signal nullable (`visitor_hash`, `http_method`, `user_agent`, `referer`, `accept`, `accept_language`, `sec_fetch_site/mode/dest/user`, `sec_purpose`, `sec_ch_ua`, `sec_ch_ua_mobile`, `sec_ch_ua_platform`, `purpose`, `x_purpose`, `x_moz`, `country`, `asn`); enrichment nullable (`browser`, `browser_version`, `os`, `device_type`, `source_platform`, `is_in_app`, `dest_host`). Signals are nullable because a *missing* header is itself evidence. `PRIMARY KEY (event_id, occurred_at)` — the partition key must be in the PK, and it is also exactly what `ON CONFLICT` needs [INV-8]. No `ip`, no `classification`.
→ **files** `packages/core/migrations/sql/001_events.sql` · `packages/core/src/schema/events-schema.test.ts` · **verify** `pnpm test events-schema.test.ts` asserts `pg_class.relkind = 'p'`, `pg_get_partkeydef` is `RANGE (occurred_at)`, the PK columns are exactly `event_id, occurred_at`, `occurred_at` is `timestamptz`, and the full column set equals the spec §8 list · **after** T1.2.1

#### T1.2.3 · `feat: parent-level indexes for tenant+link event queries`
`CREATE INDEX ON events (tenant_id, link_id, occurred_at DESC)` and `(tenant_id, occurred_at DESC)` on the **parent** table. Postgres propagates parent indexes to every partition, existing and future, so partitions created later by T1.3.1 inherit them automatically — which is why the partition-creation function must not create its own copies.
→ **files** `packages/core/migrations/sql/002_events_indexes.sql` · `packages/core/src/schema/events-indexes.test.ts` · **verify** `pnpm test events-indexes.test.ts` creates a partition with raw SQL, asserts both indexes are attached to it via `pg_inherits`, and that `EXPLAIN` of a tenant+link+`occurred_at` range query shows an Index Scan and scans only the matching partition · **after** T1.2.2

#### T1.2.4 · `feat: read-only Drizzle typing for events`
A Drizzle `pgTable` mirroring the hand-written DDL, exported as `EventRow` (read) and `NewEvent` (the worker's batch insert shape) so app code is typed without drizzle-kit owning the DDL. The file is excluded from `drizzle.config.ts`'s schema glob so drizzle-kit never emits DDL for `events` and never tries to "fix" the partitioning away.
→ **files** `packages/core/src/schema/events.ts` · `packages/core/drizzle.config.ts` · `packages/core/src/schema/events-types.test.ts` · **verify** `pnpm test events-types.test.ts` asserts the Drizzle column set is identical to `information_schema.columns` for `events` (both directions, so a drifted column fails), and `pnpm db:generate` emits no new migration file · **after** T1.2.2

#### T1.2.5 · `test: assert events has no ip and no classification column` [INV-4][INV-6][security]
Queries `information_schema.columns` for `events` **and every partition**, failing if any column name matches `ip`, `ip_address`, `remote_addr`, `client_ip`, `classification`, `verdict`, `is_bot`, or `is_human`. This test is not a nice-to-have — the absence of those columns is the entire enforcement mechanism for invariants 4 and 6, and the test is what keeps the absence from being quietly undone.
→ **files** `packages/core/src/schema/events-forbidden-columns.test.ts` · **verify** `pnpm test events-forbidden-columns.test.ts` passes on the real schema and fails with the column name when the test itself runs `ALTER TABLE events ADD COLUMN ip inet` in a throwaway transaction · **after** T1.2.2

#### T1.2.6 · `feat: rollback support for hand-written SQL migrations`
`sql-migrate.ts` gains a `down(filename)` path that runs the paired `NNN_name.down.sql` and deletes the tracking row, plus down files for `001_events.sql` and `002_events_indexes.sql`. Dropping `events` drops its partitions, so `001_events.down.sql` refuses to run when the table has rows unless `--force` — an accidental rollback in staging should be loud, not clean.
→ **files** `packages/core/src/db/sql-migrate.ts` · `packages/core/migrations/sql/001_events.down.sql` · `packages/core/migrations/sql/002_events_indexes.down.sql` · `packages/core/src/db/sql-migrate-down.test.ts` · **verify** `pnpm test sql-migrate-down.test.ts` migrates up, inserts one event, asserts `down` refuses; truncates, asserts `down` succeeds and removes the tracking row; then migrates up again to a green schema test · **after** T1.2.3

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

#### T1.3.1 · `feat: create_events_partition(month) SQL function`
`create_events_partition(p_month date)` computes `date_trunc('month', p_month)` and the following month as UTC bounds and runs `CREATE TABLE IF NOT EXISTS events_YYYY_MM PARTITION OF events FOR VALUES FROM (...) TO (...)`. Indexes are inherited from the parent (T1.2.3), so the function deliberately creates none — duplicating them here would double the write cost of every insert. Calling it twice for the same month is a no-op.
→ **files** `packages/core/migrations/sql/003_partition_fn.sql` · `packages/core/src/db/partitions.test.ts` · **verify** `pnpm test partitions.test.ts` calls the function twice for `2026-09-01`, asserts exactly one `events_2026_09` in `pg_inherits`, that both parent indexes are attached to it, and that its bounds are `[2026-09-01 00:00+00, 2026-10-01 00:00+00)` · **after** T1.2.3

#### T1.3.2 · `feat: DEFAULT partition for events`
`CREATE TABLE events_default PARTITION OF events DEFAULT`. This is what turns "inserts start failing at midnight on the 1st" into "inserts keep working and something beeps". It is created before the bootstrap in T1.3.3 so there is never a window in which an out-of-range insert has nowhere to land.
→ **files** `packages/core/migrations/sql/004_default_partition.sql` · `packages/core/src/db/default-partition.test.ts` · **verify** `pnpm test default-partition.test.ts` inserts an event dated five years out and asserts `SELECT count(*) FROM ONLY events_default` is 1 while the matching monthly partitions stay empty · **after** T1.3.1

#### T1.3.3 · `feat: bootstrap current plus three months of partitions on migrate`
A migration that calls `create_events_partition` for `date_trunc('month', now())` and the next three months, so it is correct whenever it happens to run rather than baking in a fixed date. Adds `ensurePartitionsAhead(months = 3)` in TypeScript, wrapping the same function, so the scheduled job in T1.3.4 and the migration share one definition of "3 months ahead".
→ **files** `packages/core/migrations/sql/005_bootstrap_partitions.sql` · `packages/core/src/db/partitions.ts` · `packages/core/src/db/partitions-bootstrap.test.ts` · **verify** `pnpm test partitions-bootstrap.test.ts` asserts a fresh migrate produces exactly 4 monthly partitions plus `events_default`, and that an insert dated 2 months out lands in its month, not in `events_default` · **after** T1.3.2

#### T1.3.4 · `feat: scheduled partition maintenance job in apps/worker`
A daily BullMQ repeatable job calling `ensurePartitionsAhead(3)`. It lives in the worker because that is the only process with a scheduler; it issues DDL only and never touches event rows, so [INV-4] is untouched — the worker still does not judge anything.
→ **files** `apps/worker/src/partitions/partition-maintenance.job.ts` · `apps/worker/src/partitions/partition-maintenance.job.test.ts` · **verify** `pnpm test partition-maintenance.job.test.ts` runs the job against a testcontainer with the clock advanced two months, asserts the two missing months are created, and asserts a second immediate run creates nothing · **after** T1.3.3

#### T1.3.5 · `feat: alert on non-empty events_default`
`countDefaultPartitionRows()` in `partitions.ts`; the maintenance job logs at `error` level and sets a `posta_events_default_rows` gauge whenever it is greater than zero. Without this the DEFAULT partition is a silent leak — data lands somewhere unqueried and nobody finds out until a dashboard number is wrong. Rows there always mean the maintenance job failed.
→ **files** `packages/core/src/db/partitions.ts` · `apps/worker/src/partitions/partition-maintenance.job.ts` · `apps/worker/src/partitions/default-partition-alert.test.ts` · **verify** `pnpm test default-partition-alert.test.ts` inserts a far-future row, runs the job, and asserts the gauge reads 1 and one `error`-level log was emitted naming `events_default` · **after** T1.3.4

#### T1.3.6 · `test: partition boundary and pruning tests`
The month-edge cases the bounds arithmetic is most likely to get wrong: `2026-08-31T23:59:59.999Z` lands in August, `2026-09-01T00:00:00.000Z` lands in September, a `-03:00` São Paulo timestamp is routed by its UTC instant and not its local date, and a query with an `occurred_at BETWEEN` range prunes to the matching partitions only.
→ **files** `packages/core/src/db/partition-boundaries.test.ts` · **verify** `pnpm test partition-boundaries.test.ts` asserts each row's `tableoid::regclass` and that `EXPLAIN` of a one-month range query lists exactly one partition · **after** T1.3.3

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

#### T1.4.1 · `feat: asn_datacenter lookup table`
`asn_datacenter(asn integer primary key, name text not null, added_at timestamptz not null default now())`. Global reference data, not tenant-owned — it deliberately carries no `tenant_id`, since a datacenter ASN is a fact about the internet, not about an account. Adding an ASN being an INSERT is what keeps rule 6 of the classification view improvable without a migration against a live partitioned table.
→ **files** `packages/core/src/schema/asn.ts` · `packages/core/src/schema/asn.test.ts` · `packages/core/migrations/drizzle/` · **verify** `pnpm test asn.test.ts` asserts the table exists after migrate, a duplicate `asn` raises `23505`, and `added_at` is `timestamp with time zone` · **after** T1.1.2

#### T1.4.2 · `chore: vendored datacenter ASN list with provenance`
A committed JSON dataset of `{ asn, name, source }` covering AWS, GCP, Azure, DigitalOcean, Hetzner, OVH, Linode/Akamai, Vultr, Cloudflare, Oracle, Scaleway, Contabo, and the LATAM hosting ASNs that actually appear in traffic. A header entry records the upstream dataset and the date pulled. Committed rather than fetched at runtime because a classification input that changes silently would invalidate E4's golden corpus without a diff.
→ **files** `packages/core/scripts/data/datacenter-asns.json` · `packages/core/scripts/data/datacenter-asns.test.ts` · **verify** `pnpm test datacenter-asns.test.ts` asserts every entry has `asn`/`name`/`source`, ASNs are unique positive integers, and the file has at least 200 entries · **after** —

#### T1.4.3 · `feat: idempotent asn_datacenter seed script`
`pnpm seed:asn` reads the JSON and issues one multi-row `INSERT ... ON CONFLICT (asn) DO UPDATE SET name = EXCLUDED.name`. Re-running after editing a name updates it in place without duplicating rows or resetting `added_at`, so the seed is safe to run on every deploy.
→ **files** `packages/core/scripts/seed-asn.ts` · `packages/core/scripts/seed-asn.test.ts` · **verify** `pnpm test seed-asn.test.ts` runs the seed twice against a testcontainer and asserts the row count equals the JSON length both times, that a renamed entry updates, and that `added_at` is unchanged on the second run · **after** T1.4.1, T1.4.2

#### T1.4.4 · `docs: ASN list refresh procedure`
Documents where the list came from, how to refresh it, why a runtime fetch was rejected (see T1.4.2), and the one-line `INSERT` for adding a single ASN in production without a deploy — which is the whole reason this is a table. E4's view task links here.
→ **files** `packages/core/scripts/data/README.md` · **verify** the doc names the upstream source URL, the `pnpm seed:asn` command, and the production hotfix `INSERT`; a reader can add an ASN without reading the seed script · **after** T1.4.3

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

#### T1.5.1 · `feat: unified pnpm migrate running drizzle then hand-written SQL`
One entrypoint that applies `migrations/drizzle/` via the programmatic migrator first, then `migrations/sql/` via the runner from T1.2.1. The order is fixed and asserted, not incidental: `005_bootstrap_partitions.sql` depends on the function created in `003`, and E4's `events_classified` view will depend on `asn_datacenter`, which drizzle owns. Exposed as `pnpm migrate` at the repo root.
→ **files** `packages/core/src/db/migrate.ts` · `packages/core/package.json` · `package.json` · **verify** `pnpm test migrate.test.ts` runs `migrate()` twice against an empty testcontainer and asserts the first produces every table, function and partition while the second applies nothing and exits 0 · **after** T1.2.1, T1.3.3, T1.4.1

#### T1.5.2 · `feat: pnpm migrate:status`
Prints both flavors in one table — filename, flavor (`drizzle` | `sql`), `applied_at`, and `PENDING` for anything on disk but not tracked — and exits non-zero when anything is pending, so CI in T1.5.4 can use it directly as a gate rather than parsing output.
→ **files** `packages/core/src/db/migrate-status.ts` · `packages/core/src/db/migrate-status.test.ts` · **verify** `pnpm test migrate-status.test.ts` asserts a half-migrated container lists the pending file and exits 1, and that after `pnpm migrate` it exits 0 · **after** T1.5.1

#### T1.5.3 · `feat: pnpm migrate:down for the last hand-written migration`
Reverts exactly one step, newest first, using the `.down.sql` pairs from T1.2.6. It refuses to touch drizzle-generated migrations — drizzle-kit's own tooling owns those — so the two flavors never disagree about who applied what.
→ **files** `packages/core/src/db/migrate-down.ts` · `packages/core/src/db/migrate-down.test.ts` · **verify** `pnpm test migrate-down.test.ts` migrates, downs once, asserts `migrate:status` reports exactly one pending file and exits 1, then migrates again and asserts the schema tests pass · **after** T1.2.6, T1.5.2

#### T1.5.4 · `ci: run migrations from empty on every build`
A `migrate-from-empty` job that starts the Postgres 16 service container, runs `pnpm migrate` then `pnpm migrate:status`, and fails on non-zero. This is what catches drift: a schema change committed without regenerating the drizzle migration, or a `sql/` file renamed or edited after being applied.
→ **files** `.github/workflows/ci.yml` · **verify** the job is green on a PR against the current tree and goes red when a commit edits an already-applied `migrations/sql/*.sql` file · **after** T1.5.2

#### T1.5.5 · `feat: pnpm seed creates the single v1 account` [INV-9][security]
Creates one Better Auth user with email and password read from env (never hardcoded, never logged), sets `tenant_id = user.id`, creates its `bio_pages` row with the handle from env, and one example `links` row so the redirect path in E2 has something to resolve. Idempotent by email. There is no public signup route in v1 — not hidden, absent — so this script is the only way an account comes into being.
→ **files** `packages/core/scripts/seed.ts` · `packages/core/scripts/seed.test.ts` · **verify** `pnpm test seed.test.ts` runs the seed twice against a testcontainer and asserts exactly one user, one bio page and one link; that the stored password is a hash and not the env value; and that a missing `SEED_PASSWORD` exits non-zero naming the variable · **after** T1.1.6, T1.5.1

#### T1.5.6 · `docs: why migrations come in two flavors`
What belongs in `migrations/drizzle/` versus `migrations/sql/` and the rule for deciding (drizzle-kit cannot emit `PARTITION BY`, `CREATE VIEW`, or `CREATE FUNCTION`), the fixed run order from T1.5.1, the `NNN_name.sql` naming convention, and the checksum rule — never edit an applied file, add a new one.
→ **files** `packages/core/migrations/README.md` · **verify** the doc names both directories, the run order, and the checksum rule; a contributor can place E4's `events_classified` view in the correct directory without asking · **after** T1.5.3
