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

#### T5.1.1 · `feat: mount better auth on the api with the postgres adapter`
Instantiate Better Auth in `apps/api` against the existing `user` / `session` / `account` / `verification` tables from T1.1.4, using the Drizzle adapter over the `packages/core` pool — no second connection, no Better Auth-owned migration. Secret and base URL come from the validated env schema (T0.3.5). No providers enabled yet; this task only proves the adapter binds to the schema E1 already shipped.
→ **files** `apps/api/src/auth/auth.ts` · `apps/api/src/auth/auth.module.ts` · **verify** `pnpm test apps/api/src/auth/auth.test.ts` boots against the testcontainer harness (T1.1.2) and asserts Better Auth reads and writes the four existing tables and emits no migration of its own · **after** T1.1.4, T0.3.5

#### T5.1.2 · `feat: enable email and password login`
Turn on the `emailAndPassword` provider. Hashing stays at Better Auth's default (scrypt/argon2) — never hand-rolled, never configured down. Email verification is off: v1 has one seeded account and no mail transport, and a verification flow nobody can complete is a broken door.
→ **files** `apps/api/src/auth/auth.ts` · **verify** `pnpm test auth-password.test.ts` seeds a user, asserts the correct password authenticates and a wrong one does not, and asserts the stored credential is neither the plaintext nor a bare unsalted digest · **after** T5.1.1

#### T5.1.3 · `feat: scope the session cookie to the app host` [security]
Cookie attributes: `httpOnly`, `secure`, `sameSite=lax`, and a domain built from `POSTA_LINK_DOMAIN` through `buildAppUrl()` (T0.3.3) rather than a literal — the grep test in T0.3.9 fails otherwise. `sameSite=lax` and not `strict` because the dashboard is navigated to from external links; not `none` because nothing legitimately embeds it.
→ **files** `apps/api/src/auth/auth.ts` · **verify** `pnpm test auth-cookie.test.ts` runs the login flow under a non-`posta.lat` test domain and asserts `Set-Cookie` carries `HttpOnly; Secure; SameSite=Lax` and a domain derived from that env value · **after** T5.1.2

#### T5.1.4 · `feat: session expiry with rolling refresh`
`expiresIn` 7 days, `updateAge` 1 day, so an active user is never logged out mid-session and an abandoned one expires within a week. Expiry is enforced server-side against `session.expires_at`, not by trusting the cookie's own `Max-Age`.
→ **files** `apps/api/src/auth/auth.ts` · **verify** `pnpm test auth-session-expiry.test.ts` back-dates `session.expires_at` in the database and asserts the still-present cookie no longer authenticates; and that a request inside the refresh window extends the row · **after** T5.1.3

#### T5.1.5 · `feat: logout revokes the session server-side`
Sign-out deletes the `session` row and clears the cookie, in that order. Clearing only the cookie leaves a valid session token that a copy of the cookie can keep using — logout has to mean something at the server.
→ **files** `apps/api/src/auth/auth.ts` · `apps/api/src/auth/auth.controller.ts` · **verify** `pnpm test auth-logout.test.ts` captures the cookie, signs out, replays the captured cookie and asserts 401, plus asserts zero rows remain in `session` for that user · **after** T5.1.4

#### T5.1.6 · `feat: rate-limit login attempts` [security]
Redis-backed fixed window on the sign-in route, keyed on both source IP and submitted email, so neither a single address spraying many emails nor many addresses targeting one account gets through. Exceeding the window returns the same generic 401 shape as a wrong password (see T5.1.7) with a `Retry-After` header — a distinct 429 body is itself an enumeration signal.
→ **files** `apps/api/src/auth/login-rate-limit.guard.ts` · `apps/api/src/auth/auth.module.ts` · **verify** `pnpm test login-rate-limit.test.ts` asserts the Nth+1 attempt inside the window is rejected, that the counter is per-email as well as per-IP, and that the window expires · **after** T5.1.5

