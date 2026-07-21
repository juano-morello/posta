# Posta v1 — Design Spec

**Date:** 2026-07-21 · **Status:** approved · **Supersedes:** conflicting statements in `CLAUDE.md` §invariant-11, `POSTA.md` §0

Posta is an honest-analytics link shortener + link-in-bio, Spanish/LATAM-first, built in public by JuanoDev.

**Thesis:** every other shortener counts bots, link-preview unfurlers and prefetches as "clicks" and shows an inflated number. Posta filters them out, shows the real humans plus the honest split, with no cookies. **The number is the product.**

---

## 1. Scope

**v1 ships:** short links (random + vanity slugs) on per-user subdomains · a link-in-bio page (avatar, name, bio, ordered list of tracked links, 2–3 themes) · an honest-analytics dashboard · one seeded account.

**Explicitly not in v1:** custom domains (v1.5) · public signup · billing · API keys + MCP (v2) · columnar analytics store · QR codes · smart routing · teams/orgs.

`tenant_id == user_id` for v1. The schema is multi-tenant; exactly one account is seeded.

---

## 2. Decisions resolved during design

The four source documents disagreed on three points. Resolved as follows.

| # | Conflict | Resolution |
|---|---|---|
| 1 | URL shape: `posta.lat/:slug` (POSTA.md) vs `<handle>.<domain>/:slug` (CLAUDE.md) | **`<handle>.posta.lat/:slug`.** Slug is `UNIQUE (tenant_id, slug)`. |
| 2 | Tailwind+shadcn (DESIGN.md) vs SCSS (POSTA.md §8) | **Tailwind + shadcn/ui.** One SCSS token file emits CSS custom properties; Tailwind reads them. |
| 3 | Bio rendered by API (CLAUDE.md inv. 11) vs SSR (POSTA.md §7) | **Next renders the bio.** Invariant 11 is amended — see §11. |

### 2.1 Required amendments to existing docs

These are follow-up edits, tracked as tasks in **E0**:

- **`CLAUDE.md` invariant 11** — currently "Bio pages are rendered by the API as cached HTML templates with OG tags — not by Next. `web` is the dashboard only." Replace with the §11 text below.
- **`POSTA.md` §0** — short-link domain reads `posta.lat/<slug>`; bio subdomain reads `juano.lbt.works`. Both are wrong. Links are `juano.posta.lat/<slug>`; the bio is `juano.posta.lat/`.
- **`POSTA.md` §2 microcopy** — every `posta.lat/promo` example becomes `juano.posta.lat/promo`. This is *longer*, which affects the links-list row layout: the list truncates the handle prefix to `…/promo` and shows the full host on hover and in the copy action.

---

## 3. Topology

```
                    ┌─────────────────────────────┐
   *.posta.lat ────▶│ Cloudflare (proxied, free)  │
                    │  Origin Rule: path == "/"   │
                    └──────┬───────────────┬──────┘
                     "/"   │               │  everything else
                           ▼               ▼
                   ┌──────────────┐  ┌──────────────────┐
   app.posta.lat ─▶│ apps/web     │  │ apps/api         │
                   │ Next.js      │  │ NestJS · SP      │
                   │ dashboard    │  │ redirect + CRUD  │
                   │ + bio (SSG)  │  └────┬────────┬────┘
                   └──────────────┘       │        │
                                     ┌────▼───┐ ┌──▼──────┐
                                     │ Redis  │ │Postgres │
                                     │cache + │ │ São     │
                                     │BullMQ  │ │ Paulo   │
                                     └────┬───┘ └──▲──────┘
                                          │        │
                                    ┌─────▼────────┴─┐   ┌────────┐
                                    │ apps/worker    │──▶│ R2     │
                                    │ NestJS consumer│   │ NDJSON │
                                    └────────────────┘   └────────┘
```

### 3.1 Routing table

