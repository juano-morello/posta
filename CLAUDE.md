# Posta

Honest-analytics link shortener + link-in-bio. LATAM / Spanish-first. Built in public by JuanoDev.

**Thesis:** the number is honest. Real, bot/unfurler/prefetch-filtered analytics. Cookieless. Every other shortener counts bots and preview-fetches as clicks; Posta shows the real humans and the split.

## Docs — read as needed, don't duplicate here
- `./BRAND.md` — identity, voice, tone. Uses the **Posta** wordmark, never JuanoDev.
- `./DESIGN.md` — design system: tokens, components, fonts, dark-first. Source of truth for all UI styling.
- `./POSTA.md` — the v1 screens, interactions, and honesty-UI behavior for this product.
- `./docs/superpowers/specs/2026-07-21-posta-design.md` — the design spec. **Wins on conflict** with the three files above; it exists because they contradicted each other.
- `./docs/plan/` — the build plan. 11 EPICs, 3 milestones, and a map from each invariant to where it is implemented *and tested*.

## Stack
pnpm + Turborepo monorepo. NestJS (`api`, `worker`), Next.js (`web`), Drizzle ORM + Postgres, Redis (hot cache **and** BullMQ event bus), Cloudflare R2 (event log + avatars), Better Auth. API deploy region: **São Paulo** (LATAM latency).

**Everything ships as a container image.** Local runs docker-compose; production is **Kubernetes with managed Postgres, Redis and R2**. The cloud provider is deliberately unchosen — images plus plain manifests keep that binding late. Consequences that are not optional: config comes only from env, logs go only to stdout, every service handles SIGTERM, and `terminationGracePeriodSeconds` must exceed the worker's batch-flush timeout or Kubernetes eats buffered events on every rollout.

## Structure — dependency arrows are one-way, enforce them
```
packages/contracts  Pure types/DTOs (Zod). Isomorphic, ZERO server deps. The web↔api seam.
packages/core       SERVER-ONLY: Drizzle schema, db + R2 clients, enrichment, classification.
apps/api            NestJS. Redirects + all CRUD + auth + analytics queries. Renders no
                    HTML except the 404. The ONLY writer to Postgres.
apps/worker         NestJS. BullMQ consumer, separate process. Drains Redis → enriches →
                    writes events to Postgres + R2. Does NOT classify.
apps/web            Next.js. Dashboard AND public bio pages — one frontend surface.
                    Imports `contracts` ONLY. Never touches the DB; reads bio data
                    over HTTP from the API.
```
Allowed: `web→contracts` · `api→core,contracts` · `worker→core,contracts` · `core→contracts`. No app imports another app. `web` importing `core` (server code) is forbidden.

`web` serving public bio pages does **not** weaken this: it fetches bio data over HTTP, which is a network call, not an import. Do not "fix" that by importing `core`.

## Routing — split by host, plus exactly one path rule
```
<handle>.<domain>/          → web   bio page (SSG + on-demand ISR, CDN-served)
<handle>.<domain>/:slug     → api   307 redirect (the hot path)
app.<domain>                → web   dashboard, auth-gated
api.<domain>/v1/*           → api   CRUD + analytics, auth-gated
```
The `/` vs `/:slug` split on the handle host is a **Cloudflare Origin Rule** (`path == "/"` → Next origin) — not an edge router, not a Worker. It must match the root **only**, so `/:slug` reaches the API origin with no added hop and invariants 1–3 stay untouched. Watch `/?utm=x`: a bio link with tracking params still has path `/` and must still route to Next.

Reserved handles (never claimable): `app` `api` `www` `admin` `static` `assets` `cdn` `mail` `blog` `docs` `status`.

## Invariants — never violate these
1. **A redirect never blocks on analytics.** Resolve destination → 307 → enqueue. If the enqueue fails, still redirect.
2. **The redirect route is lean.** Thin controller on the hot path, no DI ceremony. Nest's structure earns its keep on CRUD, not here.
3. **307, never 301.** 301 gets cached and silently kills analytics and destination edits.
4. **The worker enriches; it does not judge.** No human-vs-bot verdict is ever computed in the worker or stored as a column.
5. **The verdict is a read-time SQL view** (`events_classified`, a CASE over raw signals). Query the view, never raw `events`. Dashboards default to **humans-only**. Improving a rule = editing the view; all history reclassifies with no data rewrite.
6. **The raw IP is never stored or queued.** Compute `visitor_hash` (IP + UA + daily salt) at capture, then drop the IP. No cookies, ever.
7. **The R2 NDJSON log is the source of truth for events**; Postgres is a rebuildable projection. Every event goes to Postgres **and** R2.
8. **Event writes are idempotent:** `INSERT ... ON CONFLICT (event_id, occurred_at) DO NOTHING`. `event_id` (ULID) is assigned once, at capture.
9. **`tenant_id == user_id` for v1.** Design multi-tenant, seed one account, no public signup or billing.
10. **Hero metric is always real humans.** Bots/unfurlers/prefetch appear as an honest secondary split, never folded into the headline number.
11. **One frontend surface.** Bio pages *and* the dashboard are rendered by `web` (Next). Bio pages are statically generated with on-demand revalidation on save, CDN-served, OG tags via `generateMetadata`. The API owns redirects and data and renders no HTML except the 404. `web` reads bio data over HTTP and still imports `contracts` only.
    > *Amended 2026-07-21.* This invariant previously said the opposite — API-rendered HTML templates, `web` as dashboard only. Its justification was speed on the public path, and that inverts under SSG: a bio page becomes a static file on a CDN edge near the visitor, where API rendering is a live round-trip to São Paulo. It also made the bio editor's live preview a second implementation of the page; now the preview *is* the page component, so drift is impossible. See spec §11.

