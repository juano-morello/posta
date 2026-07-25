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

#### T2.1.1 · `feat: reserved path matching in contracts` ✅ done (`e92cc9f`)
`isReservedHandle(handle)` and `isReservedPath(path)` added to the existing `reserved.ts` from T0.3.4 — the **same** module E5's slug validation uses, never a copy. `isReservedPath` handles both exact matches (`/favicon.ico`, `/robots.txt`) and the `/.well-known/` prefix, which the flat `RESERVED_PATHS` array cannot express on its own. Matching is case-insensitive and ignores a trailing slash.
→ **files** `packages/contracts/src/reserved.ts` · `packages/contracts/src/reserved.test.ts` · **verify** `pnpm test contracts/src/reserved.test.ts` asserts all 11 reserved handles match, `juano` does not, `/.well-known/acme-challenge/abc` matches, `/.well-knownx` does not, and `/FAVICON.ICO` matches · **after** T0.3.4

#### T2.1.2 · `feat: host and path parser for the redirect hot path` ✅ done (`506cd99`)
`parseRequestTarget(host, path)` in `host.ts` returns a discriminated union: `{ kind: 'link', handle, slug }` · `{ kind: 'reserved-path' }` · `{ kind: 'handle-root', handle }` · `{ kind: 'not-ours' }`. It delegates to `parseHandleFromHost` (T0.3.3) and the matchers from T2.1.1, strips a `:port` suffix, lowercases, and reads `POSTA_LINK_DOMAIN` from the validated env — no literal domain anywhere, so T0.3.9 stays green. A pure function: no I/O, no request object, so it is cheap to table-test.
→ **files** `apps/api/src/redirect/host.ts` · `apps/api/src/redirect/host.test.ts` · **verify** `pnpm test redirect/host.test.ts` is table-driven with `POSTA_LINK_DOMAIN` set to a non-production value and covers: valid handle+slug, `app.<domain>` → not-ours, `deep.sub.<domain>` → not-ours, bare `<domain>` → not-ours, an unrelated apex → not-ours, missing/empty `Host`, `HANDLE.<DOMAIN>:8080`, `/` → handle-root, `/favicon.ico` → reserved-path · **after** T2.1.1

#### T2.1.3 · `feat: redis client and key builders in packages/core` ✅ done (`5f627f8`)
The Redis seam every later task shares: an ioredis singleton from `REDIS_URL` with `maxRetriesPerRequest: 1` and `enableOfflineQueue: false` so a dead Redis fails fast instead of queueing commands behind a reconnect, plus `closeRedis()` for test teardown. `keys.ts` owns every key string — `linkKey(tenant, slug)`, `handleKey(handle)`, `saltKey(dateUtc)` — so no key is ever built inline and the keyspace in spec §9 has exactly one definition.
→ **files** `packages/core/src/redis/client.ts` · `packages/core/src/redis/keys.ts` · `packages/core/src/redis/keys.test.ts` · **verify** `pnpm test redis/keys.test.ts` asserts the three key formats and that importing the client twice yields the same instance; a `PING` against the compose Redis returns `PONG` · **after** T0.3.5

#### T2.1.4 · `feat: mount the redirect middleware before the nest router` [INV-2] ✅ done (`e82702e`)
`main.ts` creates the Express instance itself, mounts `createRedirectMiddleware({ redis })` on it, and only then calls `NestFactory.create(AppModule, new ExpressAdapter(server))` — ordering by construction rather than by hoping `app.use()` runs first. The factory is called **once** at boot and closes over the already-connected clients; the returned handler does no allocation beyond the request it is serving. Non-handle hosts call `next()` and fall through to Nest.
→ **files** `apps/api/src/main.ts` · `apps/api/src/redirect/middleware.ts` · `apps/api/src/redirect/middleware.test.ts` · **verify** `pnpm test redirect/middleware.test.ts` boots the app with a catch-all Nest controller returning `nest`; a request to `<handle>.<domain>/promo` never returns that body, while `api.<domain>/v1/ping` does · **after** T2.1.2, T2.1.3

#### T2.1.5 · `feat: short-circuit reserved paths and alarm on handle-root` ✅ done (`0ed4d87`)
Reserved paths answer immediately — 404 with `Cache-Control: no-store`, no Redis GET, no Postgres query, no enqueue. `/` on a handle host means the Cloudflare Origin Rule is misconfigured (spec §14), so it logs at `error` with the handle, increments a `posta_handle_root_hits` counter, and 404s. The counter is the point: a silent 404 here looks like a dead link to the user and like nothing at all to us.
→ **files** `apps/api/src/redirect/middleware.ts` · `apps/api/src/redirect/middleware.test.ts` · **verify** `pnpm test redirect/middleware.test.ts` asserts `redis.get` is never called for `/favicon.ico`, `/robots.txt` and `/.well-known/x`, and that `/` on a handle host emits exactly one `error` log naming the handle and increments the counter · **after** T2.1.4

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