#### T5.1.7 · `feat: one generic login failure, in message and in timing` [security]
Unknown email, wrong password and rate-limited all produce an identical 401 body — `✕ email o contraseña incorrectos` — with no field-level detail. When the email does not exist, still run a hash verification against a fixed dummy digest so the response time does not disclose existence. Differing timing is user enumeration with extra steps.
→ **files** `apps/api/src/auth/auth.controller.ts` · `apps/api/src/auth/generic-failure.ts` · **verify** `pnpm test login-enumeration.test.ts` asserts byte-identical bodies and status for unknown-email versus wrong-password, and that the median of 50 samples of each differs by less than a stated tolerance · **after** T5.1.6

#### T5.1.8 · `feat: mount only the sign-in, sign-out and session auth routes` [scope]
Better Auth's `emailAndPassword` provider ships a `sign-up/email` handler by default. Mount its handler behind an explicit path allowlist — `sign-in/email`, `sign-out`, `get-session` — so every other auth path, sign-up included, is never routed and returns 404 from the router. `disableSignUp: true` is set as well, as defense in depth rather than as the mechanism.
→ **files** `apps/api/src/auth/auth.routes.ts` · `apps/api/src/main.ts` · **verify** `pnpm test auth-routes.test.ts` asserts the three allowed paths respond and that `POST /api/auth/sign-up/email` returns 404 with no `session` or `user` row created · **after** T5.1.7

#### T5.1.9 · `refactor: seed the v1 account through better auth's own hashing` [INV-9][security]
T1.5.5 wrote the seed user before Better Auth existed. Point `packages/core/scripts/seed.ts` at Better Auth's server-side sign-up API instead of its own insert, so the seeded credential is hashed by exactly the code that will verify it — a seed that hashes differently from login is a first-run failure nobody debugs quickly. Password still from env, never logged; `tenant_id = user.id` unchanged.
→ **files** `packages/core/scripts/seed.ts` · **verify** `pnpm test seed.test.ts` extends to assert the seeded account authenticates through the real login endpoint, and that re-running the seed still yields exactly one user · **after** T5.1.8, T1.5.5

#### T5.1.10 · `test: assert no signup route exists in the codebase` [scope]
Two assertions, because either alone is weak. A source scan of `apps/**/*.ts` and `apps/web/src/app/**` fails on any route, handler or link matching `sign-?up|signup|register`, allowlisting only `auth.routes.ts` where the path is named in order to be excluded. A runtime assertion enumerates the mounted Express route table and asserts nothing matches. No signup route means *no route*.
→ **files** `apps/api/src/auth/no-signup.test.ts` · **verify** `pnpm test no-signup.test.ts` passes on the current tree and fails naming the file when a `sign-up` route is planted in a fixture · **after** T5.1.8

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

#### T5.2.1 · `feat: auth strategy seam with an ordered registry`
Define `AuthStrategy { name; authenticate(req): Promise<AuthContext | null> }` where `AuthContext` is `{ tenantId, userId, principal: 'session' | 'api-key' }`, plus a registry that tries registered strategies in order and returns the first non-null. Endpoint code depends only on `AuthContext`, so the v2 API-key strategy is a registration, not an edit to every controller.
→ **files** `apps/api/src/auth/strategy.ts` · `apps/api/src/auth/strategy.test.ts` · **verify** `pnpm test strategy.test.ts` registers a stub second strategy and asserts a request the first strategy rejects is authenticated by the second, with no controller change and the correct `principal` on the context · **after** T5.1.1

#### T5.2.2 · `feat: session auth strategy backed by better auth`
The one v1 implementation of `AuthStrategy`: reads the session cookie, validates it through Better Auth's `getSession`, and returns `{ tenantId: user.id, userId: user.id, principal: 'session' }` [INV-9]. Returns null rather than throwing on an absent or invalid cookie — deciding what a null means is the guard's job, not the strategy's.
→ **files** `apps/api/src/auth/session.strategy.ts` · `apps/api/src/auth/session.strategy.test.ts` · **verify** `pnpm test session.strategy.test.ts` asserts a valid cookie yields `tenantId === userId`, and that a missing, malformed and expired cookie each yield null without throwing · **after** T5.2.1, T5.1.4