## Conventions
- **UI language: Spanish** (rioplatense, direct — "Nuevo link", "clicks reales").
- **IDs: ULID.**
- **ORM: Drizzle**; hand-written SQL is welcome. Normal tables via `drizzle-kit`; the partitioned `events` table + the classification view are a **manual** SQL migration (drizzle-kit can't emit `PARTITION BY` or views).
- **Domains from env:** `POSTA_LINK_DOMAIN` (e.g. `posta.lat`, pending availability). **No literal domain may appear in code** — a grep test enforces it, which is what keeps a fallback domain a config change. See `.env.example` and the routing table below.
- **Accent is lime.** Never naranja/tangerine — that's LBT's color, kept separate on purpose.

## Not in v1 — do not build
Custom domains (v1.5, Cloudflare for SaaS — keep the `domains` table + `type` column). Public signup, billing. API keys + MCP (v2 — keep `/v1` query endpoints clean and versioned behind auth middleware). Columnar analytics store (ClickHouse/Tinybird — later, by replaying the R2 log). QR codes, smart routing, teams/orgs.

## Decision log
Recorded so the reasoning survives, not just the conclusion. Full detail in the spec.

| Date | Decision | Instead of | Why |
|---|---|---|---|
| 2026-07-21 | Links at `<handle>.<domain>/:slug`, slug unique per tenant | apex `<domain>/:slug`, globally unique | Multi-tenant from day one; no land-grab on good slugs. Cost: longer URLs, so the links list truncates to `…/promo`. |
| 2026-07-21 | Tailwind + shadcn/ui | hand-authored SCSS components | shadcn supplies sheet/toast/dialog, which POSTA.md explicitly asks for. SCSS stays as the **token source** feeding CSS custom properties. |
| 2026-07-21 | Next renders bio pages (**invariant 11 amended**) | API-rendered HTML templates | One frontend surface. SSG on a CDN edge beats a live round-trip to São Paulo, and the editor preview becomes the real page component. |
| 2026-07-21 | Local **DB-IP** mmdb lookup at capture | Cloudflare Worker for `request.cf.asn`, or a hosted IP-lookup API | Keeps the Worker off the hot path. A *hosted* lookup would send every visitor IP to a third party on every click — invariant 6 honoured in letter, gutted in spirit. |
| 2026-07-21 | **DB-IP** over MaxMind GeoLite2 | GeoLite2 (better coverage, weekly) | GeoLite2's EULA forbids redistribution, so it cannot live in a container image — it would need a licence Secret plus a `geoipupdate` init container. DB-IP lite is CC BY 4.0 and bakes straight in. Same `.mmdb` format, so switching back is a download-script change. Cost: monthly updates, thinner long tail. |
| 2026-07-21 | **Kubernetes + container images**, provider unchosen | Picking a PaaS now | Images and plain manifests make provider choice bind late instead of early. Also forces SIGTERM handling and env-only config, which the worker needed regardless. |
| 2026-07-21 | Sign-up reachable only via a **route allowlist** | `disableSignUp: true` alone | Better Auth's provider ships a `sign-up/email` handler inside the dependency, so "no signup route exists" is not literally achievable. The allowlist means it is never routed; `disableSignUp` is defense in depth, not the mechanism. Invariant 9 is met in effect, not in letter — recorded here so nobody later "fixes" the allowlist. |
| 2026-07-21 | Reject private-range **literals** in destinations, never DNS-resolve | Full SSRF resolution-time checking | A redirect destination is fetched by the *visitor's* browser, not our infrastructure, so this is not classic SSRF. Resolving hostnames would itself be an outbound request and a DNS-rebinding vector — the check would create the class of bug it claims to prevent. |
| 2026-07-21 | Redis `volatile-lru` | `allkeys-lru` | Cache keys have TTLs, BullMQ keys do not. Under `allkeys-lru` a queue backlog silently evicts its own jobs. |