#### T2.2.1 · `feat: cached link payload schema in contracts` [security] ✅ done (`2e562e0`)
`CachedLinkSchema` = `{ link_id, tenant_id, destination }`, with `destination` reusing the absolute-`http(s)` validator from T1.1.11. Every cache read is **parsed, not cast** — a Redis value is untrusted input the moment anything else can write to that instance, and an unparsed `destination` is an open redirect with a TTL. A parse failure is treated as a miss and logged at `warn`.
→ **files** `packages/contracts/src/cache.ts` · `packages/contracts/src/cache.test.ts` · **verify** `pnpm test contracts/src/cache.test.ts` asserts a well-formed payload round-trips, a payload missing `destination` rejects, `javascript:alert(1)` rejects, and non-JSON input rejects without throwing · **after** T1.1.11

#### T2.2.2 · `feat: handle→tenant resolution for the hot path` ✅ done (`8af70bb`)
The cache key is tenant-scoped but the request carries a handle, so `resolveTenant(handle)` bridges the two: a process-local memo (60s, bounded map) → Redis `handle:{handle}` (SETEX 1h) → `SELECT tenant_id FROM bio_pages WHERE handle = $1`. The memo is what keeps the story's "one Redis round trip" true — handles change roughly never, so paying a GET for one on every request would double the round trips for nothing. 60s bounds the staleness window after a handle change.
→ **files** `apps/api/src/redirect/resolve.ts` · `apps/api/src/redirect/resolve.test.ts` · **verify** `pnpm test redirect/resolve.test.ts` asserts a cold call queries Postgres once and SETEXes, a second call within 60s issues zero Redis and zero Postgres commands, and an unknown handle returns `null` · **after** T2.1.3, T1.1.6

#### T2.2.3 · `feat: redis link lookup with a hard timeout` ✅ done (`c1b90c9`)
`lookupCachedLink(tenant, slug)` issues `GET link:{tenant}:{slug}` inside a `Promise.race` against `REDIS_LOOKUP_TIMEOUT_MS` (default 30). A timeout, a connection error or a parse failure all resolve to "miss" and log at `warn` — never throw. A hung Redis must cost latency, not availability, and an unbounded `await` on a half-open socket is exactly how a cache outage turns into a total outage.
→ **files** `apps/api/src/redirect/resolve.ts` · `apps/api/src/redirect/resolve.test.ts` · **verify** `pnpm test redirect/resolve.test.ts` asserts a stub client whose `get` never settles returns a miss in under 50 ms, a stub that rejects returns a miss and logs once, and a valid payload returns the parsed record · **after** T2.2.1, T2.2.2

#### T2.2.4 · `feat: postgres fallback resolution, tenant-scoped and archive-aware` ✅ done (`8b483b8`)
On a miss, one query through the `forTenant` helper from T1.1.9: `SELECT id, tenant_id, destination FROM links WHERE tenant_id = $1 AND slug = $2 AND archived_at IS NULL`. Archived links resolve to nothing — never to their old destination, because a user who archives a link has revoked it and a cache-warm copy honouring it is a bug with a security shape.
→ **files** `apps/api/src/redirect/resolve.ts` · `apps/api/src/redirect/resolve.test.ts` · **verify** `pnpm test redirect/resolve.test.ts` against the T1.1.2 testcontainer asserts a live link resolves, an archived link resolves to `null`, and tenant A's slug is invisible to tenant B · **after** T2.2.3, T1.1.9

#### T2.2.5 · `feat: backfill the link cache on a postgres hit` ✅ done (`da8c416`)
After a Postgres hit, `SETEX link:{tenant}:{slug} 3600 <json>` (TTL from `LINK_CACHE_TTL_SECONDS`, default 3600). The write is fire-and-forget with a `.catch()` — a failed backfill costs the *next* request a Postgres query, and blocking this one on it would trade a guarantee for an optimisation.
→ **files** `apps/api/src/redirect/resolve.ts` · `apps/api/src/redirect/resolve.test.ts` · **verify** `pnpm test redirect/resolve.test.ts` asserts a resolution after a miss leaves a key with `TTL` between 3590 and 3600, that a second request issues zero Postgres queries, and that a rejecting `setex` still returns the destination · **after** T2.2.4

#### T2.2.6 · `feat: negative-cache unknown slugs for 60 seconds` ✅ done (`88d895e`)
Miss in both tiers writes a tombstone (`SETEX ... 60 "\0"`) so a scan over random slugs hits Redis instead of Postgres. `lookupCachedLink` recognises the tombstone and returns "known-absent", distinct from "miss", so a tombstone never falls through to Postgres. 60s, not 3600, so a freshly created link goes live within a minute even if someone probed it first.
→ **files** `apps/api/src/redirect/resolve.ts` · `apps/api/src/redirect/resolve.test.ts` · **verify** `pnpm test redirect/resolve.test.ts` asserts 100 requests for an unknown slug produce exactly one Postgres query, the tombstone's TTL is ≤ 60, and creating the link then waiting out the TTL resolves it · **after** T2.2.5

