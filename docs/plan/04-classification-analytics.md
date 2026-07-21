# E4 — Classification & analytics

**Milestone:** M1 · **Depends on:** E3 · **Unblocks:** E5

**Goal:** the read-time view that decides human-vs-bot **and explains itself**, a golden corpus that makes rule changes falsifiable, and the `/v1` query endpoints the dashboard will consume.

**Done when:** `SELECT classification, count(*) FROM events_classified GROUP BY 1` returns an honest split over real traffic, the corpus passes, and M1 is provable with `curl` + one SQL query — with no UI in existence.

**This epic is the product.** Everything before it is plumbing; everything after it is presentation.

---

## S4.1 — The `events_classified` view

**As an** analyst **I want** the verdict computed at read time **so that** improving a rule reclassifies all history with no data rewrite.

**Acceptance:**
- [ ] `CREATE VIEW events_classified` over raw `events` [INV-5]
- [ ] Returns **both** `classification` and `why`, from two parallel `CASE`s over the same ordered rules
- [ ] Rule order exactly per spec §7.1 — order is load-bearing, and the file says so in a comment
- [ ] Joins `asn_datacenter` for the datacenter rule
- [ ] `why` strings are **Spanish and user-facing**, matching POSTA.md §6 recibos copy
- [ ] Every raw `events` column passes through
- [ ] Hand-written SQL migration (drizzle-kit cannot emit views)
- [ ] Drizzle typed read model for app code
- [ ] Query plan verified: the view must not defeat partition pruning

**Tasks:**

#### T4.1.1 · `feat: add events_classified view with classification and why` [INV-5]
`CREATE VIEW events_classified AS SELECT <every events column, enumerated>, <classification CASE>, <why CASE> FROM events e LEFT JOIN asn_datacenter d ON d.asn = e.asn`. **Two parallel `CASE`s over the same predicates in the same order** — one returning the verdict, one the user-facing Spanish reason — because that is what makes the recibos stream free from this same view and keeps a rule change and its explanation impossible to desync.

Rule order per spec §7.1: (1) `sec_purpose`/`purpose`/`x_purpose`/`x_moz` declaring `prefetch`/`preview` → `prefetch`; (2) UA matching the twelve known unfurlers → `unfurler`; (3) `http_method = 'HEAD'` → `unfurler`; (4) UA self-declaring automation → `bot`; (5) UA null or empty → `bot`; (6) `d.asn IS NOT NULL AND sec_ch_ua IS NULL` → `bot`; (7) no `accept_language` and no `sec_fetch_site` and no `sec_ch_ua` → `bot`; (8) else `humano`. `why` strings follow POSTA.md §6 — lowercase, direct, rioplatense: `preview de link · Purpose: prefetch`, `user-agent 'facebookexternalhit'`, `método HEAD`, `sin user-agent`, `ASN 16509 (Amazon) sin fingerprint de browser` (from `d.asn`/`d.name`), `sin accept-language ni fetch metadata`, `humano`.

Columns are enumerated rather than `e.*` because Postgres freezes a `*` at `CREATE VIEW` time, so a later `events` column would silently vanish. A header comment states the order is load-bearing and names the two reorderings that would inflate the human count. Ships with its `.down.sql`.
→ **files** `packages/core/migrations/sql/006_events_classified.sql` · `packages/core/migrations/sql/006_events_classified.down.sql` · `packages/core/src/analytics/events-classified.test.ts` · **verify** `pnpm test events-classified.test.ts` seeds one row per rule and asserts each verdict, including the two ordering traps: a Chrome UA carrying `Sec-Purpose: prefetch` returns `prefetch` not `humano`, and `WhatsApp/2.24` returns `unfurler` not `humano` (it matches no `/bot/`) · **after** T1.2.2, T1.4.1, T1.5.1

> The view ships whole in one commit rather than as verdict-then-reason. A view cannot gain a column without restating its body, so splitting it would mean editing an already-applied migration file — and "never edit an applied migration" (T1.5.6) is not a rule worth bending on the very first view.

#### T4.1.2 · `test: assert every rule returns a distinct Spanish why`
Pure test, no migration change. Seeds one row per rule and asserts the `why` text exactly: `python-requests/2.31` → `user-agent 'python-requests'`, a `HEAD` request → `método HEAD`, a datacenter ASN → the `ASN <n> (<name>)` form built from the join. Asserts all eight `why` values are non-null and mutually distinct, so no two rules can collapse into the same explanation and leave a receipt that says nothing.
→ **files** `packages/core/src/analytics/events-classified.test.ts` · **verify** `pnpm test events-classified.test.ts` · **after** T4.1.1

#### T4.1.3 · `feat: type events_classified as a read-only Drizzle model`
A `pgView('events_classified', { ... }).existing()` mirroring the view's columns plus `classification` and `why` as a union-typed text column, exported as `ClassifiedEventRow`. `.existing()` is what stops drizzle-kit from ever emitting DDL for it; the file is also excluded from the `drizzle.config.ts` schema glob for the same reason `events` is (T1.2.4). Every analytics query in S4.3 selects through this model.
→ **files** `packages/core/src/schema/events-classified.ts` · `packages/core/drizzle.config.ts` · `packages/core/src/schema/events-classified-types.test.ts` · **verify** `pnpm test events-classified-types.test.ts` asserts the Drizzle column set equals `information_schema.columns` for `events_classified` in both directions, and `pnpm db:generate` emits no new migration · **after** T4.1.2

