# E3 — Event pipeline

**Milestone:** M1 · **Depends on:** E2 · **Unblocks:** E4

**Goal:** drain the queue, enrich, and land every event in Postgres **and** R2 — idempotently, in batches — with a proven ability to rebuild Postgres from R2.

**Done when:** 10k events pushed through end-to-end land exactly once in both stores, and the replay test rebuilds a truncated partition from R2 with row-for-row equality.

---

## S3.1 — Worker process & consumer

**As an** operator **I want** the worker isolated from the API **so that** analytics load can never touch redirect latency.

**Acceptance:**
- [ ] `apps/worker` is a standalone NestJS process, deployable and restartable independently
- [ ] BullMQ consumer with tuned concurrency
- [ ] Graceful shutdown: stop accepting, **flush the in-memory batch**, then exit — a rolling deploy must not eat the buffer
- [ ] Failed jobs retry with exponential backoff, then land in a dead-letter queue
- [ ] DLQ depth is alertable and inspectable
- [ ] Health endpoint reporting queue depth and last-successful-flush age

**Tasks:**
- [ ] T3.1.1 worker bootstrap + config
- [ ] T3.1.2 BullMQ consumer registration
- [ ] T3.1.3 graceful shutdown with batch flush
- [ ] T3.1.4 retry policy + DLQ
- [ ] T3.1.5 health endpoint
- [ ] T3.1.6 test: SIGTERM mid-batch loses nothing

> Buffering in memory for throughput means a careless shutdown drops events. The flush-on-shutdown task is what makes batching safe rather than merely fast.

---

## S3.2 — Enrichment (never judgement)

**As an** analyst **I want** derived fields computed once **so that** queries stay cheap — without ever deciding human-vs-bot here.

**The worker enriches; it does not judge** [INV-4]. Nothing in this story produces a verdict. If a task here starts to look like classification, it belongs in E4's view.

**Acceptance:**
- [ ] UA parse → `browser`, `browser_version`, `os`, `device_type`
- [ ] `source_platform` from referer + UA: Instagram · WhatsApp · TikTok · Facebook · X · directo
- [ ] `is_in_app` — UA contains `Instagram`, `FBAN`, `FBAV`, `TikTok`, `BytedanceWebview`, `Line`
- [ ] `dest_host` — destination host with query string stripped
- [ ] Unparseable UA yields nulls, never an exception — one weird UA must not stall a batch
- [ ] **No verdict is computed or stored anywhere in this path** [INV-4]
- [ ] Enrichment is pure and unit-testable without a database

**Tasks:**
- [ ] T3.2.1 UA parser wrapper (`ua-parser-js`), null-safe
- [ ] T3.2.2 source-platform resolver — referer first, then UA in-app markers
- [ ] T3.2.3 in-app browser detection
- [ ] T3.2.4 destination host + query strip
- [ ] T3.2.5 pure-function unit tests over a UA fixture set
- [ ] T3.2.6 test: garbage UA yields nulls and the batch still commits

> `source_platform` is descriptive, `classification` is a judgement. Instagram's in-app browser is a *source*; whether that hit was a human is decided at read time, by the view, forever revisable.

---

## S3.3 — Batched idempotent Postgres writes

**As an** operator **I want** batched inserts that tolerate replay **so that** retries and backfills cannot double-count.

**Acceptance:**
- [ ] Flush on **100 events or 2000 ms**, whichever first
- [ ] One multi-row `INSERT ... ON CONFLICT (event_id, occurred_at) DO NOTHING` per batch [INV-8]
- [ ] The same batch applied twice produces the same row count — asserted in test
- [ ] Partial batch failure does not lose the whole batch: retry the batch, then split on repeated failure to isolate the poison row
- [ ] Poison rows go to the DLQ with their payload, never dropped silently
- [ ] Batch size and interval are env-configurable