#### T2.2.7 · `feat: export invalidateLink() as the seam for e5` ✅ done (`a0a36dc`)
`invalidateLink(tenantId, slug)` deletes `link:{tenant}:{slug}` (and `invalidateHandle(handle)` deletes `handle:{handle}`), exported from `packages/core/src/redis/`. E5's link edit, archive and delete call it; defining it here means E5 imports a seam rather than reaching into the keyspace and inventing a second copy of the key format.
→ **files** `packages/core/src/redis/invalidate.ts` · `packages/core/src/redis/invalidate.test.ts` · **verify** `pnpm test redis/invalidate.test.ts` asserts the key is gone after the call, that invalidating an absent key is a no-op returning 0, and that it deletes the tombstone from T2.2.6 too · **after** T2.2.6

#### T2.2.8 · `test: redirect still resolves with redis down` ✅ done (`9ef8675`)
Boots the app, then stops the Redis container mid-suite and asserts requests keep serving 307s from Postgres with a `warn` per degraded lookup and no 5xx — then restarts it and asserts the cache repopulates. Mocking the client would let this pass while the real one blocks on a reconnect, which is precisely the failure being tested.
→ **files** `apps/api/src/redirect/resolve-degraded.test.ts` · **verify** `pnpm test redirect/resolve-degraded.test.ts` asserts 20 requests during the outage all return 307 with the correct `Location`, zero 5xx, and that the first request after recovery re-SETEXes the key · **after** T2.2.7

> Redis being down must degrade latency, never availability. A shortener that 500s when its cache blinks is worse than one with no cache.

> **⚠ Known defect, found by S2.2's story review fan-out (2026-07-24). Unresolved — E5 must close it.**
>
> **The cache writes in this story are not fenced against `invalidateLink()`.** `backfillLinkCache`, `writeLinkTombstone` and `backfillHandleCache` are unconditional `SETEX` writes with no ordering guarantee relative to the `DEL` that `invalidateLink`/`invalidateHandle` issue. A request that reads a link from Postgres moments *before* it is archived can have its fire-and-forget `SETEX` land *after* the archive's `DEL`, repopulating the cache with the now-revoked destination for up to `LINK_CACHE_TTL_SECONDS` (default **3600s**).
>
> This was reproduced empirically against the shipped functions, not merely reasoned about. It has a security shape rather than a staleness shape: **it defeats takedown.** The owner of a scam link controls when they send traffic to their own slug and can approximately time a moderator's archive action, so the race is attacker-repeatable at zero cost until they win it — and each win buys another hour of a revoked destination being served. The symmetric case is milder: a stale tombstone write racing a real backfill suppresses a just-created link for 60s.
>
> **Why it is not fixed here.** The defect lives at the seam between this story's writes and E5's revocation path, and E5 does not exist yet. `invalidateLink()` is only a seam in E2 — nothing calls it. Building compare-and-swap versioning now, with no consumer to validate it against, would be speculative; the fix belongs where the archive/edit mutation actually runs.
>
> **What E5 must do.** Version-stamp the cached payload (e.g. carry `updated_at`/`archived_at`) and make every cache write a compare-and-swap via a Lua `EVAL`, so a write can only land if it is not older than what is already stored, with the archive path writing an authoritative fence no earlier read can beat. A bare `DEL` is not sufficient and must not be treated as if it were. Re-checking `archived_at IS NULL` immediately before the `SETEX` shrinks the window but does not close it, and must not ship as the whole fix. Whatever lands needs its own test proving a late backfill cannot resurrect a revoked destination.
>
> Invariant note: this does not violate an existing numbered invariant, which is itself the finding — "archiving revokes" is relied on by S2.2's acceptance criteria and by E5, but is nowhere stated as an invariant. Consider promoting it.

---

## S2.3 — Capture

**As an** analyst **I want** every signal classification will ever need captured at the edge **so that** rules can improve for years without a data rewrite.

**Acceptance:**
- [ ] `event_id` = ULID, assigned **here, once** [INV-8]
- [ ] All spec §5.1 signals read; absent headers stored as `null` (absence is signal)
- [ ] `http_method` captured — `HEAD` is a primary unfurler tell and is trivially lost
- [ ] `purpose` / `x-purpose` / `x-moz` / `sec-purpose` captured — browsers self-declare prefetches, and a prefetch carries a real browser UA
- [ ] `country` from `CF-IPCountry`, falling back to mmdb
- [ ] `asn` from a local **DB-IP ASN** mmdb lookup, in-memory
- [ ] `visitor_hash = sha256(ip + user_agent + salt).slice(0,32)`
- [ ] Daily salt at `salt:YYYY-MM-DD` in Redis, TTL 48h, generated on first use, cryptographically random
- [ ] **The IP is dropped immediately after hashing** [INV-6] — never stored, never queued, never logged, including in error handlers
- [ ] No cookies set or read. Ever.
- [ ] mmdb loaded once at boot; a missing file fails startup loudly rather than silently degrading