#### T5.2.3 · `feat: guard every /v1 route with the auth seam`
A Nest guard consuming the strategy registry, applied to the `/v1` route prefix as a whole rather than per-controller, so a new controller is protected by existing in the right place. Unauthenticated returns 401 with `✕ sesión expirada — entrá de nuevo` and a `WWW-Authenticate`-free body, since v1 has no challenge to offer.
→ **files** `apps/api/src/auth/auth.guard.ts` · `apps/api/src/app.module.ts` · **verify** `pnpm test auth-guard.test.ts` asserts every registered `/v1/*` route returns 401 without a cookie — enumerated from the Nest router at runtime, so a newly added unprotected route fails the test · **after** T5.2.2

#### T5.2.4 · `feat: request-scoped tenant context sourced only from the session` [INV-9][security]
`TenantContext` is populated from the `AuthContext` the guard produced and from nowhere else — no header, no body, no query, no route param. Services take `tenantId` from it and hand it to `forTenant()` (T1.1.9), which is what makes the tenant-scoped query the path of least resistance rather than a reviewer's memory.
→ **files** `apps/api/src/auth/tenant.context.ts` · `apps/api/src/auth/tenant.context.test.ts` · **verify** `pnpm test tenant.context.test.ts` asserts the context value equals the session's user id even when the request carries a conflicting `tenant_id` in body, query and header simultaneously · **after** T5.2.3, T1.1.9

#### T5.2.5 · `feat: strip and log client-supplied tenant_id` [INV-9][security]
Middleware that deletes `tenant_id` / `tenantId` from body, query and params before the handler runs, and emits a `warn` naming the route, the authenticated principal and where the field appeared. Silently ignoring it is correct behavior with no signal; a legitimate client never sends it, so every occurrence is either a bug or a probe and both are worth seeing.
→ **files** `apps/api/src/auth/strip-tenant.middleware.ts` · `apps/api/src/auth/strip-tenant.middleware.test.ts` · **verify** `pnpm test strip-tenant.middleware.test.ts` asserts the handler observes no `tenant_id` in any of the three locations and that exactly one `warn` was emitted naming the route · **after** T5.2.4

#### T5.2.6 · `feat: restrict cors to the dashboard origin` [security]
Allowed origin is the single dashboard host derived from `POSTA_LINK_DOMAIN` via `buildAppUrl()` (T0.3.3), with `credentials: true` — which makes a wildcard origin both wrong and, for cookie-bearing requests, refused by browsers anyway. Applied to `/v1/*` only; the redirect path serves cross-origin navigations and must not gain a CORS layer.
→ **files** `apps/api/src/main.ts` · `apps/api/src/auth/cors.config.ts` · **verify** `pnpm test cors.test.ts` asserts a preflight from the app origin is allowed with credentials, from any other origin is refused, and that no `Access-Control-*` header appears on a redirect response · **after** T5.2.5

#### T5.2.7 · `test: assert the redirect hot path bypasses auth middleware` [INV-2]
The middleware order in `main.ts` is load-bearing and invisible in a diff: the redirect middleware mounts before Nest's router, so the guard, the tenant context and the strip middleware never see a `/:slug` request. Assert it two ways — a request to `<handle>.<domain>/:slug` with no cookie still 307s, and spies on all three middlewares record zero invocations for it.
→ **files** `apps/api/src/auth/hot-path-untouched.test.ts` · **verify** `pnpm test hot-path-untouched.test.ts` asserts the 307 and zero middleware invocations, and fails when the redirect middleware is remounted after the guard · **after** T5.2.6, T2.1.3

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

#### T5.3.1 · `feat: random slug generator on an unambiguous alphabet`
`generateSlug()` returns 7 characters drawn from an exported `SLUG_ALPHABET` constant that omits `0`/`O` and `1`/`l`/`I`, using `crypto.randomInt` rather than `Math.random` — a shortener's slug space is enumerable and predictable slugs are a scraping surface. The alphabet is a constant so the generator, the docs and the tests cannot drift apart.
→ **files** `apps/api/src/links/slug.generator.ts` · `apps/api/src/links/slug.generator.test.ts` · **verify** `pnpm test slug.generator.test.ts` asserts length 7, that 10 000 draws contain no character outside `SLUG_ALPHABET`, and that every ambiguous character is absent from the alphabet itself · **after** —