| Host | Path | Served by | Notes |
|---|---|---|---|
| `<handle>.posta.lat` | `/` | **Next** (SSG + ISR) | bio page, CDN-cached |
| `<handle>.posta.lat` | `/:slug` | **API** | 307 redirect, hot path |
| `<handle>.posta.lat` | `/favicon.ico`, `/robots.txt` | API | reserved paths, never slug lookups |
| `app.posta.lat` | `/*` | **Next** | dashboard, auth-gated |
| `api.posta.lat` | `/v1/*` | API | CRUD + analytics, auth-gated |

The path split on `<handle>.posta.lat` is a **Cloudflare Origin Rule**, not an edge router or Worker. The rule matches only `path == "/"` and rewrites the origin to Next. `/:slug` reaches the API origin directly with **no added hop** — the hot path is untouched.

**Reserved handles:** `app`, `api`, `www`, `admin`, `static`, `assets`, `cdn`, `mail`, `blog`, `docs`, `status`.

### 3.2 Dependency arrows (one-way, lint-enforced)

```
packages/contracts   Zod types/DTOs. Isomorphic, zero server deps.
packages/core        SERVER-ONLY: Drizzle schema, db + R2 clients, enrichment.
apps/api    → core, contracts
apps/worker → core, contracts
apps/web    → contracts          ONLY
```

`web` now serves public traffic and needs bio data. It gets it by **HTTP call to the API**, not by import — so `web → contracts only` still holds. A lint rule fails the build if `web` imports `core`.

---

## 4. The redirect hot path

**Invariant: a redirect never blocks on analytics.** This is made structural rather than aspirational by enqueuing *after* the response is sent.

The hot path is **not a Nest controller**. It is a raw Express middleware mounted in `main.ts` before Nest's router, closing over pre-resolved Redis and queue clients. Nest's DI earns its keep on CRUD below it, not here.

```
GET juano.posta.lat/promo

1. parse handle from Host, slug from path
2. reject reserved paths
3. Redis  GET link:{tenant}:{slug}          → { link_id, tenant_id, dest }
     miss → Postgres SELECT → SETEX backfill (TTL 1h)
     miss → 404 page
4. capture:
     event_id = ULID()          (assigned once, here — invariant 8)
     read request-only headers  (see §5)
     country = CF-IPCountry  |  mmdb lookup
     asn     = mmdb lookup on the IP
     visitor_hash = sha256(ip + user_agent + daily_salt).slice(0,32)
     DROP the IP                (invariant 6 — never stored, never queued)
5. res.redirect(307, dest)      ◀── response is sent HERE
6. void queue.add(payload).catch(logAndDrop)
```

Step 6 runs after the response has been flushed, so a slow or dead Redis cannot delay or fail the redirect. If the enqueue throws, the event is lost and the redirect still succeeded — the correct trade.

**307, never 301.** A 301 is cached by the browser and would silently kill both analytics and destination edits.

### 4.1 Latency budget

| Step | Budget |
|---|---|
| Redis cache hit | < 2 ms |
| mmdb ASN + country lookup | < 50 µs (in-memory) |
| sha256 visitor_hash | < 10 µs |
| **Total to first byte (cache hit)** | **< 15 ms p95 from LATAM** |
| Postgres fallback (cache miss) | < 40 ms, then backfilled |

Redis and Postgres **must** be co-located in São Paulo. A hot path that hops to us-east for a cache read makes the latency claim false.

---

## 5. Capture & privacy

### 5.1 Signals captured

Raw signals only. **No verdict is computed or stored** (invariant 4) — the verdict is a read-time view (§7).

| Group | Fields |
|---|---|
| Request | `http_method`, `user_agent`, `referer`, `accept`, `accept_language` |
| Fetch metadata | `sec_fetch_site`, `sec_fetch_mode`, `sec_fetch_dest`, `sec_fetch_user`, `sec_purpose` |
| Client hints | `sec_ch_ua`, `sec_ch_ua_mobile`, `sec_ch_ua_platform` |
| Prefetch tells | `purpose`, `x_purpose`, `x_moz` |
| Network | `country`, `asn` |
| Identity | `visitor_hash` |

Two signals do disproportionate work and are easy to forget:

- **`http_method`** — a `HEAD` request is never a human clicking a link. It is a very strong unfurler signal.
- **`purpose` / `x-moz` / `sec-purpose`** — browsers *self-declare* prefetches. A Chrome prefetch carries a legitimate Chrome UA and would otherwise sail through as human. This must be checked **before** any UA-based rule.

### 5.2 ASN without a Cloudflare Worker

`CF-IPCountry` is free on a proxied domain, but ASN (`request.cf.asn`) requires Cloudflare Workers. Rather than take that dependency, the API performs a local **MaxMind GeoLite2-ASN** mmdb lookup at capture, while it still holds the IP — in-memory, ~1 µs, free, self-contained. It also supplies country as a fallback when CF headers are absent.

Datacenter-origin traffic is one of the strongest bot signals, and detecting bots better is the entire product. Worth the 8 MB file.

### 5.3 visitor_hash and the daily salt

`visitor_hash = sha256(ip + user_agent + daily_salt)`, truncated to 32 chars. The salt lives in Redis at `salt:YYYY-MM-DD`, generated on first use with a TTL of 48h.

**Consequence, accepted deliberately:** rotating the salt daily means yesterday's hashes cannot be linked to today's. This is the privacy property working as designed — linkability is bounded to 24 hours. It also means **there is no cross-day unique-visitor metric, ever.** The UI must say "únicos hoy" and must never imply a longer window.

No cookies. Ever.

---

## 6. Event pipeline

`apps/worker` is a separate NestJS process consuming the BullMQ queue.

**It enriches; it does not judge** (invariant 4). Enrichment is:

- UA parse → `browser`, `browser_version`, `os`, `device_type`
- `source_platform` from referer + UA — Instagram / WhatsApp / TikTok / Facebook / X / directo
- `is_in_app` — UA contains `Instagram`, `FBAN`, `FBAV`, `TikTok`, `BytedanceWebview`, `Line`
- `dest_host` — destination with query string stripped

**Batching.** Accumulate N=100 events or T=2000 ms, whichever first, then:

1. one multi-row `INSERT ... ON CONFLICT (event_id, occurred_at) DO NOTHING` (invariant 8)
2. one R2 NDJSON PUT

R2 bills per PUT. One object per click is real money at any volume.

**R2 layout:** `events/dt=2026-07-21/hour=14/<ulid>.ndjson`

### 6.1 R2 is the source of truth

Invariant 7 says the R2 log is the source of truth and Postgres is a rebuildable projection. **That is only true if the rebuild is exercised.** The plan includes a `posta replay --from --to` command and a test that truncates a Postgres partition and restores it from R2, asserting row-for-row equality. Without that test the invariant is decoration.

---

## 7. Classification — the moat

The human-vs-bot verdict is a **read-time SQL view**, `events_classified`. Improving a rule reclassifies all history with no data rewrite. Dashboards query the view, never raw `events`.

The view returns **both the verdict and the reason**, from two parallel `CASE` expressions over the same ordered rules. This means the `recibos` stream ("why each was flagged") is free from the same view, and improving a rule improves the receipts at the same time.

### 7.1 Rule order (order is load-bearing)

| # | Rule | Verdict |
|---|---|---|
| 1 | `purpose`/`x_moz`/`sec_purpose` declares prefetch or preview | `prefetch` |
| 2 | UA matches known unfurlers (`facebookexternalhit`, `WhatsApp`, `Twitterbot`, `Slackbot`, `Discordbot`, `TelegramBot`, `LinkedInBot`, `Applebot`, `SkypeUriPreview`, `redditbot`, `Iframely`, `embedly`) | `unfurler` |
| 3 | `http_method = 'HEAD'` | `unfurler` |
| 4 | UA self-declares automation (`bot`, `crawl`, `spider`, `curl`, `wget`, `python-requests`, `go-http-client`, `okhttp`, `axios`, `headlesschrome`, `puppeteer`, `playwright`, …) | `bot` |
| 5 | UA is null or empty | `bot` |
| 6 | ASN is a known datacenter **and** no `sec_ch_ua` | `bot` |
| 7 | No `accept_language` **and** no `sec_fetch_site` **and** no `sec_ch_ua` | `bot` |
| 8 | otherwise | `humano` |