**Tasks:**

#### T2.3.1 · `feat: capture event dto in contracts` [INV-6][INV-8] ✅ done (`2b3608b`)
`CaptureEventSchema` — the queue payload and the row shape the worker writes: `event_id` (ULID), `occurred_at` (ISO), `tenant_id`, `link_id`, `slug`, plus every spec §5.1 signal as `string | null` and `asn` as `number | null`. Nullable, not optional: a missing header must serialise as an explicit `null`, because "we did not see this header" is the evidence rule 3 of the view runs on, and an omitted key is indistinguishable from a lost one. The schema is `.strict()`, so an `ip` field cannot be added without the test in this task failing.
→ **files** `packages/contracts/src/capture.ts` · `packages/contracts/src/capture.test.ts` · **verify** `pnpm test contracts/src/capture.test.ts` asserts the key set matches spec §5.1 exactly, that no key matches `/ip|addr|forwarded|cookie/i`, that an extra key rejects, and that an all-null signal payload parses · **after** T1.1.3

#### T2.3.2 · `feat: header extraction into the capture dto` ✅ done (`af328d4`)
`readSignals(req)` in `capture.ts` reads the 18 signals by explicit name — never by spreading `req.headers`, which would drag `cookie` and `x-forwarded-for` into the payload the first time someone widens the type. Absent → `null`. `http_method` comes from `req.method` and `sec-purpose` / `purpose` / `x-purpose` / `x-moz` are read as a group, since those four are the prefetch tells that do the most work in classification and are the easiest to drop in a refactor.
→ **files** `apps/api/src/redirect/capture.ts` · `apps/api/src/redirect/capture.test.ts` · **verify** `pnpm test redirect/capture.test.ts` asserts a request carrying only `Host` yields every signal `null`; a `HEAD` with `x-moz: prefetch`, `purpose: prefetch` and `sec-purpose: prefetch` yields exactly those four set; and a request with a `Cookie` header yields a payload with no cookie value anywhere · **after** T2.3.1

#### T2.3.3 · `chore: db-ip download script with attribution` ✅ done (`ed81d08`)
`scripts/fetch-geoip.sh` pulls **`dbip-asn-lite` and `dbip-country-lite`** (the ASN database carries no country, so the CF-IPCountry fallback in spec §5.2 needs both) and extracts them to `GEOIP_DB_DIR`.

> **Corrected 2026-07-24 (T2.3.3).** This task originally said the script "verifies the published checksum", and its verify line asked for checksums matching "the published values". **DB-IP publishes no checksum for the free lite databases** — confirmed by probing `download.db-ip.com/free/`, `db-ip.com/db/lite.php`, `db-ip.com/faq.php` and direct `.sha256`/`.sha256sum`/`.md5`/`.sig`/`.asc`/`CHECKSUMS` paths. The requirement was unsatisfiable as written. What the script actually does is verify each download **parses as a real MMDB** with the `maxmind` reader — a validity check that catches truncation and corruption, but not a publisher-integrity check. Integrity therefore rests on HTTPS transport alone. Residual risk, accepted knowingly: a compromised or MITM'd download yields wrong ASN/country data, degrading classification rule 6 rather than causing code execution, since the file is only ever read by the MMDB parser. Pinning a hash of the current release was considered and rejected — DB-IP re-publishes monthly and image rebuilds pull whatever is current, so a pin would break every month to defend against something TLS already covers. No account and no licence key — DB-IP lite is CC BY 4.0, which is exactly why it can be baked into the container image in T0.7.x with no Secret and no init container. The required attribution line goes in the bio-page footer and the README.
→ **files** `scripts/fetch-geoip.sh` · `README.md` · **verify** running the script from clean leaves two `.mmdb` files whose checksums match the published values, and `git status` stays clean (`*.mmdb` is git-ignored from T0.1.1) · **after** T0.3.11

#### T2.3.4 · `feat: boot-time mmdb loader that fails startup loudly` ✅ done (`9611f8f`)
`openGeoDatabases()` reads both mmdb files once at boot into memory and returns a frozen `{ asn, country }` reader pair, called from the API entrypoint before `listen`. The reader is the `maxmind` npm package — named for the format's originator, but it reads any `.mmdb` file, DB-IP's included. The publisher is a download-script choice (T2.3.3), not a code dependency. A missing, unreadable or corrupt file throws naming the path **and** the env var that points at it. Silent degradation is the failure mode to design against: an API that boots with no ASN reader produces `asn: null` on every event, and rule 6 of the classification view then never fires — a broken product that looks healthy.
→ **files** `packages/core/src/geoip/loader.ts` · `packages/core/src/geoip/loader.test.ts` · **verify** `pnpm test geoip/loader.test.ts` asserts a missing path throws with the path and env var in the message, a truncated file throws rather than returning a reader, and two calls return the identical object · **after** T2.3.3