#### T5.3.2 · `feat: collision-retried slug allocation`
`allocateSlug(insert)` generates a slug, attempts the caller's insert, and on SQLSTATE `23505` regenerates and retries up to 5 times before throwing a named exhaustion error. Retrying the *insert* rather than pre-checking availability is deliberate: with 32^7 slugs a collision is rare, and the only correct place to learn about one is the unique constraint.
→ **files** `apps/api/src/links/slug.allocator.ts` · `apps/api/src/links/slug.allocator.test.ts` · **verify** `pnpm test slug.allocator.test.ts` asserts an insert stub raising `23505` for the first three slugs still succeeds on the fourth, and that five consecutive conflicts throw an error naming exhaustion rather than looping · **after** T5.3.1

#### T5.3.3 · `feat: vanity slug rules in contracts, shared with web`
Narrow the `slug` field of the link DTOs from T1.1.11 to the S5.3 rule: `[a-z0-9-]` only — T1.1.11 permitted underscore, this removes it — 1–64 characters, no leading or trailing hyphen, and `.transform()` to lowercase so what is validated is what is saved. It lives in `contracts` so `web` and the API reject identically and the client never shows "available" for something the server refuses.
→ **files** `packages/contracts/src/links.ts` · `packages/contracts/src/links.test.ts` · **verify** `pnpm test contracts/src/links.test.ts` is table-driven over `-promo`, `promo-`, `pro_mo`, `pro mo`, a 65-character slug and `PROMO`, asserting the first five reject and the last parses to `promo` · **after** T1.1.11

#### T5.3.4 · `feat: reject reserved paths in slug validation using the contracts list`
Replace the two literals T1.1.11 inlined (`favicon.ico`, `robots.txt`) with an import of `RESERVED_PATHS` from `packages/contracts/src/reserved.ts` (T0.3.4) — the same array the hot path consumes in T2.1.2, never a copy. A drift between the two lets a user claim a slug that then 404s, and the user has no way to tell which side is wrong.
→ **files** `packages/contracts/src/links.ts` · `packages/contracts/src/links.test.ts` · **verify** `pnpm test contracts/src/links.test.ts` iterates `RESERVED_PATHS` itself and asserts every entry rejects, plus a source assertion that `links.ts` contains no reserved-path string literal · **after** T5.3.3, T0.3.4

#### T5.3.5 · `feat: rioplatense validation messages on the link DTOs`
Every Zod issue on `slug` and `destination` carries the user-facing string directly, so `web` renders the server's message rather than mapping error codes to its own copy: `✕ solo letras, números y guiones`, `✕ no puede empezar ni terminar con guión`, `✕ ese slug está reservado`, `✕ el destino tiene que empezar con http:// o https://`. Rioplatense and lowercase, per POSTA.md §6.
→ **files** `packages/contracts/src/links.ts` · `packages/contracts/src/links.test.ts` · **verify** `pnpm test contracts/src/links.test.ts` asserts each rejection path yields its exact expected Spanish string, and that no message contains a raw Zod default like `Invalid` · **after** T5.3.4

#### T5.3.6 · `feat: map the unique-constraint violation to a clean 409`
Catch SQLSTATE `23505` on the `(tenant_id, slug)` constraint in `links.service.ts` and rethrow as a 409 carrying `✕ ese slug ya existe — probá otro`. Only that constraint maps to 409; any other `23505` keeps propagating, because swallowing an unexpected conflict as "slug taken" turns a schema bug into a confusing user-facing message.
→ **files** `apps/api/src/links/links.service.ts` · `apps/api/src/links/pg-error.ts` · **verify** `pnpm test links.service.test.ts` asserts a duplicate slug for one tenant returns 409 with the exact Spanish body and never 500, and that a `23505` from a different constraint is not converted · **after** T5.3.5, T1.1.5

#### T5.3.7 · `feat: check-slug endpoint with rate limiting`
`GET /v1/links/check-slug?slug=` returns `{ available, reason? }` where `reason` is the same message the DTO would produce. It is explicitly advisory: the row can be claimed between the check and the save, and T5.3.6 remains the arbiter. Rate-limited per session so it cannot be driven as a bulk oracle; because uniqueness is per tenant it only ever discloses the caller's own namespace [INV-9][security].
→ **files** `apps/api/src/links/links.controller.ts` · `apps/api/src/links/check-slug.guard.ts` · **verify** `pnpm test check-slug.test.ts` asserts a free slug returns available, a taken one returns the 409 copy, a reserved one returns the reserved copy, another tenant's identical slug still reads available, and that the rate limit engages · **after** T5.3.6