**Tasks:**
- [ ] T3.3.1 batch accumulator with count + time triggers
- [ ] T3.3.2 multi-row upsert [INV-8]
- [ ] T3.3.3 retry with batch-splitting to isolate poison rows
- [ ] T3.3.4 poison → DLQ with payload
- [ ] T3.3.5 idempotency test: same batch twice → one set of rows [INV-8]
- [ ] T3.3.6 throughput benchmark, 10k events

---

## S3.4 — R2 append log

**As an** operator **I want** every event in an NDJSON log on R2 **so that** Postgres is a projection I can throw away and rebuild.

**Acceptance:**
- [ ] One R2 PUT per batch (never per event — R2 bills per PUT)
- [ ] Layout `events/dt=YYYY-MM-DD/hour=HH/<ulid>.ndjson`
- [ ] One JSON object per line, raw captured signals + enrichment, **no verdict, no IP** [INV-4][INV-6]
- [ ] R2 write failure retries; on exhaustion the batch goes to the DLQ **and Postgres is not committed either** — the two stores must not silently diverge
- [ ] Every event reaches Postgres **and** R2 [INV-7]
- [ ] Object keys are content-addressable enough that a replayed batch overwrites rather than duplicates

**Tasks:**
- [ ] T3.4.1 R2 client in `packages/core` (S3-compatible, MinIO locally)
- [ ] T3.4.2 NDJSON serializer
- [ ] T3.4.3 partitioned key scheme
- [ ] T3.4.4 retry + DLQ on exhaustion
- [ ] T3.4.5 transactional coupling — do not commit PG if R2 failed permanently
- [ ] T3.4.6 test: both stores agree after 10k events

> Coupling the two writes is the point of invariant 7. If Postgres commits while R2 fails, the "source of truth" quietly stops being the source of truth, and nothing tells you.

---

## S3.5 — End-to-end pipeline tests

**Acceptance:**
- [ ] 10k events through the real path land exactly once in Postgres and once in R2
- [ ] Duplicate delivery (BullMQ at-least-once) produces no duplicate rows [INV-8]
- [ ] Worker killed mid-batch: after restart, nothing is lost and nothing is doubled
- [ ] Enrichment fields populated correctly across a diverse UA fixture set
- [ ] Postgres down → events retry and eventually land, no loss
- [ ] R2 down → events retry and eventually land, no loss

**Tasks:**
- [ ] T3.5.1 load harness
- [ ] T3.5.2 exactly-once assertions across both stores
- [ ] T3.5.3 kill-mid-batch recovery test
- [ ] T3.5.4 store-outage tests for each store independently

---

## S3.6 — Replay: making invariant 7 true

**As an** operator **I want** to rebuild Postgres from R2 **so that** "R2 is the source of truth" is a demonstrated fact rather than a slogan.

This story exists because an untested rebuild capability is indistinguishable from not having one.

**Acceptance:**
- [ ] `posta replay --from <date> --to <date> [--tenant <id>]` streams R2 objects back through the insert path
- [ ] Replay is idempotent — running it over a fully-populated range changes nothing [INV-8]
- [ ] Memory-bounded: streams objects, never loads a range into memory
- [ ] Progress and a final reconciliation report (objects read, rows inserted, rows skipped)
- [ ] **The test:** truncate an `events` partition, replay it from R2, assert row-for-row equality with a pre-truncation snapshot [INV-7]
- [ ] Documented runbook for the disaster case

**Tasks:**
- [ ] T3.6.1 R2 range lister + streaming reader
- [ ] T3.6.2 NDJSON → insert path reuse (same code as live, not a parallel implementation)
- [ ] T3.6.3 CLI with range and tenant filters
- [ ] T3.6.4 reconciliation report
- [ ] T3.6.5 **truncate-and-restore test** [INV-7]
- [ ] T3.6.6 runbook in `docs/runbooks/replay.md`

> Replay must reuse the live insert path. A separate "restore" implementation drifts from the real one, and you find out on the day you need it.