#### T2.3.5 · `feat: asn and country lookup with cf-ipcountry fallback ordering` ✅ done (`39f7821`)
`lookupNetwork(ip, cfCountry)` in `geoip/lookup.ts`: country is `CF-IPCountry` when present and not a placeholder (`XX`, `T1`), else the mmdb country, else `null`; `asn` is always the mmdb ASN lookup. Private, loopback, link-local and malformed addresses return `{ asn: null, country: <cf ?? null> }` rather than throwing — a geoip failure must never cost a redirect, and local traffic in dev must not crash the path.
→ **files** `packages/core/src/geoip/lookup.ts` · `packages/core/src/geoip/lookup.test.ts` · **verify** `pnpm test geoip/lookup.test.ts` is table-driven over a known public IP (asserting a specific ASN), `127.0.0.1`, `::1`, `10.0.0.1`, `not-an-ip` and `""`, each with `CF-IPCountry` present, absent and `XX` · **after** T2.3.4

#### T2.3.6 · `feat: daily salt manager with atomic first-use generation` ✅ done (`e7f0034`)
`getDailySalt()` in `redis/salt.ts`: key `salt:YYYY-MM-DD` on the **UTC** date, `SET key <32 crypto-random bytes hex> NX EX 172800` followed by a `GET`, so two instances racing on first use converge on one value instead of splitting the day's hashes. A process-local memo keyed by date keeps the hot path off Redis after the first request. If Redis is unreachable, it reuses the current day's memoised salt, and only if there is none generates a process-local one, logging at `error` — hashes stay computable, they just stop matching across instances for that window.
→ **files** `packages/core/src/redis/salt.ts` · `packages/core/src/redis/salt.test.ts` · **verify** `pnpm test redis/salt.test.ts` asserts 50 concurrent calls return one identical value with one `SET NX` issued, the key TTL is within 60s of 172800, a second call issues no Redis command, and a Redis outage still returns a 64-char salt while logging once · **after** T2.1.3

#### T2.3.7 · `feat: visitor_hash and immediate ip discard` [INV-6][security] ✅ done (`c7a440d`)
The client IP is read once from `CF-Connecting-IP` (falling back to the leftmost `X-Forwarded-For` entry), passed to `lookupNetwork` and to `computeVisitorHash(ip, userAgent, salt)` = `sha256(ip + ua + salt).hex.slice(0, 32)`, and never leaves that function's scope. > **Hash formula amended 2026-07-25.** The bare concatenation stated here and in spec §5.3 collides at the field boundaries (`ip="1.2.3.4"`+`ua="Ax"` hashes the same as `ip="1.2.3.4A"`+`ua="x"`), collapsing two visitors into one bucket. The shipped formula inserts a `NUL` delimiter between fields: `sha256(ip + NUL + ua + NUL + salt)`. Safe because Node's HTTP parser rejects a `NUL` in a header value with 400 before app code runs (verified over a raw socket, no `--insecure-http-parser` in this repo) and the salt is hex. Free because nothing ever recomputes a `visitor_hash` — the raw IP is never stored, so no second implementation exists to drift. See spec §5.3 for the full amendment.

`buildCapturePayload()` takes the *derived* values — `visitor_hash`, `asn`, `country` — as parameters, so there is no call path along which an IP can reach the payload builder, the queue, or a log line. This is structural, not a convention: the type of the payload builder does not admit an IP.
→ **files** `apps/api/src/redirect/capture.ts` · `apps/api/src/redirect/capture.test.ts` · **verify** `pnpm test redirect/capture.test.ts` asserts the hash is 32 lowercase hex chars, same ip+ua+salt is stable, a changed UA or salt changes it, and that `buildCapturePayload`'s TypeScript signature accepts no IP-typed argument (a `@ts-expect-error` case) · **after** T2.3.2, T2.3.5, T2.3.6

#### T2.3.8 · `test: no ip in the built payload or in any log path` [INV-6][security] ✅ done (`49bf7b9`)
Drives capture with a distinctive IP (`203.0.113.77`) through the happy path, a geoip lookup that throws, a salt fetch that throws, and a payload-build that throws, capturing every log line emitted. Asserts the octet string appears in none of them and that `JSON.stringify(payload)` contains no key matching `/ip|addr|forwarded|cookie/i`. Error handlers are the specific gap this closes — the usual way an IP leaks is a `catch` that logs the whole request.
→ **files** `apps/api/src/redirect/capture-privacy.test.ts` · **verify** `pnpm test redirect/capture-privacy.test.ts` passes, and fails when a fixture handler is patched to `log.error({ req })` · **after** T2.3.7

#### T2.3.9 · `test: visitor_hash stability within a day and across a rotation` ✅ done (`d9661dd`)
Two requests from the same IP+UA on the same UTC day produce one hash; the same visitor after the clock is advanced past midnight UTC produces a different one; two UAs from one IP produce different hashes; two IPs with one UA produce different hashes. This is the test that makes the "únicos hoy" claim in E7 true rather than aspirational.
→ **files** `apps/api/src/redirect/visitor-hash.test.ts` · **verify** `pnpm test redirect/visitor-hash.test.ts` asserts all four cases using fake timers to cross the UTC date boundary and a real Redis for the salt · **after** T2.3.8

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