Rule 1 precedes everything because a prefetch carries a real browser UA. Rule 2 precedes rule 4 because `WhatsApp` does not match `/bot/`.

Datacenter ASNs live in a lookup table `asn_datacenter (asn, name)`, joined by the view — so adding an ASN is an insert, not a migration.

**`why` strings are Spanish and user-facing**, matching POSTA.md §6 recibos copy: `user-agent 'python-requests'` · `preview de link · Purpose: prefetch` · `método HEAD` · `ASN 16509 (Amazon) sin fingerprint de browser`.

### 7.2 The corpus

A fixture corpus of real UA/header combinations with expected labels, run as a golden test on every view change. Without it, "improving a rule" is unfalsifiable and regressions are invisible.

This corpus is the most valuable artifact in the repo. It is the thing a competitor cannot copy from the marketing page.

---

## 8. Data model

```sql
-- append-only, monthly partitions, NO verdict column, NO ip column
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
```

The primary key must include the partition key — which is also exactly what invariant 8's `ON CONFLICT (event_id, occurred_at)` needs.

**The absence of `ip` and `classification` columns is the enforcement mechanism** for invariants 6 and 4. They cannot be violated by a careless write because there is nowhere to write them.

Per-partition indexes: `(tenant_id, link_id, occurred_at DESC)` and `(tenant_id, occurred_at DESC)`.

Normal tables (`users`, `links`, `bio_pages`, `bio_links`, `domains`, `asn_datacenter`) via `drizzle-kit`. The partitioned `events` table, the partition-creation job, and `events_classified` are **manual SQL migrations** — drizzle-kit cannot emit `PARTITION BY` or `CREATE VIEW`.

---

## 9. Redis: one instance, two keyspaces

| Purpose | Key pattern | TTL |
|---|---|---|
| Hot link cache | `link:{tenant}:{slug}` | 1h |
| Daily salt | `salt:YYYY-MM-DD` | 48h |
| Event bus | BullMQ default keys | none |

**`maxmemory-policy` must be `volatile-lru`, not `allkeys-lru`.** Cache keys carry a TTL; BullMQ keys do not. Under `volatile-lru`, memory pressure degrades the cache — which self-heals from Postgres — and can never evict queued events. Under `allkeys-lru`, a queue backlog silently eats itself. This is a one-line config with data-loss consequences.

---

## 10. Auth & tenancy

Better Auth on Postgres, email + password. Session cookie scoped to `app.posta.lat`. One seeded account via a `pnpm seed` script; **no public signup route exists** in v1 — not hidden, absent.

`tenant_id == user_id`. Every query is tenant-scoped from day one so v1.5 multi-tenancy is configuration, not migration.

`/v1/*` endpoints sit behind auth middleware and are versioned from the start, so the v2 API-keys + MCP work does not require re-versioning.

---

## 11. Frontend — one surface

**Amended invariant 11:** *Bio pages and the dashboard are both rendered by `apps/web` (Next.js) — one frontend surface. Bio pages are statically generated with on-demand revalidation on save, served from CDN edge, with OG tags via `generateMetadata`. The API owns redirects and data; it renders no HTML except the 404 page. `web` reads bio data over HTTP and imports `contracts` only.*

**Why this beats API-rendered HTML:** the original justification for API rendering was speed on the public path. That inverts under SSG — a bio page becomes a static file on a CDN edge near the visitor, while an API-rendered page is a live round-trip to São Paulo for every visitor. For LATAM traffic opening links from Instagram, Next is faster.

The second win is structural: **the bio editor's live preview is the page component itself**, not a reimplementation. Drift between preview and reality is impossible by construction, and the planned `contracts/themes` indirection is deleted entirely. Themes are React components.

**Revalidation:** on bio save, the API calls Next's on-demand revalidation webhook for that handle.

### 11.1 Design system