#### T4.1.4 · `test: adding a datacenter ASN reclassifies history with no rewrite` [INV-5]
Inserts an event from an ASN absent from `asn_datacenter`, asserts it reads `humano`, then `INSERT`s that ASN into `asn_datacenter` and asserts the **same, untouched row** now reads `bot` with `why` naming the ASN and its operator. This is the single test that proves the read-time-view thesis: the verdict changed, no event row was written.
→ **files** `packages/core/src/analytics/asn-reclassification.test.ts` · **verify** `pnpm test asn-reclassification.test.ts` asserts the verdict flips and that `xmin` on the event row is unchanged across the flip · **after** T4.1.2, T1.4.3

#### T4.1.5 · `test: the view preserves partition pruning`
`EXPLAIN (FORMAT JSON)` of a tenant + link + one-month `occurred_at` range query against `events_classified`, asserting the plan touches exactly the matching monthly partitions, uses the `(tenant_id, link_id, occurred_at DESC)` index from T1.2.3, and never appears as a materialised subquery. A view that blocks pruning turns every dashboard query into a full-history scan, and the failure is invisible until the table is large.
→ **files** `packages/core/src/analytics/view-pruning.test.ts` · **verify** `pnpm test view-pruning.test.ts` creates three monthly partitions, queries one month, and asserts exactly one partition relation and one Index Scan node in the plan · **after** T4.1.3

#### T4.1.6 · `test: every raw events column passes through the view`
Asserts `information_schema.columns` for `events_classified` equals the `events` column set plus exactly `classification` and `why`. Guards the enumerated column list in T4.1.1 against drift — a signal column added to `events` without being added to the view would be captured, stored, and then unqueryable, which reads as "the signal does nothing".
→ **files** `packages/core/src/analytics/view-column-parity.test.ts` · **verify** `pnpm test view-column-parity.test.ts` passes on the real schema and fails naming the column when the test adds `ALTER TABLE events ADD COLUMN sec_ch_ua_arch text` in a throwaway transaction · **after** T4.1.2

> Rule 1 (prefetch) precedes everything because a prefetch carries a real browser UA and would otherwise read as human. Rule 2 (unfurlers) precedes rule 4 (generic bot regex) because `WhatsApp` does not match `/bot/`. Reordering these silently inflates the human count — which is the exact failure the product exists to prevent.

---

## S4.2 — Nothing queries raw `events`

**As a** maintainer **I want** the view to be the only read path **so that** a dashboard can never accidentally show unfiltered numbers.

**Acceptance:**
- [ ] Every analytics query targets `events_classified` [INV-5]
- [ ] A lint/grep test fails the build on `FROM events` outside the view definition, the worker's insert, and the replay path
- [ ] Application DB role has **no SELECT grant on raw `events`** — enforcement in the database, not just in review
- [ ] Documented: raw reads are for replay and debugging only

**Tasks:**

#### T4.2.1 · `test: forbid FROM events outside the view, the writer and replay` [INV-5]
Scans `apps/**/*.ts` and `packages/core/src/**/*.ts` for `from(events)`, `FROM events`, and `INTO events`, allowing exactly three paths: `packages/core/migrations/sql/`, the worker's batch insert (T3.3.2), and the replay insert path (T3.6.2). Fails naming file and line. Advice, not enforcement — T4.2.2 is the wall — but it fails in the pull request instead of in production.
→ **files** `packages/core/src/analytics/no-raw-events.test.ts` · **verify** `pnpm test no-raw-events.test.ts` passes on the current tree and fails with `file:line` when run against an inline fixture containing `db.select().from(events)` · **after** T4.1.1

#### T4.2.2 · `feat: reader role with SELECT on events_classified only` [security]
`007_roles_reader.sql` creates the `posta_app` role, grants it `SELECT` on `events_classified` and full CRUD on the normal tables, and issues no grant whatsoever on `events`. This works because Postgres checks a view's base-table access as the **view owner**, not the caller — so `posta_app` reads the classified view fine and gets `42501` the moment anything reaches past it. That asymmetry is the entire control.
→ **files** `packages/core/migrations/sql/007_roles_reader.sql` · `packages/core/migrations/sql/007_roles_reader.down.sql` · `packages/core/src/db/roles.test.ts` · **verify** `pnpm test roles.test.ts` asserts `has_table_privilege('posta_app','events','SELECT')` is false, `has_table_privilege('posta_app','events_classified','SELECT')` is true, and that a session as `posta_app` running `SELECT * FROM events` raises SQLSTATE `42501` · **after** T4.1.2