#### T2.4.1 · `feat: 307 redirect with cache-control no-store` [INV-3]
The response half of the middleware: `res.setHeader('Cache-Control', 'no-store')` then `res.redirect(307, destination)`, with the destination taken verbatim from the resolved record — no query-string rewriting, no UTM injection, no normalisation. The worker strips query strings later for `dest_host`; doing it here would change where the visitor actually lands.
→ **files** `apps/api/src/redirect/middleware.ts` · `apps/api/src/redirect/redirect-response.test.ts` · **verify** `pnpm test redirect/redirect-response.test.ts` asserts the status is exactly 307 (explicitly not 301, 302 or 308), `Location` byte-equals a stored destination containing `?a=1&b=2#frag`, and `Cache-Control` is `no-store` · **after** T2.2.5

#### T2.4.2 · `feat: bullmq producer with a bounded in-flight cap`
`enqueue.ts` creates the `events` Queue once at boot and exports `enqueueCapture(payload)` with `removeOnComplete` / `removeOnFail` set so the producer cannot grow Redis unboundedly. An in-flight counter capped at `MAX_INFLIGHT_ENQUEUES` (default 1000) drops and counts instead of accumulating promises — a stalled queue must cost events, never the process. Dropped events increment `posta_enqueue_dropped_total`.
→ **files** `apps/api/src/redirect/enqueue.ts` · `apps/api/src/redirect/enqueue.test.ts` · **verify** `pnpm test redirect/enqueue.test.ts` with a stub whose `add` never settles asserts the 1001st call returns synchronously, the dropped counter reads 1, and in-flight never exceeds 1000 · **after** T2.3.1, T2.1.3

#### T2.4.3 · `feat: enqueue after the response is flushed` [INV-1]
Ordering is the invariant: resolve → build payload → `res.redirect(307, …)` → **then** `void enqueueCapture(payload).catch(logEnqueueFailure)`. No `await` sits between request entry and `res.redirect` other than the resolution lookup. Enqueue-then-redirect is a promise; redirect-then-enqueue is a guarantee, and the difference is invisible until the queue is slow.
→ **files** `apps/api/src/redirect/middleware.ts` · `apps/api/src/redirect/ordering.test.ts` · **verify** `pnpm test redirect/ordering.test.ts` records a timeline and asserts the `res.end` timestamp strictly precedes the first `queue.add` call, and that a `queue.add` returning a promise that rejects after 500 ms still leaves a 307 delivered in under 15 ms · **after** T2.4.1, T2.4.2

#### T2.4.4 · `feat: structured enqueue-failure logging without ip or secrets` [security]
`logEnqueueFailure(err, ctx)` logs `event_id`, `tenant_id`, `slug`, error name and message, and nothing else — never the payload, never the request, and never a connection string. `REDIS_URL` carries a password and ioredis embeds it in connection error messages, so the message is passed through a redactor before it is written.
→ **files** `apps/api/src/redirect/enqueue.ts` · `apps/api/src/redirect/enqueue-logging.test.ts` · **verify** `pnpm test redirect/enqueue-logging.test.ts` forces a failure whose message embeds `redis://user:s3cret@host:6379` and asserts the log contains `event_id`, contains no `s3cret`, and contains no capture-signal values · **after** T2.4.3, T0.3.10

#### T2.4.5 · `feat: read-time open-redirect guard on the resolved destination` [security]
Validation on write (T1.1.11) is not enough: the value reaching `res.redirect` may have come from Redis, which is a second writer. A destination failing the absolute-`http(s)` check is refused — 404 via S2.5, an `error` log naming `link_id` and the rejected scheme, and no `Location` header at all. Cheap on the hot path (one regex), and the alternative is shipping an open redirect the moment a cache entry is poisoned.
→ **files** `apps/api/src/redirect/middleware.ts` · `apps/api/src/redirect/open-redirect.test.ts` · **verify** `pnpm test redirect/open-redirect.test.ts` plants `javascript:alert(1)`, `//evil.com`, `data:text/html,x` and `/relative` directly into Redis and then directly into Postgres, asserting 404, no `Location`, and one `error` log for each of the eight cases · **after** T2.4.1, T1.1.11

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

#### T2.5.1 · `feat: html escape helper for the 404 page` [security]
`escapeHtml(s)` escaping `&`, `<`, `>`, `"`, `'` and `/`, plus a length clamp so a 4 KB slug cannot inflate the response. Its own module and its own test because it is the single control standing between attacker-controlled path input and an HTML document — the one place in this epic where a one-character mistake is a stored-XSS-shaped bug.
→ **files** `apps/api/src/redirect/escape-html.ts` · `apps/api/src/redirect/escape-html.test.ts` · **verify** `pnpm test redirect/escape-html.test.ts` is table-driven over `</script>`, `"><img src=x onerror=alert(1)>`, `'; alert(1); //`, `&amp;` (asserting double-escaping), a 10 KB string (asserting the clamp) and multibyte input · **after** —

