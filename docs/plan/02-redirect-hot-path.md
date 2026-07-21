# E2 — Redirect hot path

**Milestone:** M1 · **Depends on:** E1 · **Unblocks:** E3

**Goal:** `juano.posta.lat/promo` 307s in under 15 ms p95 from LATAM, captures every signal classification will ever need, and **still redirects when the queue is dead**.

**Done when:** the invariant suite in S2.6 passes — including redirect-with-queue-down and no-IP-in-payload — and p95 latency is measured, not assumed.

**This epic carries five of the eleven invariants.** Treat simplification pressure here as a signal to stop and re-read the spec.

---

## S2.1 — Host routing, off the Nest router

**As a** visitor **I want** the right thing served for my host and path **so that** bio, links and dashboard coexist on one wildcard domain.

The hot path is a **raw Express middleware mounted before Nest's router**, closing over pre-resolved Redis and queue clients [INV-2]. Nest's DI earns its keep on CRUD below, not here.

**Acceptance:**
- [ ] Middleware registered in `main.ts` ahead of the Nest router
- [ ] Handle parsed from `Host`; `POSTA_LINK_DOMAIN`-driven, never hardcoded
- [ ] Reserved handles rejected: `app`, `api`, `www`, `admin`, `static`, `assets`, `cdn`, `mail`, `blog`, `docs`, `status`
- [ ] Reserved paths bypass slug lookup: `/favicon.ico`, `/robots.txt`, `/.well-known/*`
- [ ] `/` on a handle host is **not** handled by the API — Cloudflare routes it to Next (E8/E10). The API returns 404 if it ever receives it, and that 404 is an alarm, not a page
- [ ] Zero DI, zero decorators, zero per-request instantiation on this path
- [ ] Unknown handle → 404 (S2.5)

**Tasks:**
- [ ] T2.1.1 host parser + `POSTA_LINK_DOMAIN` suffix validation
- [ ] T2.1.2 reserved handle + reserved path lists in `contracts` (shared with slug validation in E5)
- [ ] T2.1.3 mount middleware pre-router [INV-2]
- [ ] T2.1.4 singleton client wiring at boot, not per request
- [ ] T2.1.5 route-shape unit tests incl. malformed and multi-level hosts

> Reserved lists live in `contracts` because E5's "is this slug available?" validation must use the identical list. Two copies drift, and the drift shows up as a user claiming a slug that then 404s.

---

## S2.2 — Slug resolution with cache backfill

**As a** visitor **I want** the destination resolved in one Redis round trip **so that** the redirect is fast.

**Acceptance:**
- [ ] `GET link:{tenant}:{slug}` → `{ link_id, tenant_id, destination }`
- [ ] Miss → Postgres → `SETEX` backfill, TTL 1h
- [ ] Miss in both → 404, and the miss is **cached negatively** for 60s to blunt scans of random slugs
- [ ] Redis unavailable → fall through to Postgres and still serve; log, do not throw
- [ ] Archived links resolve to 404, not to their old destination
- [ ] Cache invalidated on link edit/delete (E5 calls the invalidation; the seam is defined here)

**Tasks:**
- [ ] T2.2.1 cache key scheme + payload shape in `contracts`
- [ ] T2.2.2 Redis lookup with a hard timeout
- [ ] T2.2.3 Postgres fallback query, tenant-scoped
- [ ] T2.2.4 `SETEX` backfill
- [ ] T2.2.5 negative cache for unknown slugs
- [ ] T2.2.6 Redis-down degradation test — must still redirect
- [ ] T2.2.7 exported `invalidateLink()` for E5

> Redis being down must degrade latency, never availability. A shortener that 500s when its cache blinks is worse than one with no cache.

---

## S2.3 — Capture

**As an** analyst **I want** every signal classification will ever need captured at the edge **so that** rules can improve for years without a data rewrite.

**Acceptance:**
- [ ] `event_id` = ULID, assigned **here, once** [INV-8]
- [ ] All spec §5.1 signals read; absent headers stored as `null` (absence is signal)
- [ ] `http_method` captured — `HEAD` is a primary unfurler tell and is trivially lost
- [ ] `purpose` / `x-purpose` / `x-moz` / `sec-purpose` captured — browsers self-declare prefetches, and a prefetch carries a real browser UA
- [ ] `country` from `CF-IPCountry`, falling back to mmdb
- [ ] `asn` from a local **MaxMind GeoLite2-ASN** mmdb lookup, in-memory
- [ ] `visitor_hash = sha256(ip + user_agent + salt).slice(0,32)`
- [ ] Daily salt at `salt:YYYY-MM-DD` in Redis, TTL 48h, generated on first use, cryptographically random
- [ ] **The IP is dropped immediately after hashing** [INV-6] — never stored, never queued, never logged, including in error handlers
- [ ] No cookies set or read. Ever.
- [ ] mmdb loaded once at boot; a missing file fails startup loudly rather than silently degrading

