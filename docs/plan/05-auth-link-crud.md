# E5 — Auth & link CRUD

**Milestone:** M2 · **Depends on:** E4 · **Unblocks:** E7, E8

**Goal:** one seeded account can log in and manage links, with tenant scoping enforced server-side and slug validation that agrees with the redirect path.

**Done when:** the seeded account creates a vanity link and clicks it successfully, a second tenant cannot see it, and no signup route exists anywhere in the codebase.

---

## S5.1 — Better Auth

**As the** single v1 user **I want** to log in **so that** the dashboard is mine and nobody else's.

**Acceptance:**
- [ ] Better Auth on Postgres, email + password
- [ ] Session cookie scoped to `app.posta.lat`, `httpOnly`, `secure`, `sameSite=lax`
- [ ] **No signup route exists** — absent from the codebase, not hidden behind a flag [scope]
- [ ] `pnpm seed` creates the single account; password from env, never committed
- [ ] Password hashing per Better Auth defaults (argon2/bcrypt), never hand-rolled
- [ ] Login is rate-limited and generic on failure — no user-enumeration via differing messages or timing
- [ ] Sessions expire and refresh sanely; logout revokes server-side
- [ ] `tenant_id == user_id` established at seed [INV-9]

**Tasks:**
- [ ] T5.1.1 Better Auth wiring + schema alignment with E1
- [ ] T5.1.2 email/password provider
- [ ] T5.1.3 cookie + session config
- [ ] T5.1.4 seed script with env-supplied password
- [ ] T5.1.5 rate limiting + generic failure responses [security]
- [ ] T5.1.6 logout with server-side revocation
- [ ] T5.1.7 auth tests incl. expiry, revocation, enumeration resistance

> No signup route means *no route*. A disabled endpoint is an endpoint, and "temporarily disabled" is how public signup arrives before billing does.

---

## S5.2 — Auth middleware for `/v1`

**As an** API **I want** one auth seam **so that** v2 API keys slot in without touching every endpoint.

**Acceptance:**
- [ ] Middleware validating the session, attaching `tenant_id` to the request context
- [ ] Every `/v1/*` route behind it; unauthenticated → 401
- [ ] **`tenant_id` comes only from the session** — a client-supplied one is ignored, and supplying one is logged [INV-9][security]
- [ ] The seam accepts a future API-key strategy without changing endpoint code
- [ ] CORS restricted to the dashboard origin
- [ ] The redirect hot path is **untouched** by this middleware [INV-2]

**Tasks:**
- [ ] T5.2.1 session validation middleware
- [ ] T5.2.2 tenant context injection [INV-9]
- [ ] T5.2.3 strategy-pattern seam for v2 keys
- [ ] T5.2.4 CORS config
- [ ] T5.2.5 test: hot path unaffected [INV-2]
- [ ] T5.2.6 test: client-supplied `tenant_id` is ignored [security]

---

## S5.3 — Slug generation & validation

**As a** user **I want** random or vanity slugs with instant feedback **so that** I know before saving whether my slug is free.

**Acceptance:**
- [ ] Random slugs: 7 chars, unambiguous alphabet (no `0/O`, `1/l/I`), collision-retried
- [ ] Vanity slugs: `[a-z0-9-]`, 1–64 chars, no leading/trailing hyphen, lowercased on save
- [ ] Rejects the **reserved path list from `contracts`** — the same list the hot path uses (S2.1), never a copy
- [ ] Uniqueness is per tenant [INV-9]
- [ ] `GET /v1/links/check-slug?slug=` for live validation, rate-limited
- [ ] Race-safe: two simultaneous creates of the same slug → one wins, the other gets a clean 409, not a 500
- [ ] Error copy is rioplatense: `✕ ese slug ya existe — probá otro`

**Tasks:**
- [ ] T5.3.1 random slug generator with unambiguous alphabet
- [ ] T5.3.2 vanity validation rules in `contracts` (shared with `web`)
- [ ] T5.3.3 reserved-list check reusing S2.1's list
- [ ] T5.3.4 check-slug endpoint + rate limit
- [ ] T5.3.5 DB unique constraint as the real arbiter; map violation → 409
- [ ] T5.3.6 concurrent-create test
- [ ] T5.3.7 Spanish validation messages

> Validate optimistically for UX, but let the unique constraint decide. Check-then-insert has a race window, and the database already knows the answer.

---

## S5.4 — Links CRUD

**As a** user **I want** to create, edit, archive and list links **so that** I can run my links.

**Acceptance:**
- [ ] `POST /v1/links` · `GET /v1/links` · `GET /v1/links/:id` · `PATCH /v1/links/:id` · `DELETE /v1/links/:id`
- [ ] Destination validated as absolute `http(s)`; rejects `javascript:`, `data:`, and other schemes [security]
- [ ] SSRF-adjacent targets (localhost, link-local, private ranges) rejected [security]
- [ ] **Delete is archive** (`archived_at`) — events reference the link and history must survive
- [ ] Editing destination or slug **invalidates the Redis cache** via S2.2's `invalidateLink()` — otherwise the 307 keeps serving the old target for up to an hour
- [ ] Slug edits are allowed; the old slug is freed and stops resolving
- [ ] List endpoint is paginated, includes the batched sparkline (S4.3), sorted by `created_at DESC`
- [ ] All operations tenant-scoped; cross-tenant → 404 [INV-9]

**Tasks:**
- [ ] T5.4.1 the five endpoints with Zod DTOs in `contracts`
- [ ] T5.4.2 destination validation + scheme allowlist [security]
- [ ] T5.4.3 private-range/SSRF rejection [security]
- [ ] T5.4.4 archive semantics
- [ ] T5.4.5 cache invalidation on edit and archive
- [ ] T5.4.6 slug-change handling, old slug freed
- [ ] T5.4.7 paginated list with sparklines
- [ ] T5.4.8 cross-tenant tests [INV-9]
- [ ] T5.4.9 test: edit destination → next redirect uses the new one immediately

> T5.4.9 is the one people forget. The cache TTL is an hour; without explicit invalidation, "I fixed the link" is false for sixty minutes and the user has no way to tell.

---

## S5.5 — Tenancy hardening

**As a** future multi-tenant operator **I want** isolation proven now **so that** v1.5 is configuration rather than an audit.

**Acceptance:**
- [ ] Test suite seeding **two** tenants, asserting neither can read or mutate the other's links, bio, or analytics [INV-9]
- [ ] Every table with tenant data has `tenant_id` non-null
- [ ] No endpoint accepts `tenant_id` as input
- [ ] Cross-tenant reads return 404 (no existence disclosure)
- [ ] A repository-layer helper makes the tenant-scoped query the path of least resistance

**Tasks:**
- [ ] T5.5.1 two-tenant fixture
- [ ] T5.5.2 isolation suite across links, bio and analytics [INV-9]
- [ ] T5.5.3 schema audit for nullable `tenant_id`
- [ ] T5.5.4 tenant-scoped repository helper
- [ ] T5.5.5 grep test: no endpoint reads `tenant_id` from the body or query

> v1 has one account, so none of this can fail in production yet. That is exactly why it is cheap to build now and expensive to retrofit later — the isolation bugs you cannot see are the ones shipping today.