Tailwind + shadcn/ui per DESIGN.md. One SCSS token file (`_tokens.scss`, from POSTA.md §8) emits CSS custom properties; the Tailwind config reads those variables so `bg-primary` and `var(--primary)` are the same value. Runtime theme switching stays a `.light` class toggle. **No hex in components, ever.**

shadcn supplies sheet, toast, dialog, dropdown, tabs — all explicitly requested by POSTA.md. Rebuilding them by hand would be weeks for no gain.

### 11.2 Honesty primitives

Four components, built as real reusable primitives, not decoration. These *are* the product:

1. **`<HumanoBar>`** — segmented real-vs-no-humano bar. Humans in lime, the rest in the `--n1/n2/n3` gray ramp. 16px, 6px radius, 2px gaps.
2. **`<BadgeHumano>`** — `% humano`, mono, lime on a `color-mix` tint.
3. **`<SourceChip>`** — platform chip with a colored dot.
4. **`<Recibos>`** — the terminal log island streaming raw clicks with classification and *why*. **This transparency is the product** — it gets built like the point, not like a footer.

The `--n1/n2/n3` grays must adapt per theme so they never render near-black on white.

**Dark islands stay dark in both themes** (DESIGN.md §1): login card, bio page, 404, recibos, and any terminal surface.

### 11.3 The honesty rule, everywhere

The hero number is **always real humans**. Bots/unfurlers/prefetch appear as an honest secondary split, never folded into the headline. This is checked per screen against the POSTA.md §7 checklist, which E9 turns into an executable gate.

---

## 12. Testing strategy

| Layer | Approach |
|---|---|
| Hot path | Integration tests against real Redis + Postgres (testcontainers). Assert: 307 status · redirect still succeeds when the queue is **down** · no IP in the queued payload · latency budget |
| Classification | The golden corpus (§7.2). Every view change re-runs it |
| Worker | Idempotency — same event twice yields one row. Batch flush on count and on timeout |
| R2 | The replay test — truncate a partition, restore from R2, assert equality |
| Contracts | Zod schemas round-trip; `web` cannot import `core` (lint) |
| E2E | Critical flows: login → create link → click it → see the honest number move |

Coverage floor 80%, per the global baseline. TDD throughout.

The two tests that matter most are the **queue-is-down redirect test** and the **R2 replay test**, because they are the two invariants most likely to quietly become false.

---

## 13. Deployment & operations

| Concern | Choice |
|---|---|
| Region | São Paulo — API, Redis, Postgres co-located |
| DNS/TLS | Wildcard `*.posta.lat` via Cloudflare, proxied |
| Path split | Cloudflare Origin Rule, `path == "/"` → Next origin |
| Partitions | Monthly, created ahead by a scheduled job with an alert if the next partition is missing |
| Observability | Redirect p50/p95/p99 · queue depth · worker lag · enqueue failure rate · classification distribution drift |

**Classification distribution drift is the alert that matters.** A sudden swing in the humano/bot ratio means either an attack or a broken rule, and both need eyes.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Classification is wrong and the whole thesis is undermined | The corpus (§7.2), plus `recibos` making every verdict publicly auditable — being wrong in the open is survivable, being wrong invisibly is not |
| Redis eviction silently drops queued events | `volatile-lru` (§9), queue-depth alerting |
| R2 "source of truth" is never actually exercised | The replay test (§6.1) |
| Analytics queries slow as `events` grows | Partition pruning + covering indexes; the escape hatch is replaying R2 into a columnar store, deliberately deferred |
| Cloudflare Origin Rule misconfigured → bio 404s or slugs hit Next | An E2E smoke test asserting both paths on the real domain post-deploy |
| GeoLite2 license/attribution | Requires a free MaxMind account and attribution; verify terms before launch |

---

## 15. Milestones

**M1 · "el número es honesto"** — the engine, provable with `curl` + one SQL query, no UI.
**M2 · "lo podés usar"** — auth, CRUD, dashboard.
**M3 · "el mundo lo ve"** — public bio, polish, launch.

The riskiest work — the classification corpus and the R2 replay — is deliberately in M1. Both are invariants that are cheap to fake and expensive to discover broken later.

Epic breakdown: `docs/plan/`.
