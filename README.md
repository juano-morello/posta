# Posta

Honest-analytics link shortener + link-in-bio. LATAM / Spanish-first.

The number is honest: real, bot/unfurler/prefetch-filtered analytics, cookieless. Every other
shortener counts bots and preview-fetches as clicks — Posta shows the real humans and the split.

This README gets a fresh clone to a running local stack. For the full architecture, invariants,
and decision log, see [`CLAUDE.md`](./CLAUDE.md).

## Prerequisites

- **Node 24** — an `.nvmrc` is checked in; run `nvm use` (or your version manager's equivalent)
  before anything else.
- **pnpm 10.33.0** via Corepack — run `corepack enable` once per machine. The exact version is
  pinned in `package.json`'s `packageManager` field, so there's nothing to install globally.
- **Docker** (with Compose) — runs the local Postgres, Redis, and MinIO (an S3-compatible stand-in
  for Cloudflare R2).

## Setup

Run these in order, from a clean clone:

```bash
pnpm install
cp .env.example .env
```

`.env.example` documents every variable inline — read its comments rather than this file. Most
values already have a working local default; a few don't and need filling before anything will
boot:

- `R2_ACCOUNT_ID` — any non-empty placeholder works; MinIO ignores the value, but the env schema
  requires it to be present.
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`
- `REVALIDATE_SECRET` — `openssl rand -hex 32`
- `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` — the one seeded v1 account (password: 12+ characters).

```bash
pnpm geo:fetch
```

Pulls DB-IP's two `.mmdb` GeoIP databases into `data/geoip/`. This is a separate step — not part of
`pnpm install` — because those files are **git-ignored** (binary, refreshed monthly), not because
they're gated: no account and no licence key. DB-IP's lite databases are CC BY 4.0 and free to
redistribute (see [GeoIP attribution](#geoip-attribution) below). Skip this step and the API still
boots, but the datacenter/ASN classification rule can never fire.

```bash
pnpm dev
```

Brings up Postgres, Redis, and MinIO in Docker (waiting for all three to report healthy, then for
the one-shot bucket-init container to finish), then runs `api`, `worker`, and `web` on the host in
watch mode via Turborepo. Leave it running — this is the everyday edit loop.

## Other commands

| Command | What it does |
|---|---|
| `pnpm test` | Runs the full Vitest suite. **Needs the stack up first** — see the gotcha below. |
| `pnpm typecheck` | Type-checks `contracts`/`core`/`api`/`worker` (project references), then `web`, then the `tests/` tree. |
| `pnpm lint` | ESLint across the whole repo. |
| `pnpm depcruise` | Enforces the one-way package dependency arrows (see `CLAUDE.md`'s structure block). |
| `pnpm -r build` | Builds every package/app that defines a `build` script. There's no root `build` script — this is pnpm's own recursive-run flag. |
| `pnpm dev:reset` | Tears down the Docker volumes (Postgres/Redis/MinIO data, all of it) and recreates the stack from empty. Use when local data drifts into a state you don't trust. |
| `pnpm geo:fetch` | Same command as setup — also how you do the monthly GeoIP refresh. DB-IP ships a new release mid-month; see [`docs/ops/geoip.md`](./docs/ops/geoip.md). |
| `pnpm docker:prune` | Debug helper: computes a pruned, per-app Docker build context via `turbo prune`. |

## `pnpm test` needs the stack up first

`tests/infra/redis-policy.test.ts` connects to a **real** Redis and asserts its live
`maxmemory-policy` is `volatile-lru` — this guards invariant 7 (under the wrong policy, a queue
backlog silently evicts its own BullMQ jobs, with no error anywhere). It is deliberately not a
mock. If Redis isn't reachable, or reachable with the wrong policy, this test **fails loudly, on
purpose** — that's the point of it, not a broken test to file an issue about.

Before running `pnpm test`, both of these need to be true:

1. The stack is up — `pnpm dev` (in another terminal), or at least
   `docker compose up -d --wait postgres redis minio`.
2. `REDIS_URL` is actually set in the shell that runs `pnpm test`. Unlike the per-app `dev`
   scripts (which load `.env` themselves via `dotenv-cli`), plain `pnpm test` does **not**
   auto-load `.env`. The simplest fix:

   ```bash
   set -a && source .env && set +a
   pnpm test
   ```

Skip either one and you'll get a clear, specific error (`REDIS_URL is not set...` or `Could not
connect to the Redis at REDIS_URL...`) instead of a silent hang or a confusing stack trace.

## Repo layout

Five packages/apps with one-way dependency arrows, enforced by `pnpm depcruise`:

```
packages/contracts  Pure types/DTOs (Zod). Isomorphic, zero server deps.
packages/core       SERVER-ONLY: Drizzle schema, db + R2 clients, enrichment.
apps/api            NestJS. Redirects + CRUD + auth + analytics. Only writer to Postgres.
apps/worker         NestJS. BullMQ consumer — drains Redis, enriches, writes events.
apps/web            Next.js. Dashboard AND public bio pages — one frontend surface.
```

Full architecture, routing table, invariants, and decision log live in [`CLAUDE.md`](./CLAUDE.md)
— this is a pointer, not a copy.

## GeoIP attribution

> IP geolocation by DB-IP (<https://db-ip.com>), licensed under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Required wherever this data is used in a public-facing product (the bio-page footer carries it
too). Full details, refresh cadence, and the licence rationale: [`docs/ops/geoip.md`](./docs/ops/geoip.md).

## Container images

`pnpm dev` runs the datastores in Docker and the three apps on the host in watch mode — that's the
everyday loop above. `docker compose up --build -d` instead builds and runs the same `api`/
`worker`/`web` images CI and production use. Reach for that when debugging something that smells
environmental (a container-only bug, or testing a Dockerfile change) — it's slower to iterate on
and isn't the normal dev loop.
