# E10 — Deploy & operate

**Milestone:** M3 · **Depends on:** E9 · **Unblocks:** —

**Goal:** Posta live in São Paulo on `posta.lat`, with the alerts that would tell you the honest number stopped being honest.

**Done when:** a real link, shared into a real WhatsApp group, produces a real honest split on a real dashboard — and you would find out within minutes if it broke.

---

## S10.1 — Domain & DNS

**Acceptance:**
- [ ] `posta.lat` registered (**pending availability** — confirm before anything else in this epic; the whole plan assumes it)
- [ ] Cloudflare zone, proxied
- [ ] Wildcard `*.posta.lat` → API origin
- [ ] `app.posta.lat` → Next
- [ ] `api.posta.lat` → API
- [ ] Wildcard TLS covering `*.posta.lat`
- [ ] HSTS, TLS 1.2 minimum
- [ ] `POSTA_LINK_DOMAIN` set consistently across all three deploys

**Tasks:**
- [ ] T10.1.1 confirm registrability, register [blocking]
- [ ] T10.1.2 Cloudflare zone + nameservers
- [ ] T10.1.3 DNS records
- [ ] T10.1.4 wildcard certificate
- [ ] T10.1.5 TLS/HSTS hardening
- [ ] T10.1.6 env consistency check across deploys

> If `posta.lat` is unavailable, this is the moment the fallback domain gets chosen — and because every host is built from `POSTA_LINK_DOMAIN` (S0.3), that is a config change rather than a code change. Verify that claim here.

---

## S10.2 — The Origin Rule

**As an** operator **I want** the path split configured and proven **so that** the one-frontend-surface decision actually works in production.

**Acceptance:**
- [ ] Cloudflare Origin Rule: on `*.posta.lat` where `path == "/"` → Next origin; everything else → API [INV-11]
- [ ] The rule matches **only** the root — verified against `/`, `/slug`, `/slug/`, `/favicon.ico`, `/?utm=x`
- [ ] Redirect latency measured **with the rule live** — it must not add a hop to `/:slug` [INV-1][INV-2]
- [ ] The rule is documented and version-controlled as infrastructure-as-code or, failing that, a documented export
- [ ] S8.6's routing proof runs against production post-deploy

**Tasks:**
- [ ] T10.2.1 create and scope the Origin Rule
- [ ] T10.2.2 path-matching verification across the edge cases
- [ ] T10.2.3 latency measurement with the rule active
- [ ] T10.2.4 capture the config into the repo
- [ ] T10.2.5 production routing proof [INV-11]

> `/?utm=x` is the sneaky one. A rule matching on "path is `/`" must still match when a query string is present, or shared bio links with tracking params 404. Test it explicitly.

---

## S10.3 — Deploys

**Acceptance:**
- [ ] API deployed to **São Paulo**
- [ ] Worker deployed as a separate service, independently restartable
- [ ] Postgres in São Paulo, automated backups, PITR
- [ ] Redis in São Paulo, `maxmemory-policy volatile-lru` **verified in production** [INV-7]
- [ ] Next deployed with CDN in front
- [ ] R2 bucket with lifecycle policy; **never public-writable**
- [ ] Zero-downtime deploys; worker drains its batch on shutdown (S3.1)
- [ ] Migrations run as a deploy step, not by hand
- [ ] Rollback procedure documented and rehearsed once

**Tasks:**
- [ ] T10.3.1 API deploy, São Paulo
- [ ] T10.3.2 worker deploy
- [ ] T10.3.3 managed Postgres + backups + PITR
- [ ] T10.3.4 managed Redis, verify eviction policy [INV-7]
- [ ] T10.3.5 Next deploy + CDN
- [ ] T10.3.6 R2 bucket + lifecycle + access audit
- [ ] T10.3.7 migration deploy step
- [ ] T10.3.8 rollback rehearsal

> Verify the Redis eviction policy on the **managed** instance, not just in compose. Providers pick their own defaults, and `allkeys-lru` is a common one — it would quietly eat queued events under memory pressure.

---

## S10.4 — Co-location proof

**As an** operator **I want** to prove the latency claim **so that** "fast redirects from LATAM" is measured rather than assumed.