#### T2.5.2 · `feat: inline 404 template, dark island, terminal shell`
`renderNotFound(slug)` returns a complete HTML document as a template string: inline `<style>`, no framework, no build step, no runtime dependency, no external request of any kind. Dark island tokens from DESIGN.md §1 are written as literal hex here because this file deliberately cannot reach the token pipeline — it must render when everything else is down. Terminal shell `~/posta $ cd /<slug>` over `error: no existe ese link`, blinking lime cursor via a CSS `steps()` animation, and a quiet link home built with `buildAppUrl()` (T0.3.3) so no literal domain appears.
→ **files** `apps/api/src/redirect/not-found.ts` · `apps/api/src/redirect/not-found.test.ts` · **verify** `pnpm test redirect/not-found.test.ts` snapshots the output and asserts it contains no `<script>`, no `http` URL other than the one built from env, no `src=`/`href=` to an external host, and is under 4 KB · **after** T2.5.1

#### T2.5.3 · `feat: serve the 404 for unknown handle, unknown slug and reserved paths`
Wires `renderNotFound` into every terminal branch of the middleware — unknown handle, unknown slug, archived link, reserved path, handle-root, rejected destination — with status 404, `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-store`. A 404 **never enqueues**: there is no `link_id` to attach, and `events.link_id` is `NOT NULL` by design (T1.2.2), so a 404 event has nowhere to go and no meaning if it did.
→ **files** `apps/api/src/redirect/middleware.ts` · `apps/api/src/redirect/not-found-routing.test.ts` · **verify** `pnpm test redirect/not-found-routing.test.ts` asserts all six branches return 404 with the rendered body and the right headers, and that `queue.add` was called zero times across all of them · **after** T2.5.2, T2.4.5

#### T2.5.4 · `test: a hostile slug cannot inject html into the 404` [security]
End-to-end through the real route rather than against `renderNotFound` directly, because the risk is a future refactor that reflects the raw `req.path` somewhere the escaper does not cover. Payloads: `<script>alert(1)</script>`, `"><svg onload=alert(1)>`, `%3Cscript%3E` (asserting the decoded form is escaped too), a null byte, and a 4 KB slug.
→ **files** `apps/api/src/redirect/not-found-xss.test.ts` · **verify** `pnpm test redirect/not-found-xss.test.ts` parses each response body and asserts zero `script` elements and zero `on*` attributes originating from the payload, and that the raw payload string never appears unescaped · **after** T2.5.3

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

#### T2.6.1 · `test: hot-path integration harness with postgres and redis`
Extends the testcontainers helper from T1.1.2 with a Redis 7 container using the same `docker/redis.conf` as compose (so `volatile-lru` holds in tests too, per T0.4.2), boots the real Express+Nest app on an ephemeral port with env pointed at both, seeds one tenant + handle + link, and returns `{ baseUrl, db, redis, queue, logs, stop }`. Every test in S2.6 reuses this one harness rather than each booting its own stack.
→ **files** `apps/api/src/redirect/test/hot-path-harness.ts` · `apps/api/src/redirect/test/hot-path-harness.test.ts` · **verify** `pnpm test hot-path-harness.test.ts` performs one request against the seeded link, asserts a 307 and exactly one job on the `events` queue, and that `stop()` releases both containers and the port · **after** T2.5.3, T1.1.2

#### T2.6.2 · `test: redirect succeeds while the queue is down` [INV-1]
The single highest-value test in the epic. Points the BullMQ producer at a closed port after boot (and separately stops the Redis container outright), then asserts 50 requests all return 307 with the correct `Location`, that latency does not degrade past the budget, that one enqueue-failure log is emitted per request with no IP, and that `process.on('unhandledRejection')` fired zero times — a `void`ed promise with a missing `.catch()` is exactly how this invariant dies quietly.
→ **files** `apps/api/src/redirect/test/queue-down.test.ts` · **verify** `pnpm test queue-down.test.ts` asserts 50/50 responses are 307 with the right destination, zero 5xx, zero unhandled rejections, and that the process is still serving after the outage ends · **after** T2.6.1

#### T2.6.3 · `test: no ip in the queued payload or logs, end to end` [INV-6][security]
Complements the unit-level check in T2.3.8 by reading the **actual job data** off the queue: sends requests with `CF-Connecting-IP` and `X-Forwarded-For` set to distinctive values, drains the queue, and asserts the octets appear in no job, no log line and no queue key name — including runs where the geoip lookup and the enqueue both throw. Only the integration form can catch an IP smuggled in via a BullMQ job option or job id.
→ **files** `apps/api/src/redirect/test/no-ip.test.ts` · **verify** `pnpm test no-ip.test.ts` asserts the IP strings are absent from `JSON.stringify(job)` for every job, from captured logs, and from `KEYS *` output · **after** T2.6.2