**Tasks:**
- [ ] T2.3.1 header extraction into the `contracts` capture DTO
- [ ] T2.3.2 GeoLite2-ASN download + boot-time load (license + attribution — see risk in spec §14)
- [ ] T2.3.3 ASN + country lookup with fallback ordering
- [ ] T2.3.4 daily salt manager with atomic first-use generation
- [ ] T2.3.5 `visitor_hash` + immediate IP discard [INV-6]
- [ ] T2.3.6 test: no IP anywhere in the payload or logs, error paths included [INV-6]
- [ ] T2.3.7 test: two requests, same visitor, same day → same hash; across a salt rotation → different hash

> The salt rotation means **there is no cross-day unique-visitor metric, ever.** That is the privacy property working. E7 must label it "únicos hoy" and must never imply a longer window.

---

## S2.4 — Redirect, then enqueue

**As a** visitor **I want** my redirect never delayed by analytics **so that** Posta is not slower than the tool it replaces.

**Acceptance:**
- [ ] `res.redirect(307, destination)` — **307, never 301** [INV-3]
- [ ] `queue.add()` is called **after** the response is flushed [INV-1]
- [ ] Enqueue failure is caught, logged and dropped — the redirect already succeeded
- [ ] No `await` between request start and response send, other than the resolution lookup
- [ ] `Cache-Control: no-store` on the redirect so no intermediary caches it
- [ ] Destination taken verbatim from storage; no query-string manipulation at capture (the worker strips it later)

**Tasks:**
- [ ] T2.4.1 307 with no-store [INV-3]
- [ ] T2.4.2 post-response enqueue via `void ... .catch()` [INV-1]
- [ ] T2.4.3 BullMQ producer with a bounded in-flight cap so a queue stall cannot grow unbounded memory
- [ ] T2.4.4 structured logging on enqueue failure (no IP, no secrets)
- [ ] T2.4.5 open-redirect guard — destination must be absolute http(s), validated on write (E5) **and** on read

> Ordering is the whole invariant. Enqueue-then-redirect is a promise; redirect-then-enqueue is a guarantee. If a refactor ever moves the enqueue above the redirect, S2.6 fails — that is the test's entire job.

---

## S2.5 — 404 (the one HTML the API renders)

**As a** visitor **I want** a branded error **so that** a dead link still feels like the product.

**Acceptance:**
- [ ] Terminal shell: `~/posta $ cd /<slug>` → `error: no existe ese link`, blinking lime cursor
- [ ] Dark island styling in all cases — it is never themed (DESIGN.md §1)
- [ ] Static template string, inlined CSS, no framework, no build step, no runtime deps
- [ ] Status 404, `Cache-Control: no-store`
- [ ] Quiet link back to Posta
- [ ] The reflected `<slug>` is **HTML-escaped** — it is attacker-controlled input

**Tasks:**
- [ ] T2.5.1 inline HTML+CSS template
- [ ] T2.5.2 escape the slug [security]
- [ ] T2.5.3 wire to unknown-handle and unknown-slug paths
- [ ] T2.5.4 snapshot test + XSS test with a hostile slug

> This is the single exception to "the API renders no HTML". It stays because a 404 must not depend on Next being up.

---

## S2.6 — The invariant suite

**As a** maintainer **I want** the invariants tested, not documented **so that** a future refactor cannot quietly break the product's core promise.

Integration tests against real Postgres + Redis (testcontainers). Mocks would let every one of these pass while the real thing is broken.

**Acceptance:**
- [ ] **Redirect succeeds while the queue is down** — stop Redis's queue, assert 307 with correct destination [INV-1]
- [ ] **No IP in the queued payload**, in logs, or in any error path [INV-6]
- [ ] **307 not 301**, asserted on status code [INV-3]
- [ ] **`event_id` stable** — one request produces exactly one ULID, carried through unchanged [INV-8]
- [ ] **Latency budget** — p95 under 15 ms on cache hit, measured over ≥1000 local requests
- [ ] **No DI on the hot path** — a test asserts the middleware is registered before the Nest router [INV-2]
- [ ] Cache-miss path: resolves from Postgres, backfills, second request hits cache
- [ ] Reserved handles and paths never reach slug lookup
- [ ] Hostile input: XSS in slug, path traversal, absurdly long slugs, missing `Host`

**Tasks:**
- [ ] T2.6.1 testcontainers harness (Postgres + Redis)
- [ ] T2.6.2 queue-down test [INV-1]
- [ ] T2.6.3 payload + log IP-absence assertions [INV-6]
- [ ] T2.6.4 307 and event_id tests [INV-3][INV-8]
- [ ] T2.6.5 latency benchmark with a failing threshold
- [ ] T2.6.6 middleware-ordering test [INV-2]
- [ ] T2.6.7 hostile input suite
- [ ] T2.6.8 wire all of it into CI

> Two tests here are worth more than the rest combined: **queue-down** and **no-IP**. They guard the promises a user cannot verify for themselves — speed they would notice, but privacy and honesty they simply have to trust.