**Acceptance:**
- [ ] API, Redis and Postgres confirmed in the same region — verified by measured round-trip, not by a console label
- [ ] Redirect p50/p95/p99 measured from **real LATAM clients** (AR, BR, MX at minimum)
- [ ] p95 under the spec §4.1 budget, or the budget is revised in writing with the reason
- [ ] Cache hit rate measured
- [ ] Results recorded in `docs/M3-acceptance.md` — build-in-public material

**Tasks:**
- [ ] T10.4.1 co-location round-trip verification
- [ ] T10.4.2 synthetic latency probes from AR/BR/MX
- [ ] T10.4.3 p50/p95/p99 measurement
- [ ] T10.4.4 cache hit-rate instrumentation
- [ ] T10.4.5 record results

---

## S10.5 — Observability

**Acceptance:**
- [ ] Redirect latency p50/p95/p99 + error rate
- [ ] Queue depth and worker lag
- [ ] **Enqueue failure rate** — the invariant-1 escape valve; silent growth means events are being dropped by design and nobody knows [INV-1]
- [ ] Batch flush success and DLQ depth
- [ ] R2 vs Postgres write divergence [INV-7]
- [ ] **Classification distribution over time** [INV-5]
- [ ] Structured logs with **no IP and no secrets**, verified [INV-6][security]
- [ ] Uptime checks on redirect, bio and dashboard
- [ ] Alerts: redirect error rate · queue depth · DLQ non-empty · missing next partition · **classification drift**

**Tasks:**
- [ ] T10.5.1 metrics collection + dashboard
- [ ] T10.5.2 redirect latency and error instrumentation
- [ ] T10.5.3 queue and worker metrics
- [ ] T10.5.4 enqueue failure counter [INV-1]
- [ ] T10.5.5 store divergence check [INV-7]
- [ ] T10.5.6 classification distribution panel [INV-5]
- [ ] T10.5.7 log scrubbing verification [INV-6]
- [ ] T10.5.8 uptime checks
- [ ] T10.5.9 alert rules + routing

> **Classification drift is the alert that matters most.** A sudden swing in the humano/bot ratio means either an attack or a broken rule. Both need eyes, and neither shows up in an error rate — the system will be perfectly healthy while lying.

---

## S10.6 — Runbooks

**Acceptance:**
- [ ] `docs/runbooks/` covering: replay from R2 (S3.6) · queue backlog · DLQ drain · partition missing · Redis down · Postgres failover · Cloudflare rule broken · rollback
- [ ] Each runbook has symptoms, diagnosis, fix, and verification
- [ ] The replay runbook has been **executed at least once** against a real environment
- [ ] An on-call summary: what alerts exist, what each means, first action

**Tasks:**
- [ ] T10.6.1 replay runbook (rehearsed)
- [ ] T10.6.2 queue and DLQ runbooks
- [ ] T10.6.3 partition runbook
- [ ] T10.6.4 datastore outage runbooks
- [ ] T10.6.5 routing/rollback runbooks
- [ ] T10.6.6 on-call summary

---

## S10.7 — Launch

**Acceptance:**
- [ ] Seeded account live with a real bio page
- [ ] A real link shared into a real channel; unfurlers, prefetches and humans all appear correctly split
- [ ] The `recibos` stream is showing genuine traffic with honest reasons
- [ ] Security pass: no exposed secrets, no debug endpoints, rate limits verified, headers hardened
- [ ] Novel real-traffic cases promoted into the corpus (S4.4)
- [ ] `docs/M3-acceptance.md` complete
- [ ] Build-in-public post drafted from the real numbers

**Tasks:**
- [ ] T10.7.1 seed and publish the real bio
- [ ] T10.7.2 share a real link, observe the split
- [ ] T10.7.3 final security pass [security]
- [ ] T10.7.4 promote real cases into the corpus
- [ ] T10.7.5 record M3 acceptance
- [ ] T10.7.6 draft the launch post

> The launch post writes itself if T10.7.2 is done honestly: the gap between what another shortener would have reported and what Posta reports **is** the product, stated as a number. Publish the real one, including the parts that are less flattering than expected.