#### T2.6.4 · `test: 307 never 301, and one stable event_id per request` [INV-3][INV-8]
Asserts the status is exactly 307 on a cache hit, on a cache miss, on a `HEAD` request and on a request carrying a prefetch header — every path that could plausibly acquire its own response branch. Then asserts one request produces exactly one job whose `event_id` is a 26-char ULID, and that the id in the job byte-equals the one the middleware logged, proving it is assigned once at capture and never regenerated downstream.
→ **files** `apps/api/src/redirect/test/status-and-event-id.test.ts` · **verify** `pnpm test status-and-event-id.test.ts` asserts `=== 307` in all four cases and that 100 requests yield 100 jobs with 100 distinct 26-char ULIDs · **after** T2.6.1

#### T2.6.5 · `test: reserved handles and paths never reach slug lookup`
Spies on the Redis client and the pg pool, then issues requests for all 11 reserved handles and for `/favicon.ico`, `/robots.txt` and `/.well-known/acme-challenge/x`. Asserts zero `GET link:*` and zero `SELECT ... FROM links` for every one — the acceptance criterion is about *not doing work*, so asserting the response alone would pass even if the lookup ran first and the answer was discarded.
→ **files** `apps/api/src/redirect/test/reserved.test.ts` · **verify** `pnpm test reserved.test.ts` asserts 14 requests produce zero link lookups and zero Postgres queries, all returning 404 · **after** T2.6.1

#### T2.6.6 · `test: cache miss backfills and the second request is a hit`
Flushes Redis, issues one request (asserting exactly one Postgres query and a `SETEX` with a TTL near 3600), then issues a second (asserting zero Postgres queries and the same destination). Also asserts the negative-cache path: an unknown slug requested 50 times produces one Postgres query and a tombstone with TTL ≤ 60.
→ **files** `apps/api/src/redirect/test/cache-backfill.test.ts` · **verify** `pnpm test cache-backfill.test.ts` asserts the query counts, the two TTL ranges, and that both requests return identical `Location` headers · **after** T2.6.1

#### T2.6.7 · `test: the middleware is registered before the nest router` [INV-2]
Walks the Express instance's router stack and asserts the redirect layer's index is lower than Nest's router layer, then proves it behaviourally: a Nest controller registered at `/:slug` is never reached on a handle host. Also asserts `createRedirectMiddleware` is invoked exactly once per process, which is what "zero per-request instantiation" actually means in a form CI can check.
→ **files** `apps/api/src/redirect/test/middleware-order.test.ts` · **verify** `pnpm test middleware-order.test.ts` asserts the stack index ordering, that the colliding Nest route returns its body on `api.<domain>` but never on a handle host, and that the factory call count is 1 after 200 requests · **after** T2.6.1

#### T2.6.8 · `test: hostile input suite for the hot path`
One table, one job: assert the hot path answers 4xx and never 5xx, never reflects unescaped input, and never throws. Cases: XSS payload as slug, `../../etc/passwd`, `%2e%2e%2f` encoded traversal, a 4 KB slug, a null byte, a missing `Host` header, two `Host` headers, `Host` with a port, a punycode handle, an empty path, and a slug of only slashes.
→ **files** `apps/api/src/redirect/test/hostile-input.test.ts` · **verify** `pnpm test hostile-input.test.ts` asserts every case returns 400 or 404, zero 5xx, zero unhandled rejections, and that no response body contains the raw payload unescaped · **after** T2.6.1, T2.5.4

#### T2.6.9 · `perf: assert p95 under 15ms on a cache hit`
Warms the cache, then issues ≥1000 sequential requests against the harness, records per-request wall time, and **fails** when p95 ≥ `HOT_PATH_P95_BUDGET_MS` (15). Prints p50/p95/p99 and the miss/hit split so a regression report is readable. The measurement is loopback service time — it excludes the LATAM network leg the spec's 15 ms budget also covers, which means passing here is necessary and not sufficient; the deploy-time check belongs to E10.
→ **files** `apps/api/src/redirect/test/latency.test.ts` · **verify** `pnpm test latency.test.ts` fails when the budget env is set to 0.1 and passes at 15 on the current tree, printing all three percentiles · **after** T2.6.6

#### T2.6.10 · `ci: run the hot-path invariant suite on every pr`
Adds a `hot-path` job to the workflow using the Postgres and Redis service containers from T0.5.2, running the S2.6 specs and failing the build on any of them. Without this the suite is documentation with extra steps — the invariants it guards are exactly the ones nobody re-runs by hand.
→ **files** `.github/workflows/ci.yml` · **verify** the job is green on a PR against the current tree, and goes red on a branch that moves the `queue.add` call above `res.redirect` · **after** T2.6.9, T0.5.2

> Two tests here are worth more than the rest combined: **queue-down** and **no-IP**. They guard the promises a user cannot verify for themselves — speed they would notice, but privacy and honesty they simply have to trust.