#### T5.3.8 · `test: concurrent creates of the same slug yield one 201 and one 409`
Integration test on the testcontainer harness (T1.1.2) firing ten simultaneous `POST /v1/links` with the same vanity slug for the same tenant. Asserts exactly one 201, nine 409s, zero 500s, and exactly one row in `links` — the assertion that check-then-insert cannot pass and the unique constraint can.
→ **files** `apps/api/src/links/concurrent-create.test.ts` · **verify** `pnpm test concurrent-create.test.ts` · **after** T5.3.7, T5.4.1

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

#### T5.4.1 · `feat: create link endpoint`
`POST /v1/links` with `LinksModule`, `LinksController` and `LinksService`. Body parsed by the create DTO from `contracts` (T5.3.5); the row is written through `forTenant(tenantId)` (T1.1.9) with `tenantId` taken from the request context (T5.2.4). An omitted slug is allocated by T5.3.2; a supplied one goes straight to the insert. Returns 201 with the created link.
→ **files** `apps/api/src/links/links.controller.ts` · `apps/api/src/links/links.service.ts` · `apps/api/src/links/links.module.ts` · **verify** `pnpm test links.service.test.ts` asserts a created link carries the session's `tenant_id`, that an omitted slug is 7 characters, and that the insert SQL contains `"tenant_id"` · **after** T5.2.4, T5.3.2, T1.1.9

#### T5.4.2 · `feat: get link by id, tenant-scoped` [INV-9][security]
`GET /v1/links/:id` reading through `forTenant()`, so another tenant's id produces no row. That miss returns **404, not 403** — a 403 confirms the id exists and turns the endpoint into an existence oracle. Archived links also 404 here, matching how the redirect path treats them.
→ **files** `apps/api/src/links/links.controller.ts` · `apps/api/src/links/links.service.ts` · **verify** `pnpm test links.service.test.ts` asserts tenant B fetching tenant A's real link id gets 404 with a body identical to a nonexistent id · **after** T5.4.1

#### T5.4.3 · `feat: reject non-http(s) destinations at the endpoint` [security]
Wire the `destination` validator from T1.1.11 into the create and update DTOs and assert it fires at the HTTP boundary, not only in a unit test of the schema. `javascript:`, `data:`, `file:`, protocol-relative `//evil.com` and bare relative paths are 400 before anything reaches the service — a `javascript:` destination behind a 307 is stored XSS with the shortener as the delivery mechanism.
→ **files** `apps/api/src/links/links.controller.ts` · `apps/api/src/links/destination.test.ts` · **verify** `pnpm test destination.test.ts` is table-driven over `javascript:alert(1)`, `data:text/html,x`, `file:///etc/passwd`, `//evil.com`, `/relative`, `ftp://x` and `https://x.com/a?b=c#d`, asserting 400 for the first six and 201 for the last · **after** T5.4.1, T1.1.11

#### T5.4.4 · `feat: reject ssrf-adjacent destination hosts` [security]
`isPrivateHost(url)` in `contracts` rejects `localhost` and any `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`, link-local `169.254.0.0/16` and `fe80::/10`, and the RFC1918 ranges `10/8`, `172.16/12`, `192.168/16` — including the decimal, octal and hex IPv4 encodings that spell the same addresses. Hostnames are deliberately **not** DNS-resolved: resolution is itself an outbound request from our infrastructure and a rebinding target, and the destination is fetched by the visitor's browser, not by us.
→ **files** `packages/contracts/src/links.ts` · `packages/contracts/src/private-host.test.ts` · **verify** `pnpm test private-host.test.ts` asserts every listed form rejects, including `http://2130706433/` and `http://0177.0.0.1/`, and that ordinary public hosts pass · **after** T5.4.3