#### T4.2.3 · `feat: writer role for the worker and replay`
`008_roles_writer.sql` creates `posta_worker` with `INSERT` and `SELECT` on `events` (replay's reconciliation report in T3.6.4 has to count rows) and no privileges on the CRUD tables it has no business touching. Two roles rather than one is what lets the reader role be genuinely powerless over raw events without breaking the pipeline.
→ **files** `packages/core/migrations/sql/008_roles_writer.sql` · `packages/core/migrations/sql/008_roles_writer.down.sql` · `packages/core/src/db/roles.test.ts` · **verify** `pnpm test roles.test.ts` asserts `posta_worker` can insert into `events` and cannot `UPDATE links`, and that `posta_app` cannot insert into `events` · **after** T4.2.2

#### T4.2.4 · `feat: connect api and worker as their own database roles`
`.env.example` gains `DATABASE_URL` (as `posta_app`, used by `api`) and `DATABASE_URL_WORKER` (as `posta_worker`); the worker's env schema requires the latter, and the compose bootstrap provisions both roles locally so dev reproduces the production grant boundary instead of running everything as the owner. Without this task the grants in T4.2.2 exist and protect nothing.
→ **files** `.env.example` · `apps/worker/src/env.ts` · `packages/core/src/db/client.ts` · **verify** `pnpm test db/role-boundary.test.ts` opens a pool with each URL and asserts the api pool raises `42501` on `SELECT * FROM events` while the worker pool inserts successfully · **after** T4.2.3

#### T4.2.5 · `docs: database roles and when raw events may be read`
Runbook covering the two roles, what each may touch, the view-owner mechanism that makes the reader role work, and the only two legitimate raw-`events` readers — replay and a human debugging with the owner credential. States plainly that a query needing raw events is a design smell, not a permissions problem to solve with a grant.
→ **files** `docs/runbooks/db-roles.md` · **verify** the doc names both roles, the `42501` symptom, and the escalation path; a reader hitting `42501` can tell from it whether to fix the query or the grant · **after** T4.2.4

> The grant is the real control. A grep test is advice; a missing SELECT privilege is a wall.

---

## S4.3 — Analytics queries

**As a** dashboard **I want** every number the UI needs as a tested query **so that** E7 assembles screens instead of inventing SQL.

**All queries default to humans-only** [INV-10]. Including non-humans is an explicit opt-in parameter, never a default.

**Acceptance:**
- [ ] Per-link summary: real humans, total, the four-way split, `% humano`
- [ ] Time series over 7d / 30d / todo, two series (humanos vs no-humano), zero-filled for gaps
- [ ] Top countries · source platforms · devices · in-app-browser share
- [ ] Recent `recibos` — raw events with `classification` + `why`, newest first, paginated
- [ ] Global overview: total real clicks, global `% no humano`, best link, top source
- [ ] 7-day sparkline series per link, batched for the list — **one query for N links, not N queries** [no N+1]
- [ ] Every query tenant-scoped [INV-9]
- [ ] Every query has an explicit `LIMIT`; no unbounded scans
- [ ] Each has an `EXPLAIN` assertion that partition pruning and the intended index are used

**Tasks:**

#### T4.3.1 · `feat: analytics query primitives — range, tenant scope, humans-only default` [INV-9][INV-10]
The seam every query in this story is built on: `AnalyticsRange = '7d' | '30d' | 'todo'`, `resolveRange()` returning explicit `timestamptz` bounds (`todo` resolves to the link's `created_at`, never an open lower bound, because an unbounded range prunes to every partition), a `humansOnly` predicate applied unless the caller passes `includeNonHumans: true`, mandatory `tenantId`, and `MAX_ROWS` / `MAX_PAGE_SIZE` constants so no query ships without a `LIMIT`. Making the default structural here is what stops [INV-10] from being seven separate places to get it wrong.
→ **files** `packages/core/src/analytics/base.ts` · `packages/core/src/analytics/base.test.ts` · **verify** `pnpm test analytics/base.test.ts` asserts `resolveRange('todo', link)` returns a closed interval starting at `created_at`, that omitting `includeNonHumans` emits `classification = 'humano'` in `.toSQL()`, and that `tenantId` is not optional at the type level · **after** T4.1.3

#### T4.3.2 · `feat: per-link summary query with the four-way split`
`getLinkSummary(tenantId, linkId, range)` returns `{ humanos, total, split: { humano, bot, unfurler, prefetch }, humanPct }` in one pass — a `count(*) FILTER (WHERE classification = ...)` per bucket rather than four round trips. `humanos` is the hero number and is always the humans-only count [INV-10]; `total` is the honest denominator, never folded into the headline.
→ **files** `packages/core/src/analytics/summary.ts` · `packages/core/src/analytics/summary.test.ts` · **verify** `pnpm test analytics/summary.test.ts` seeds 10 humano + 3 bot + 5 unfurler + 2 prefetch and asserts `humanos = 10`, `total = 20`, `humanPct = 50`, and that the four split values sum to `total` · **after** T4.3.1

#### T4.3.3 · `feat: zero-filled daily time series query`
`getLinkTimeseries(tenantId, linkId, range)` returns one row per day in the range with `humanos` and `noHumano` counts, built as `generate_series(from, to, interval '1 day') LEFT JOIN` the aggregate so days with zero events return `0`, not absence. The events side keeps its own literal `occurred_at BETWEEN` predicate — attaching the range only to the series side would produce correct numbers over a full-history scan.
→ **files** `packages/core/src/analytics/timeseries.ts` · `packages/core/src/analytics/timeseries.test.ts` · **verify** `pnpm test analytics/timeseries.test.ts` seeds events on day 1 and day 7 only, asserts a `7d` query returns exactly 7 rows with `0` on days 2–6, and that a São Paulo `-03:00` event is bucketed by its UTC instant · **after** T4.3.1

#### T4.3.4 · `feat: breakdown queries for country, source, device and in-app share`
`getLinkBreakdowns()` returning top countries, `source_platform`, `device_type`, and the in-app-browser share, each `LIMIT`ed and ordered by count descending with a `resto` bucket for the tail so percentages always total 100. One file, one call, four grouped aggregates — the dashboard renders four cards from one round trip.
→ **files** `packages/core/src/analytics/breakdowns.ts` · `packages/core/src/analytics/breakdowns.test.ts` · **verify** `pnpm test analytics/breakdowns.test.ts` asserts each breakdown's percentages sum to 100 including `resto`, that null `country` groups as `desconocido` rather than being dropped, and that non-humans are excluded by default · **after** T4.3.1

#### T4.3.5 · `feat: paginated recibos feed with classification and why`
`getRecibos(tenantId, linkId, cursor, limit)` returns raw events newest first with `classification` and `why` straight from the view — no second lookup, no reimplemented rule table. Keyset pagination on `(occurred_at, event_id) DESC` rather than `OFFSET`, so page 50 costs what page 1 costs and a concurrent insert cannot shift rows across a page boundary. **Defaults to all four classifications**, since a receipt stream that hid the bots would defeat its own purpose — the humans-only default applies to metrics, not to the audit log.
→ **files** `packages/core/src/analytics/recibos.ts` · `packages/core/src/analytics/recibos.test.ts` · **verify** `pnpm test analytics/recibos.test.ts` seeds 250 events, pages through with the cursor, asserts every event appears exactly once, that ordering is stable across an insert mid-pagination, and that `why` is non-null on every row · **after** T4.3.1

#### T4.3.6 · `feat: global overview query`
`getOverview(tenantId, range)` returns total real clicks, global `% no humano`, the best link by human clicks, and the top source platform — the four numbers on the dashboard home. One query with grouped CTEs rather than four calls, and tenant-scoped at the CTE level so a missing predicate is a syntax error rather than a leak.
→ **files** `packages/core/src/analytics/overview.ts` · `packages/core/src/analytics/overview.test.ts` · **verify** `pnpm test analytics/overview.test.ts` seeds two tenants, asserts tenant A's overview counts none of tenant B's events, and that the best link is the one with the most `humano` rows and not the most total rows · **after** T4.3.1

#### T4.3.7 · `feat: batched 7-day sparkline query for N links` [no N+1]
`getSparklines(tenantId, linkIds)` returns a 7-element daily human-click series per link from **one** statement — `unnest($linkIds::text[])` cross joined with `generate_series` of the seven days, left joined to the aggregate, so every link gets seven points including zeros and the links list renders from a single round trip. The links list is the first screen a user sees; per-link queries here would make it the slowest.
→ **files** `packages/core/src/analytics/sparklines.ts` · `packages/core/src/analytics/sparklines.test.ts` · **verify** `pnpm test analytics/sparklines.test.ts` requests 50 links, asserts exactly one statement is issued (via a pg query counter), that every link returns exactly 7 points, and that a link with no events returns seven zeros rather than being absent from the result · **after** T4.3.1

#### T4.3.8 · `test: EXPLAIN assertions for every analytics query`
One table-driven suite running `EXPLAIN (FORMAT JSON)` over all six query families and asserting, per query: only the partitions covering the requested range appear, the expected index from T1.2.3 is used, and no `Seq Scan` on any `events` partition. Wired as a normal test so a query rewritten "for readability" that drops the range predicate fails immediately rather than at scale.
→ **files** `packages/core/src/analytics/query-plans.test.ts` · **verify** `pnpm test analytics/query-plans.test.ts` with six monthly partitions seeded asserts a `7d` query touches one partition, a `30d` query touches at most two, and every plan node against `events*` is an Index or Bitmap Index Scan · **after** T4.3.7

#### T4.3.9 · `test: analytics correctness against a seeded fixture set`
A shared seeder producing a deterministic 30-day, two-tenant, four-classification event set, with every analytics query asserted against hand-computed expected values rather than against itself. Includes the boundary cases the aggregates are most likely to get wrong: a link with zero events, a day with only bots, and an event at exactly the range boundary.
→ **files** `packages/core/src/analytics/fixtures.ts` · `packages/core/src/analytics/analytics-correctness.test.ts` · **verify** `pnpm test analytics-correctness.test.ts` asserts every expected value literally, that tenant B's rows never appear in tenant A's results, and that a zero-event link returns zeros rather than throwing · **after** T4.3.8

#### T4.3.10 · `test: humans-only is the default on every analytics metric` [INV-10]
Enumerates the exported metric functions in `packages/core/src/analytics/` and asserts each one's default-argument SQL contains the humans-only predicate, with `recibos` explicitly listed as the one deliberate exception and a comment saying why. A new query added later without the default fails this test rather than quietly shipping an inflated number — which is the failure the whole product exists to prevent.
→ **files** `packages/core/src/analytics/humans-only-default.test.ts` · **verify** `pnpm test humans-only-default.test.ts` passes on the current tree and fails naming the function when an inline fixture query omits the predicate · **after** T4.3.9

> Zero-filling matters more than it sounds: an area chart that skips empty days silently redraws the shape of a week and makes a quiet Tuesday look like it never happened.

---

## S4.4 — The corpus

**As a** maintainer **I want** a golden fixture corpus **so that** "improving a rule" is falsifiable and regressions are visible.

**This is the most valuable artifact in the repo** — the thing a competitor cannot copy from the marketing page.

**Acceptance:**
- [ ] Fixture set of real UA + header combinations with expected `classification` and expected `why`
- [ ] Coverage across every category: real browsers (desktop, mobile, in-app), the major unfurlers, declared prefetches, scripted clients, datacenter traffic, headless browsers, empty/absent UAs
- [ ] Runs as a normal test; **any view change re-runs it**
- [ ] A failure reports the exact fixture, expected vs actual, and the rule that fired
- [ ] Adding a fixture is a documented one-file change so real traffic can be promoted into it
- [ ] Ambiguous cases are recorded with a written rationale, not silently assigned
- [ ] Corpus provenance documented — each entry says where it came from

**Tasks:**

#### T4.4.1 · `feat: corpus fixture format and Zod-validated loader`
The fixture shape — `{ id, signals: <every §5.1 capture column>, expect: { classification, why }, provenance, note? }` — and a loader that reads every `corpus/*.json`, validates against a Zod schema, and fails on a duplicate `id` or a missing `provenance`. `provenance` is **required**, not optional: a fixture nobody can trace back to a real request is a guess with a test around it.
→ **files** `packages/core/src/classification/corpus/schema.ts` · `packages/core/src/classification/corpus/load.ts` · `packages/core/src/classification/corpus/load.test.ts` · **verify** `pnpm test corpus/load.test.ts` asserts a fixture without `provenance` is rejected naming the id, that duplicate ids are rejected, and that an unknown `classification` value is rejected · **after** T4.1.2

#### T4.4.2 · `test: golden runner replaying the corpus through the view`
Inserts every fixture as an `events` row into the testcontainer, reads them back from `events_classified`, and diffs both `classification` **and** `why`. A failure prints the fixture id, its UA and the headers that mattered, expected versus actual for both columns, and the rule number that actually fired — so a regression is a two-line read, not an afternoon. This is the test that makes "improving a rule" falsifiable; it runs on every view change because it queries the view.
→ **files** `packages/core/src/classification/corpus/golden.test.ts` · **verify** `pnpm test corpus/golden.test.ts` passes on the seeded corpus and, when a fixture's expectation is deliberately flipped, fails with the id, the rule number, and both expected/actual pairs · **after** T4.4.1, T1.1.2

#### T4.4.3 · `feat: seed the real-browser corpus set`
Desktop Chrome, Firefox, Safari and Edge; mobile iOS Safari and Android Chrome; and the LATAM in-app browsers that dominate the traffic — Instagram, `FBAV`/`FBAN`, TikTok, and Line — each with the full client-hint and fetch-metadata header set a real browser sends. All expect `humano`. In-app browsers are the set most likely to be misclassified by a careless rule 4, since several carry app names that look automated.
→ **files** `packages/core/src/classification/corpus/browsers.json` · **verify** `pnpm test corpus/golden.test.ts` stays green with at least 12 browser fixtures, every one returning `humano` · **after** T4.4.2

#### T4.4.4 · `feat: seed the unfurler corpus set`
All twelve unfurlers from spec §7.1 — `facebookexternalhit`, `Twitterbot`, `WhatsApp`, `TelegramBot`, `Slackbot`, `Discordbot`, `LinkedInBot`, `Applebot`, `SkypeUriPreview`, `redditbot`, `Iframely`, `embedly` — plus a bare `HEAD` request with a plausible browser UA covering rule 3 independently. `WhatsApp` and `SkypeUriPreview` are the load-bearing entries: neither matches `/bot/`, so they only classify correctly while rule 2 precedes rule 4.
→ **files** `packages/core/src/classification/corpus/unfurlers.json` · **verify** `pnpm test corpus/golden.test.ts` asserts all thirteen return `unfurler`, and that the `WhatsApp` fixture's `why` names the user-agent rather than the HTTP method · **after** T4.4.2

#### T4.4.5 · `feat: seed the declared-prefetch corpus set`
Prefetches as each engine actually declares them: Chrome's `Sec-Purpose: prefetch` and `Purpose: prefetch`, Firefox's `X-moz: prefetch` and `X-moz: preview`, and Safari's `X-Purpose: preview` — every one carrying a **complete, legitimate browser UA and full client hints**, which is precisely why rule 1 has to run first. Without these fixtures nothing in the suite would catch a reordering that moves prefetches into the human count.
→ **files** `packages/core/src/classification/corpus/prefetch.json` · **verify** `pnpm test corpus/golden.test.ts` asserts every prefetch fixture returns `prefetch` despite a browser UA that would otherwise satisfy rule 8 · **after** T4.4.2

#### T4.4.6 · `feat: seed the scripted-client and headless-browser corpus set`
Rules 4 and 5: `curl`, `wget`, `python-requests`, `go-http-client`, `okhttp`, `axios`, `Googlebot`, `AhrefsBot`, a generic `spider`, plus `HeadlessChrome`, Puppeteer and Playwright defaults — and the empty-UA and absent-UA cases, which are separate fixtures because an empty string and a `NULL` reach the `CASE` differently and only one of them is covered by an `IS NULL`.
→ **files** `packages/core/src/classification/corpus/scripted.json` · **verify** `pnpm test corpus/golden.test.ts` asserts all return `bot`, that the empty-string and null UA fixtures both return `why = 'sin user-agent'`, and that each scripted `why` quotes its own user-agent token · **after** T4.4.2

#### T4.4.7 · `feat: seed the datacenter-ASN and header-poverty corpus set`
Rules 6 and 7, the two probabilistic rules. Datacenter cases pair a real ASN from `asn_datacenter` (AWS 16509, GCP 15169, Hetzner 24940, DigitalOcean 14061) with a missing `sec_ch_ua`; the matched control is the **same ASN with client hints present**, which must stay `humano` — a VPS user browsing is not a bot. Header-poverty cases carry no `accept_language`, no `sec_fetch_site` and no `sec_ch_ua`. The fixture loader seeds the ASNs it depends on so the set is self-contained.
→ **files** `packages/core/src/classification/corpus/datacenter.json` · **verify** `pnpm test corpus/golden.test.ts` asserts the datacenter-without-hints fixtures return `bot` with the ASN and operator name in `why`, and that the same-ASN-with-hints controls return `humano` · **after** T4.4.2, T1.4.3

#### T4.4.8 · `feat: seed the adversarial corpus set with its honest limits`
Bots built to pass: a perfect current Chrome UA with complete client hints from a residential ASN, a scraper mirroring Googlebot's headers without its ASN, and a headless browser with its automation markers stripped. Several of these are expected `humano` — and the fixture records that as a `known_limitation` with a written note, not as a bug to be fixed by a rule that would misclassify real users. Knowing exactly where the line sits is what lets the marketing stay true.
→ **files** `packages/core/src/classification/corpus/adversarial.json` · **verify** `pnpm test corpus/golden.test.ts` stays green with every adversarial fixture, and a loader assertion fails if a fixture expecting `humano` in this file carries no `known_limitation` note · **after** T4.4.2

#### T4.4.9 · `feat: require a written rationale on ambiguous corpus entries`
Extends the schema with `ambiguous: true` plus a required `rationale` string, and makes the loader reject an ambiguous fixture without one. Ambiguity is real — a Samsung Internet UA from a mobile carrier ASN that also hosts servers is a genuine coin flip — and the honest handling is a recorded judgement call, not a silent label. The golden runner prints the rationale alongside any ambiguous fixture that fails.
→ **files** `packages/core/src/classification/corpus/schema.ts` · `packages/core/src/classification/corpus/load.ts` · `packages/core/src/classification/corpus/ambiguity.test.ts` · **verify** `pnpm test corpus/ambiguity.test.ts` asserts an `ambiguous` fixture without `rationale` is rejected naming the id, and that at least one shipped fixture is marked ambiguous with a rationale · **after** T4.4.8

#### T4.4.10 · `docs: how to promote observed traffic into the corpus`
The one-file procedure: pull the row from `events_classified`, copy its signals into the matching `corpus/*.json`, record `provenance` as the event id and date, run the golden test. Names which file each category belongs in, states that a promoted fixture must be a real observed request rather than a hand-typed UA, and covers what to do when the observed verdict is the wrong one — change the view, watch the corpus fail, then decide.
→ **files** `packages/core/src/classification/corpus/README.md` · **verify** the doc names all six fixture files, the required fields, and the golden-test command; a reader can add a fixture from a live event id without reading the loader · **after** T4.4.9

> The adversarial set (T4.4.8) is where the honest limits of the product show. A bot sending a perfect Chrome UA from a residential IP with plausible headers **will** be classified human, and the corpus should say so explicitly rather than pretend otherwise. Knowing exactly where the line sits is what lets the marketing stay true.

---

## S4.5 — `/v1` query endpoints

**As the** dashboard **I want** versioned authenticated endpoints **so that** the v2 API-keys/MCP work needs no re-versioning.

Auth middleware lands in E5; these ship behind the seam.

**Acceptance:**
- [ ] `GET /v1/links/:id/summary` · `/timeseries` · `/breakdowns` · `/recibos`
- [ ] `GET /v1/overview`
- [ ] All responses use the standard envelope (`success`, `data`, `error`, `meta` for paginated)
- [ ] Request params validated with Zod from `contracts`; invalid input is 400 with a useful message
- [ ] Tenant scoping enforced **server-side from the session**, never from a client-supplied `tenant_id` [INV-9][security]
- [ ] Rate limited
- [ ] Cross-tenant access attempts return 404, not 403 — no existence disclosure
- [ ] Response DTOs in `contracts` and shared with `web`

**Tasks:**

#### T4.5.1 · `feat: analytics request and response DTOs in contracts` [security]
Zod request and response schemas for all five endpoints in `packages/contracts/src/analytics.ts` — range enum, cursor, page size bounded by `MAX_PAGE_SIZE`, and the response shapes `web` will consume. **No request schema carries `tenant_id`**, so a client has no field in which to send one; that absence is asserted by a test rather than left to review [INV-9].
→ **files** `packages/contracts/src/analytics.ts` · `packages/contracts/src/analytics.test.ts` · **verify** `pnpm test contracts/src/analytics.test.ts` asserts no request schema has a `tenant_id` key, that `range` rejects `'90d'`, that a page size above the cap rejects, and that a malformed cursor rejects · **after** T4.3.1

#### T4.5.2 · `feat: standard response envelope in contracts and an api helper`
`ApiResponse<T> = { success, data, error, meta? }` and `PaginationMeta` in `contracts`, plus `ok(data, meta?)` / `fail(code, message)` helpers and a Nest interceptor in `api` that wraps every `/v1` response so an endpoint cannot return a bare payload by omission. Errors carry a stable machine code alongside the Spanish message — the UI needs to branch on the code, the user needs to read the message.
→ **files** `packages/contracts/src/envelope.ts` · `apps/api/src/analytics/envelope.interceptor.ts` · `apps/api/src/analytics/envelope.interceptor.test.ts` · **verify** `pnpm test envelope.interceptor.test.ts` asserts a raw controller return is wrapped with `success: true, error: null`, and that a thrown `HttpException` becomes `success: false` with a non-null `error` and null `data` · **after** T4.5.1

#### T4.5.3 · `feat: /v1 analytics router behind the auth and tenant seam` [INV-9][security]
The Nest module, a Zod validation pipe returning `400` with the failing field path, and a `TenantContext` provider whose single method resolves `tenantId` **from the request session and nothing else**. E4 ships a stub implementation that reads a test-only session; E5's T5.2.2 replaces it with the real one and the endpoints need no change. The interface is what makes "tenant comes from the session" structural rather than a habit each endpoint has to remember.
→ **files** `apps/api/src/analytics/analytics.module.ts` · `apps/api/src/analytics/tenant-context.ts` · `apps/api/src/analytics/zod-validation.pipe.ts` · **verify** `pnpm test analytics/tenant-context.test.ts` asserts a request with no session resolves to `401` and that `TenantContext` exposes no setter reachable from request data · **after** T4.5.2

#### T4.5.4 · `feat: GET /v1/links/:id/summary`
Thin controller over `getLinkSummary`, tenant from `TenantContext`, link id from the path. Returns the four-way split and `% humano` in the envelope. A link belonging to another tenant is indistinguishable from a link that does not exist — both `404`.
→ **files** `apps/api/src/analytics/analytics.controller.ts` · `apps/api/src/analytics/summary.e2e.test.ts` · **verify** `pnpm test summary.e2e.test.ts` asserts `200` with the envelope for the owner, `404` for another tenant's link id, and `404` for a well-formed but unknown id · **after** T4.5.3, T4.3.2

#### T4.5.5 · `feat: GET /v1/links/:id/timeseries`
Thin controller over `getLinkTimeseries` with the `range` query param validated by the pipe. Returns the zero-filled two-series payload; an invalid `range` is `400` naming the parameter and the allowed values, in Spanish.
→ **files** `apps/api/src/analytics/analytics.controller.ts` · `apps/api/src/analytics/timeseries.e2e.test.ts` · **verify** `pnpm test timeseries.e2e.test.ts` asserts a `7d` request returns exactly 7 points including zero days, and `range=90d` returns `400` with the allowed values in the message · **after** T4.5.3, T4.3.3

#### T4.5.6 · `feat: GET /v1/links/:id/breakdowns`
Thin controller over `getLinkBreakdowns`, returning all four breakdowns in one response so the dashboard's four cards cost one request.
→ **files** `apps/api/src/analytics/analytics.controller.ts` · `apps/api/src/analytics/breakdowns.e2e.test.ts` · **verify** `pnpm test breakdowns.e2e.test.ts` asserts all four breakdown keys are present, each percentage set sums to 100, and a link with no events returns empty arrays rather than `404` · **after** T4.5.3, T4.3.4

#### T4.5.7 · `feat: GET /v1/links/:id/recibos with pagination meta`
Thin controller over `getRecibos`, cursor and limit from the query, `meta` carrying `nextCursor` and `hasMore`. Every row ships its `classification` and `why` exactly as the view produced them — the endpoint reformats nothing, so the receipts the user reads are the verdicts the database made.
→ **files** `apps/api/src/analytics/analytics.controller.ts` · `apps/api/src/analytics/recibos.e2e.test.ts` · **verify** `pnpm test recibos.e2e.test.ts` pages to exhaustion over 250 seeded events, asserts no duplicates and no gaps, that `hasMore` is false only on the final page, and that all four classifications appear · **after** T4.5.3, T4.3.5

#### T4.5.8 · `feat: GET /v1/overview`
Thin controller over `getOverview` — total real clicks, global `% no humano`, best link, top source — scoped to the session tenant with no path parameter to tamper with.
→ **files** `apps/api/src/analytics/analytics.controller.ts` · `apps/api/src/analytics/overview.e2e.test.ts` · **verify** `pnpm test overview.e2e.test.ts` asserts two seeded tenants receive disjoint overviews and that a tenant with no links returns zeros with `success: true` rather than an error · **after** T4.5.3, T4.3.6

#### T4.5.9 · `test: cross-tenant access returns 404 and client tenant_id is ignored` [INV-9][security]
The isolation suite for all five endpoints: every one is called with another tenant's link id and asserted `404` — never `403`, which would confirm the id exists — and called again with `tenant_id` planted in the query string, the body and an `X-Tenant-Id` header, asserting the response is byte-identical to the request without it. Existence disclosure across tenants is a real leak even when the data is not returned.
→ **files** `apps/api/src/analytics/tenant-isolation.e2e.test.ts` · **verify** `pnpm test tenant-isolation.e2e.test.ts` asserts `404` (not `403`, not `200`) on all five endpoints for a foreign link id, and identical responses with and without every planted `tenant_id` carrier · **after** T4.5.8

#### T4.5.10 · `feat: rate limit the /v1 analytics endpoints`
A per-tenant sliding-window limiter backed by the existing Redis instance, with limits from env and `429` carrying `Retry-After`. Applied to the `/v1` analytics routes only — the redirect hot path is never touched by this middleware [INV-2], and a test asserts that.
→ **files** `apps/api/src/analytics/rate-limit.guard.ts` · `apps/api/src/analytics/rate-limit.guard.test.ts` · `.env.example` · **verify** `pnpm test rate-limit.guard.test.ts` asserts the N+1th request in a window returns `429` with `Retry-After`, that the window resets, and that the redirect middleware is unaffected under the same load · **after** T4.5.9

#### T4.5.11 · `feat: generate the /v1 OpenAPI document from the Zod schemas`
Derives the OpenAPI document from the `contracts` schemas rather than from hand-written decorators, served at `/v1/openapi.json`. Generated from the same source the pipe validates against, so the document cannot drift from the actual contract — which is the whole reason v2's API-keys and MCP work can consume it without a rewrite.
→ **files** `apps/api/src/analytics/openapi.ts` · `apps/api/src/analytics/openapi.test.ts` · **verify** `pnpm test openapi.test.ts` asserts the document validates as OpenAPI 3.1, lists all five paths, and that every response schema resolves to a `contracts` export rather than an inline shape · **after** T4.5.10

---

## S4.6 — M1 acceptance

**As the** builder **I want** the honest number provable before any UI exists **so that** the thesis is validated on evidence, not on a pretty chart.

**Acceptance:**
- [ ] A documented script: create a link via SQL → `curl` it as a browser, as `curl`, as `facebookexternalhit`, with `Purpose: prefetch`, and as `HEAD` → query the view → each lands in the right bucket with the right `why`
- [ ] The split is visibly non-trivial on real traffic (share a link somewhere real and watch the unfurlers arrive)
- [ ] p95 redirect latency measured and recorded
- [ ] `docs/M1-acceptance.md` records the actual output — this is build-in-public material

**Tasks:**

#### T4.6.1 · `feat: M1 acceptance script exercising the five client shapes`
`scripts/m1-acceptance.sh` seeds a link via SQL, then issues five requests against a running stack — a full Chrome header set, `curl` bare, `facebookexternalhit/1.1`, a Chrome UA with `Purpose: prefetch`, and a `HEAD` — waits for the worker to drain, queries `events_classified` for the five `event_id`s, and prints a table of UA, classification and `why`. Exits non-zero if any lands in the wrong bucket, so it is a gate rather than a demo.
→ **files** `scripts/m1-acceptance.sh` · `docs/runbooks/m1-acceptance.md` · **verify** `./scripts/m1-acceptance.sh` against the local stack prints `humano · bot · unfurler · prefetch · unfurler` in order and exits 0; flipping one expected bucket exits non-zero naming the request · **after** T4.5.11, T3.5.2

#### T4.6.2 · `perf: measure p95 redirect latency in the acceptance run`
Extends the script with a bounded load phase against a warm cache and records p50/p95/p99 to first byte, printed alongside the classification table. Reuses the benchmark harness from T2.6.5 rather than adding a second measurement path, so the number in the acceptance doc is the same number CI enforces.
→ **files** `scripts/m1-acceptance.sh` · **verify** the script emits p50/p95/p99 and fails when p95 exceeds the spec §4.1 budget of 15 ms on a cache hit · **after** T4.6.1, T2.6.5

#### T4.6.3 · `docs: record the M1 synthetic acceptance run`
`docs/M1-acceptance.md` with the literal output of a real run against a deployed stack — the five verdicts with their `why` strings, the latency percentiles, the environment, and a section for anything surprising that the run turned up. Build-in-public material, so it records what actually happened rather than what was expected.
→ **files** `docs/M1-acceptance.md` · **verify** the doc contains the verbatim script output including timestamps and the deploy commit sha · **after** T4.6.2

#### T4.6.4 · `docs: record the real-traffic split from a shared link`
Share one real link into a WhatsApp group and an X post, then append the observed split to `docs/M1-acceptance.md` — unfurler arrivals within seconds of posting, the human/no-human ratio, and the `why` strings the unfurlers produced. The highest-value test in M1: this traffic cannot be synthesised convincingly, and it is exactly the inflation every competitor counts as clicks.
→ **files** `docs/M1-acceptance.md` · **verify** the doc records real counts per classification, the arrival latency of the first unfurler, and at least one unfurler UA the corpus did not already contain · **after** T4.6.3

#### T4.6.5 · `feat: promote the novel real-traffic cases into the corpus`
Adds the genuinely new UA/header combinations from T4.6.4 as corpus fixtures, following the T4.4.10 procedure with `provenance` set to the real event id and date. Anything the view got wrong is recorded as an ambiguous fixture with a rationale rather than being quietly relabelled to match the current rules.
→ **files** `packages/core/src/classification/corpus/*.json` · **verify** `pnpm test corpus/golden.test.ts` stays green with the new fixtures, and the corpus contains at least one entry whose `provenance` is a real production event id · **after** T4.4.10, T4.6.4

> Sharing one real link into a WhatsApp group is the single highest-value test in M1. Unfurler traffic arrives within seconds, it is traffic you cannot synthesise convincingly, and it is exactly the inflation every competitor counts as clicks.
