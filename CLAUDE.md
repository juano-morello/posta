# Posta

Honest-analytics link shortener + link-in-bio. LATAM / Spanish-first. Built in public by JuanoDev.

**Thesis:** the number is honest. Real, bot/unfurler/prefetch-filtered analytics. Cookieless. Every other shortener counts bots and preview-fetches as clicks; Posta shows the real humans and the split.

## Docs — read as needed, don't duplicate here
- `./BRAND.md` — identity, voice, tone. Uses the **Posta** wordmark, never JuanoDev.
- `./DESIGN.md` — design system: tokens, components, fonts, dark-first. Source of truth for all UI styling.
- `./POSTA.md` — the v1 screens, interactions, and honesty-UI behavior for this product.

## Stack
pnpm + Turborepo monorepo. NestJS (`api`, `worker`), Next.js (`web`), Drizzle ORM + Postgres, Redis (hot cache **and** BullMQ event bus), Cloudflare R2 (event log + avatars), Better Auth. API deploy region: **São Paulo** (LATAM latency).

## Structure — dependency arrows are one-way, enforce them
```
packages/contracts  Pure types/DTOs (Zod). Isomorphic, ZERO server deps. The web↔api seam.
packages/core       SERVER-ONLY: Drizzle schema, db + R2 clients, enrichment, classification.
apps/api            NestJS. Redirects + bio-page render + all CRUD + auth + analytics queries.
                    The ONLY writer to Postgres.
apps/worker         NestJS. BullMQ consumer, separate process. Drains Redis → enriches →
                    writes events to Postgres + R2. Does NOT classify.
apps/web            Next.js dashboard. Imports `contracts` ONLY. Never touches the DB.
```
Allowed: `web→contracts` · `api→core,contracts` · `worker→core,contracts` · `core→contracts`. No app imports another app. `web` importing `core` (server code) is forbidden.

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
11. **Bio pages are rendered by the API** as cached HTML templates with OG tags — not by Next. `web` is the dashboard only.

## Conventions
- **UI language: Spanish** (rioplatense, direct — "Nuevo link", "clicks reales").
- **IDs: ULID.**
- **ORM: Drizzle**; hand-written SQL is welcome. Normal tables via `drizzle-kit`; the partitioned `events` table + the classification view are a **manual** SQL migration (drizzle-kit can't emit `PARTITION BY` or views).
- **Domains from env:** `POSTA_LINK_DOMAIN` (e.g. `posta.lat`, pending availability). Links live at `<handle>.<domain>/:slug`; the dashboard at `app.<domain>`.
- **Accent is lime.** Never naranja/tangerine — that's LBT's color, kept separate on purpose.

## Not in v1 — do not build
Custom domains (v1.5, Cloudflare for SaaS — keep the `domains` table + `type` column). Public signup, billing. API keys + MCP (v2 — keep `/v1` query endpoints clean and versioned behind auth middleware). Columnar analytics store (ClickHouse/Tinybird — later, by replaying the R2 log). QR codes, smart routing, teams/orgs.