#### T5.4.5 · `feat: update link endpoint`
`PATCH /v1/links/:id` accepting a partial of `destination`, `title` and `slug`, validated by the update DTO. Scoped through `forTenant()`, so a cross-tenant id 404s like T5.4.2. A slug collision returns the 409 from T5.3.6. Cache invalidation lands next, in T5.4.6 — this task deliberately stops at the database write.
→ **files** `apps/api/src/links/links.controller.ts` · `apps/api/src/links/links.service.ts` · **verify** `pnpm test links.service.test.ts` asserts a partial patch leaves untouched fields unchanged, bumps `updated_at`, and that patching another tenant's id 404s · **after** T5.4.4

#### T5.4.6 · `feat: invalidate the link cache on destination edit, slug change and archive`
Call `invalidateLink()` (T2.2.7) from `links.service.ts` after every mutation, deleting the key for the **old** slug as well as the new one on a rename — otherwise the previous slug keeps resolving from cache to a link that no longer answers there. This is the task people skip, and skipping it is invisible until an hour later.
→ **files** `apps/api/src/links/links.service.ts` · **verify** `pnpm test links.service.test.ts` asserts `invalidateLink` is called once per mutation, and on a rename with both the old and the new cache key · **after** T5.4.5, T2.2.7

#### T5.4.7 · `feat: archive on delete instead of removing the row`
`DELETE /v1/links/:id` sets `archived_at = now()` and never deletes — `events` references the link and the history has to survive the link. Archived links disappear from the list, 404 on `GET :id`, and resolve to 404 on the redirect path rather than to their old destination. A repeat delete is an idempotent 204, not a 404.
→ **files** `apps/api/src/links/links.controller.ts` · `apps/api/src/links/links.service.ts` · **verify** `pnpm test links-archive.test.ts` asserts the row still exists with `archived_at` set, that the redirect path 404s for its slug, and that a second DELETE returns 204 · **after** T5.4.6

#### T5.4.8 · `test: a renamed slug stops resolving and becomes claimable again`
Integration test on the harness: create `promo`, warm the redirect cache by resolving it, `PATCH` the slug to `promo-2026`, then assert the old slug 404s on the hot path immediately and that a *new* link can be created at `promo` for the same tenant. Slug edits free the old name; if the old key survives in Redis, both of those assertions fail in ways the user reads as "the site is broken".
→ **files** `apps/api/src/links/slug-rename.test.ts` · **verify** `pnpm test slug-rename.test.ts` · **after** T5.4.7

#### T5.4.9 · `feat: paginated links list sorted by created_at desc`
`GET /v1/links` with keyset pagination on `(created_at DESC, id)` — matching the index T1.1.5 created, so the query stays an index scan as the table grows rather than an offset that reads and discards. Archived links excluded by default, `?archived=true` to include. Response carries the next cursor, never a total count.
→ **files** `apps/api/src/links/links.controller.ts` · `apps/api/src/links/links.service.ts` · **verify** `pnpm test links-list.test.ts` seeds 50 links, asserts pages do not overlap or skip across the boundary, that archived rows are absent by default, and that `EXPLAIN` shows the `(tenant_id, created_at DESC)` index in use · **after** T5.4.7, T1.1.5

#### T5.4.10 · `feat: attach batched sparklines to the links list` [no N+1]
After the page of links is fetched, pass the whole array of ids to the batched 7-day series query from T4.3.6 — one query for N links, never one per link. A link with no events gets a zero-filled series so the client renders a flat line instead of branching on absence.
→ **files** `apps/api/src/links/links.service.ts` · **verify** `pnpm test links-list.test.ts` counts issued queries with a pg spy and asserts exactly two for a 20-link page — one for the links, one for the sparklines — and that an event-free link returns a 7-point zero series · **after** T5.4.9, T4.3.6

#### T5.4.11 · `test: editing the destination changes the very next redirect`
The end-to-end version of T5.4.6, and the assertion the acceptance criterion actually means: create a link, resolve it through the hot path so the cache is warm, `PATCH` the destination, resolve again in the same test, and assert the `Location` header is the new destination with no wait and no TTL expiry involved.
→ **files** `apps/api/src/links/edit-invalidates-cache.test.ts` · **verify** `pnpm test edit-invalidates-cache.test.ts` — passes with invalidation wired, and fails serving the stale destination when the `invalidateLink` call is removed · **after** T5.4.10, T2.2.4

