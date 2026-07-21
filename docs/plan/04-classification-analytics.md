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
- [ ] T4.1.1 `classification` CASE, rules 1–8 in order [INV-5]
- [ ] T4.1.2 parallel `why` CASE, same order, Spanish strings
- [ ] T4.1.3 `asn_datacenter` join
- [ ] T4.1.4 migration + rollback
- [ ] T4.1.5 Drizzle read model
- [ ] T4.1.6 `EXPLAIN` check — partition pruning survives the view
- [ ] T4.1.7 comment block explaining why order matters

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
- [ ] T4.2.1 grep test for `FROM events` [INV-5]
- [ ] T4.2.2 DB role with SELECT on the view only
- [ ] T4.2.3 separate writer role for the worker
- [ ] T4.2.4 document the roles

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
- [ ] T4.3.1 per-link summary + split
- [ ] T4.3.2 time series with zero-fill and range param
- [ ] T4.3.3 breakdowns: country, source, device, in-app
- [ ] T4.3.4 recibos feed, paginated
- [ ] T4.3.5 global overview
- [ ] T4.3.6 batched sparkline query [no N+1]
- [ ] T4.3.7 humans-only default + explicit opt-in flag [INV-10]
- [ ] T4.3.8 `EXPLAIN` assertions per query
- [ ] T4.3.9 correctness tests against a seeded fixture set

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
- [ ] T4.4.1 corpus format + loader
- [ ] T4.4.2 seed the real-browser set (desktop, mobile, Instagram/FB/TikTok in-app)
- [ ] T4.4.3 seed unfurlers (WhatsApp, Twitterbot, facebookexternalhit, Slack, Discord, Telegram, LinkedIn, Apple)
- [ ] T4.4.4 seed prefetch cases across Chrome, Firefox and Safari signals
- [ ] T4.4.5 seed scripted clients + datacenter ASN cases
- [ ] T4.4.6 seed adversarial cases — bots impersonating real browser UAs
- [ ] T4.4.7 golden test runner with precise failure output
- [ ] T4.4.8 document how to promote observed traffic into the corpus
- [ ] T4.4.9 ambiguity log with rationale

> The adversarial set (T4.4.6) is where the honest limits of the product show. A bot sending a perfect Chrome UA from a residential IP with plausible headers **will** be classified human, and the corpus should say so explicitly rather than pretend otherwise. Knowing exactly where the line sits is what lets the marketing stay true.

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
- [ ] T4.5.1 `/v1` router behind the auth seam
- [ ] T4.5.2 the five endpoints
- [ ] T4.5.3 Zod request/response DTOs in `contracts`
- [ ] T4.5.4 response envelope helper
- [ ] T4.5.5 tenant scoping from session only [security]
- [ ] T4.5.6 rate limiting
- [ ] T4.5.7 cross-tenant access tests [security]
- [ ] T4.5.8 OpenAPI generation from the Zod schemas

---

## S4.6 — M1 acceptance

**As the** builder **I want** the honest number provable before any UI exists **so that** the thesis is validated on evidence, not on a pretty chart.

**Acceptance:**
- [ ] A documented script: create a link via SQL → `curl` it as a browser, as `curl`, as `facebookexternalhit`, with `Purpose: prefetch`, and as `HEAD` → query the view → each lands in the right bucket with the right `why`
- [ ] The split is visibly non-trivial on real traffic (share a link somewhere real and watch the unfurlers arrive)
- [ ] p95 redirect latency measured and recorded
- [ ] `docs/M1-acceptance.md` records the actual output — this is build-in-public material

**Tasks:**
- [ ] T4.6.1 write the acceptance script
- [ ] T4.6.2 run it against a real deploy
- [ ] T4.6.3 record results, including anything surprising
- [ ] T4.6.4 promote genuinely novel real-traffic cases into the corpus (S4.4)

> Sharing one real link into a WhatsApp group is the single highest-value test in M1. Unfurler traffic arrives within seconds, it is traffic you cannot synthesise convincingly, and it is exactly the inflation every competitor counts as clicks.