#### T5.4.12 · `test: cross-tenant access returns 404 on every link endpoint` [INV-9][security]
Table-driven over all five endpoints with tenant B's session against tenant A's link id, asserting 404 in each case and that the body is byte-identical to the body for an id that never existed. A single test per endpoint, enumerated from the controller's route table so a sixth endpoint added later cannot skip the check silently.
→ **files** `apps/api/src/links/cross-tenant.test.ts` · **verify** `pnpm test cross-tenant.test.ts` · **after** T5.4.11, T5.5.1

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

#### T5.5.1 · `test: two-tenant fixture with authenticated sessions`
`seedTwoTenants()` on the testcontainer harness (T1.1.2) creates two full accounts — user, bio page, two links each, and a handful of events per link — and returns an authenticated request agent per tenant carrying a real session cookie from the login flow, not a hand-forged one. Every isolation test below builds on this single fixture rather than reseeding its own.
→ **files** `apps/api/src/test/two-tenants.ts` · `apps/api/src/test/two-tenants.test.ts` · **verify** `pnpm test two-tenants.test.ts` asserts each agent's `GET /v1/links` sees exactly its own two links and that the two `tenant_id` values differ · **after** T5.1.9, T5.4.9

#### T5.5.2 · `test: tenant isolation across the link endpoints` [INV-9]
Reads and mutations both, because a scoped read with an unscoped update is the common half-done version: tenant B cannot list, fetch, patch, archive or check-slug against tenant A's rows, and after every attempted mutation tenant A's row is re-read and asserted byte-identical. Failure to change someone else's data has to be proven, not inferred from a status code.
→ **files** `apps/api/src/links/tenant-isolation.test.ts` · **verify** `pnpm test tenant-isolation.test.ts` · **after** T5.5.1

#### T5.5.3 · `test: tenant isolation across the bio and analytics endpoints` [INV-9]
The same shape applied to the bio page, bio links and every `/v1` analytics query from E4 — summary, series, breakdowns and the recibos feed. Analytics is the easiest place for a missing `tenant_id` to hide, because a leaked row shows up as a slightly wrong number rather than as someone else's data on screen.
→ **files** `apps/api/src/analytics/tenant-isolation.test.ts` · **verify** `pnpm test apps/api/src/analytics/tenant-isolation.test.ts` asserts every analytics endpoint returns zero of tenant A's events for tenant B, including totals · **after** T5.5.2

#### T5.5.4 · `test: assert every tenant-owned table has a non-null tenant_id`
Queries `information_schema.columns` and fails if any tenant-owned table lacks `tenant_id` or has it nullable. The auth-owned tables (`session`, `account`, `verification`, per T1.1.4) and the global `asn_datacenter` reference table (T1.4.1) are explicitly allowlisted with the reason inline — an unexplained exclusion is how a real gap gets normalized.
→ **files** `apps/api/src/test/tenant-columns.test.ts` · **verify** `pnpm test tenant-columns.test.ts` passes on the migrated schema and fails naming the table when a fixture adds a tenant table with a nullable `tenant_id` · **after** T5.5.1

#### T5.5.5 · `test: assert no endpoint reads tenant_id from the request` [INV-9][security]
Scans `apps/api/src/**/*.ts` for `body.tenant`, `query.tenant`, `params.tenant`, `@Body('tenant…')`, `@Query('tenant…')` and `req.headers['x-tenant…']`, allowlisting only `strip-tenant.middleware.ts` — the one file whose job is to name the field in order to delete it. Complements T1.1.10, which bans unscoped table access; this one bans the input that would poison a scoped query.
→ **files** `apps/api/src/test/no-tenant-input.test.ts` · **verify** `pnpm test no-tenant-input.test.ts` passes on the current tree and fails with file and line when a fixture controller reads `req.body.tenant_id` · **after** T5.2.5, T1.1.10

> v1 has one account, so none of this can fail in production yet. That is exactly why it is cheap to build now and expensive to retrofit later — the isolation bugs you cannot see are the ones shipping today.
