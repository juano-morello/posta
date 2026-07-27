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

#### T3.1.1 · `feat: shared events queue contract in packages/core` ✅ done (`31434cd`)
`EVENTS_QUEUE`, `EVENTS_DLQ_QUEUE`, and `EVENTS_JOB_OPTIONS` (`attempts: 5`, exponential backoff from 1000 ms, `removeOnComplete: 1000`, `removeOnFail: false`) plus an `eventJobSchema` wrapping the capture DTO from T2.3.1. `core` is the one package both `api` and `worker` import, so this is the only place the two sides can agree about the queue. A name mismatch is the worst kind of bug here — the producer enqueues happily, the consumer waits on an empty queue, and nothing errors.
This is an **extract-and-rewire** commit: T2.4.3 ships the producer with its queue name inline, and this task lifts that into `core` and repoints the producer at it — so it touches `apps/api` as well. BullMQ sets `attempts`/`backoff` as *job options at `queue.add()` time*, which means the retry policy is producer-side and cannot live purely in the consumer.
→ **files** `packages/core/src/queue/events-queue.ts` · `packages/core/src/queue/events-queue.test.ts` · `apps/api/src/redirect/enqueue.ts` · **verify** `pnpm test events-queue.test.ts` asserts the retry policy is exponential with ≥3 attempts, that `eventJobSchema` rejects a payload carrying an `ip` key, and that no file under `apps/` declares a literal queue-name string · **after** T2.4.3

#### T3.1.2 · `feat: worker bootstrap with BullMQ connection and shutdown hooks` ✅ done (`f7c8b2f`)
`main.ts` parses the worker env (T0.3.6) as its first statement, then boots `AppModule` with the BullMQ root connection pointed at `REDIS_URL` and `app.enableShutdownHooks()` so Nest's `onModuleDestroy` fires on SIGTERM — the hook the flush in T3.1.6 hangs off. No consumer registered yet.
→ **files** `apps/worker/src/main.ts` · `apps/worker/src/app.module.ts` · **verify** `pnpm --filter @posta/worker start` boots against the compose Redis, and `kill -TERM` exits 0 within 5 s instead of being killed by the timeout · **after** T0.1.9, T0.3.6, T3.1.1

#### T3.1.3 · `feat: BullMQ consumer with tuned concurrency` ✅ done (`52ab3e9`)
`EventsConsumer` processing `EVENTS_QUEUE` with concurrency from `WORKER_CONCURRENCY` (default 8). Each job is decoded with `eventJobSchema` and handed to an injected sink interface — a no-op sink until the accumulator lands in T3.3.1 — so the consumer stays testable without a database.
→ **files** `apps/worker/src/consumer/events.consumer.ts` · `apps/worker/src/consumer/events.consumer.test.ts` · **verify** `pnpm test events.consumer.test.ts` pushes 20 jobs onto a testcontainer Redis and asserts the sink receives 20 decoded payloads with `event_id` unchanged · **after** T3.1.2

#### T3.1.4 · `feat: route undecodable jobs straight to the DLQ` ✅ done (`378d661`)
A payload that fails `eventJobSchema` will never parse on a retry. Retrying it five times only delays the inevitable while burning consumer slots, so the consumer sends it to `EVENTS_DLQ_QUEUE` with the raw payload plus the Zod issue list and acks the job. [security] — the raw payload is logged only to the DLQ record, never to stdout, since it is unvalidated external input.
→ **files** `apps/worker/src/consumer/events.consumer.ts` · `apps/worker/src/consumer/malformed-job.test.ts` · **verify** `pnpm test malformed-job.test.ts` enqueues `{ nonsense: true }` and asserts one DLQ entry after exactly one attempt, zero sink calls, and no payload content in captured logs · **after** T3.1.3

#### T3.1.5 · `feat: dead-letter queue with payload and failure reason` ✅ done (`dba92d3`)
`DlqService.send(reason, payload, error)` writes to `EVENTS_DLQ_QUEUE` and exposes `depth()`. Wired to the consumer's `failed` handler for jobs that exhaust `attempts`. The payload travels with the entry — a DLQ that records only "batch failed" cannot be replayed, which makes it a delete with extra steps.
→ **files** `apps/worker/src/consumer/dlq.service.ts` · `apps/worker/src/consumer/dlq.service.test.ts` · **verify** `pnpm test dlq.service.test.ts` forces a handler to throw on every attempt and asserts one DLQ entry carrying the full original payload, the error message, and `attemptsMade === 5` · **after** T3.1.4

#### T3.1.6 · `feat: graceful shutdown flushes the in-memory batch` ✅ done (`bbf137d`)
`onModuleDestroy` pauses the BullMQ worker so no new job is claimed, awaits in-flight handlers, then calls `flushNow()` on the accumulator before resolving. Bounded by a `SHUTDOWN_TIMEOUT_MS` so a wedged flush cannot block a deploy forever. This is the task that makes in-memory batching safe rather than merely fast.
→ **files** `apps/worker/src/consumer/shutdown.ts` · `apps/worker/src/app.module.ts` · `apps/worker/src/consumer/shutdown.test.ts` · **verify** `pnpm test shutdown.test.ts` fills a partial batch of 30, triggers `onModuleDestroy`, and asserts all 30 rows are in Postgres before the promise resolves · **after** T3.1.5, T3.3.1

#### T3.1.7 · `feat: worker health endpoint with queue depth and last-flush age` ✅ done (`9397d42`)
`GET /health` on the worker returns `{ status, queue_depth, dlq_depth, last_flush_age_ms, batch_size }` and answers 503 when `last_flush_age_ms` exceeds three flush intervals. Queue depth alone looks healthy while the worker is wedged; the flush age is the signal that actually distinguishes idle from stuck.
→ **files** `apps/worker/src/health.controller.ts` · `apps/worker/src/health.controller.test.ts` · **verify** `pnpm test health.controller.test.ts` asserts 200 with a fresh flush, 503 after advancing fake timers past the threshold, and that `dlq_depth` reflects a planted DLQ entry · **after** T3.1.6

#### T3.1.8 · `test: SIGTERM mid-batch loses nothing`
Boots the real worker as a child process against testcontainer Redis + Postgres, pushes 250 events, sends SIGTERM while a partial batch is buffered, waits for exit, and asserts Postgres holds all 250 with no duplicates and the queue is empty. The unit test in T3.1.6 proves the hook is called; this proves a real process actually survives it.
→ **files** `apps/worker/src/consumer/sigterm-flush.test.ts` · **verify** `pnpm test sigterm-flush.test.ts` — asserts 250 rows, exit code 0, and zero DLQ entries · **after** T3.1.7, T3.3.2

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

#### T3.2.1 · `feat: null-safe UA parser wrapper in packages/core/src/enrichment` ✅ done (`7c1b9dd`)
`parseUserAgent(ua: string | null)` returns `{ browser, browser_version, os, device_type }`, every field nullable, wrapping `ua-parser-js` in a try/catch that yields all-nulls rather than throwing. `device_type` is normalised to `'mobile' | 'tablet' | 'desktop' | null`. Pure: no DB, no I/O, no clock.
→ **files** `packages/core/src/enrichment/ua.ts` · `packages/core/src/enrichment/ua.test.ts` · **verify** `pnpm test ua.test.ts` is table-driven over desktop Chrome, iOS Safari, the Instagram in-app UA, `facebookexternalhit`, `null`, `''`, and a 4 KB binary-garbage string — asserting no throw on any of them and all-nulls on the last three · **after** T0.1.7

#### T3.2.2 · `feat: in-app browser marker table and isInApp detection` ✅ done (`b001ec2`)
`IN_APP_MARKERS` (`Instagram`, `FBAN`, `FBAV`, `TikTok`, `BytedanceWebview`, `Line`) and `isInApp(ua)` returning a boolean, case-sensitive against the marker list. The marker table lives here rather than being inlined because T3.2.3 resolves `source_platform` from the same strings — two copies would drift, and the drift shows up as an event that is `is_in_app: true` with `source_platform: 'directo'`.
→ **files** `packages/core/src/enrichment/source-platform.ts` · `packages/core/src/enrichment/is-in-app.test.ts` · **verify** `pnpm test is-in-app.test.ts` asserts each of the six markers matches, that a plain Chrome UA and `null` both return `false`, and that the exported marker list has exactly six entries · **after** T3.2.1

#### T3.2.3 · `feat: source_platform resolver — referer first, then UA markers` ✅ done (`43644ad`)
`resolveSourcePlatform(referer, ua)` returns `'instagram' | 'whatsapp' | 'tiktok' | 'facebook' | 'x' | 'directo'`. Referer host is checked first (it is the stronger signal and survives UA spoofing), falling back to the in-app markers from T3.2.2, then `'directo'`. **This field is descriptive, not a verdict** [INV-4] — it names where a hit came from, never whether it was a human.
→ **files** `packages/core/src/enrichment/source-platform.ts` · `packages/core/src/enrichment/source-platform.test.ts` · **verify** `pnpm test source-platform.test.ts` asserts `l.instagram.com` → `instagram`, `t.co` and `twitter.com` → `x`, `lm.facebook.com` → `facebook`, a null referer with the Instagram in-app UA → `instagram`, and null/null → `directo` · **after** T3.2.2

#### T3.2.4 · `feat: dest_host extraction with query string stripped` ✅ done (`aec5e15`)
`destHost(destination)` parses the stored destination with `URL` and returns the lowercased host, dropping query, fragment, port and userinfo. Returns `null` on an unparseable value instead of throwing. The strip happens here rather than at capture (E2 stores the destination verbatim) so the raw destination stays recoverable from R2.
→ **files** `packages/core/src/enrichment/dest-host.ts` · `packages/core/src/enrichment/dest-host.test.ts` · **verify** `pnpm test dest-host.test.ts` asserts `https://Shop.Example.com:443/a?utm_source=ig#x` → `shop.example.com`, that `not a url` and `''` return `null`, and that a URL with credentials does not leak them into the result · **after** T3.2.1

#### T3.2.5 · `feat: compose enrichment into one pure enrich() over a capture payload` ✅ done (`87acd22`)
`enrich(payload)` returns exactly the seven enrichment columns from spec §8 — `browser`, `browser_version`, `os`, `device_type`, `source_platform`, `is_in_app`, `dest_host` — with a return type that structurally cannot carry an eighth field. One entry point so the live flush path (T3.3.2) and replay (T3.6.3) enrich identically.
→ **files** `packages/core/src/enrichment/index.ts` · `packages/core/src/enrichment/enrich.test.ts` · **verify** `pnpm test enrich.test.ts` asserts the returned key set equals the seven column names exactly, and that a payload with every field null returns seven nulls without throwing · **after** T3.2.3, T3.2.4

#### T3.2.6 · `test: enrichment fixture corpus over real UA and referer combinations` ✅ done (`9882284`)
A committed fixture of ~40 real `{ user_agent, referer, destination }` triples with their expected enrichment output — desktop and mobile browsers, all six in-app webviews, the LATAM Android long tail, and deliberately malformed entries. **This is not the classification corpus** (spec §7.2, which belongs to E4): it asserts descriptive fields only, with no expected verdict column anywhere in the file. Reused end-to-end by T3.5.5.
→ **files** `packages/core/src/enrichment/fixtures/ua-corpus.json` · `packages/core/src/enrichment/corpus.test.ts` · **verify** `pnpm test corpus.test.ts` runs `enrich()` over every fixture and asserts the expected output, plus asserts the fixture file contains no key matching `verdict|classification|is_bot|is_human` · **after** T3.2.5

#### T3.2.7 · `test: forbid verdict vocabulary in the enrichment and worker source` [INV-4] ✅ done (`18dc248`)
Scans `packages/core/src/enrichment/**` and `apps/worker/src/**` for `is_bot`, `isBot`, `is_human`, `isHuman`, `classification`, `verdict`, `humano`, `unfurler` and `prefetch` used as an assigned value, and fails naming the file and line. T1.2.5 proves there is nowhere to *store* a verdict; this proves nobody computed one on the way there.
→ **files** `apps/worker/src/no-verdict.test.ts` · **verify** `pnpm test no-verdict.test.ts` passes on the current tree and fails with file:line against an inline fixture containing `const isBot = ua.includes('bot')` · **after** T3.2.6

#### T3.2.8 · `test: garbage UA yields nulls and the batch still commits`
The failure mode this guards is not a wrong field, it is a stalled pipeline: one exception thrown during enrichment takes down the whole batch and, with retries, the whole queue. Pushes a batch of 100 in which 5 carry hostile UA strings (binary, 64 KB, null bytes, lone surrogates) and asserts all 100 rows commit with nulls on the bad five.
→ **files** `apps/worker/src/batch/hostile-ua.test.ts` · **verify** `pnpm test hostile-ua.test.ts` asserts 100 rows in Postgres, `browser IS NULL` for exactly the 5 hostile events, and zero DLQ entries · **after** T3.2.7, T3.3.2

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

#### T3.3.1 · `feat: batch accumulator with count and time triggers` ✅ done (`349f489`)
`BatchAccumulator` opens a batch on the first event, mints its `batch_id` ULID once (T3.4.3 keys the R2 object off it), and fires the injected flush callback at `EVENT_BATCH_SIZE` events or `EVENT_BATCH_INTERVAL_MS` since batch open, whichever first — both from the worker env schema (T0.3.6), defaulting to 100 and 2000. Exposes `flushNow()` for shutdown and `size()` for the health endpoint. No database here: the callback seam is what keeps the timing logic unit-testable with fake timers.
→ **files** `apps/worker/src/batch/accumulator.ts` · `apps/worker/src/batch/accumulator.test.ts` · **verify** `pnpm test accumulator.test.ts` with fake timers asserts 100 events flush at the 100th with no timer elapsed, 99 events flush at exactly 2000 ms, events added during an in-flight flush land in the next batch and are not lost, and `batch_id` is stable across the batch's lifetime · **after** T3.1.3, T0.3.6

#### T3.3.2 · `feat: multi-row insert with ON CONFLICT DO NOTHING` [INV-8] ✅ done (`5f7549e`)
`flushBatch(events)` first resolves each event's current destination with one batched `SELECT` keyed by `link_id` — `dest_host` needs the link's destination, which `CaptureEvent` does not carry, and `enrich()` is pure, so the SELECT must precede it — then enriches each event via T3.2.5 and issues a parameterised `INSERT INTO events (...) VALUES (...), (...) ... ON CONFLICT (event_id, occurred_at) DO NOTHING`, typed against `NewEvent` from T1.2.4. Both statements are batched for the whole flush, never one per event — the `ON CONFLICT` target is exactly the partitioned primary key, which is why the PK was shaped that way in T1.2.2.
→ **files** `apps/worker/src/batch/flush.ts` · `apps/worker/src/batch/flush.test.ts` · **verify** `pnpm test flush.test.ts` applies the same 100-event batch twice against a testcontainer and asserts one set of rows both times, that exactly TWO statements are issued per flush (one batched destination SELECT, then one batched INSERT) and never one per event, and that enrichment columns are populated · **after** T3.3.1, T3.2.5, T1.2.4

#### T3.3.3 · `feat: retry the batch, then split to isolate the poison row` ✅ done (`acc5d88`)
On insert failure the batch is retried whole with exponential backoff; on repeated failure it is binary-split and each half retried, recursing until a single failing event is isolated while every healthy event still commits. The naive alternative — drop the batch — loses 99 good events to punish one bad one, and the naive opposite — retry forever — wedges the queue.
→ **files** `apps/worker/src/batch/split-retry.ts` · `apps/worker/src/batch/split-retry.test.ts` · **verify** `pnpm test split-retry.test.ts` plants one event with an oversized `slug` in a batch of 100 and asserts 99 rows commit, the offending `event_id` is returned as poison, and the split performs O(log n) not O(n) round trips · **after** T3.3.2

#### T3.3.4 · `feat: send the poison row to the DLQ with its payload`
The isolated event from T3.3.3 goes to `EVENTS_DLQ_QUEUE` via `DlqService` carrying its full payload and the SQLSTATE, and the flush then reports success for the rest of the batch. Never a silent drop: a poison row that vanishes is an event Postgres and R2 will disagree about forever, with nothing to point at.
→ **files** `apps/worker/src/batch/split-retry.ts` · `apps/worker/src/batch/poison-dlq.test.ts` · **verify** `pnpm test poison-dlq.test.ts` asserts one DLQ entry containing the full event payload and a SQLSTATE, that the entry can be re-submitted through `flushBatch` after the underlying fault is removed, and that no event is dropped without a DLQ record · **after** T3.3.3, T3.1.5

#### T3.3.5 · `test: idempotency under overlapping and interleaved batches` [INV-8]
Beyond T3.3.2's same-batch-twice: partially overlapping batches, the same `event_id` split across two different batches, and concurrent flushes of overlapping sets. Asserts the final row count always equals the count of distinct `event_id` values. BullMQ is at-least-once, so overlap is the normal case, not the edge case.
→ **files** `apps/worker/src/batch/idempotency.test.ts` · **verify** `pnpm test idempotency.test.ts` asserts row count equals distinct `event_id` count across all three scenarios, and that the surviving row for a duplicated id is the first-written one · **after** T3.3.4

#### T3.3.6 · `perf: throughput benchmark for 10k events through the batch path`
Feeds 10k generated events through accumulator → enrichment → insert against a testcontainer, reporting events/sec, p95 flush duration and statement count. Fails below a floor (100 batches, ≥2000 events/sec locally) so a future per-event `INSERT` regression shows up as a red test rather than as a queue backlog in production.
→ **files** `apps/worker/src/batch/throughput.bench.test.ts` · **verify** `pnpm test throughput.bench.test.ts` asserts exactly 100 insert statements for 10k events and throughput above the floor · **after** T3.3.5

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

#### T3.4.1 · `feat: S3-compatible R2 client in packages/core/src/r2` ✅ done (`787d817`)
A single `S3Client` built from `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_EVENTS` (already validated in T0.3.6), with `forcePathStyle: true` so the same code addresses MinIO locally and R2 in production. Constructed once at module load, never per batch. [security] — credentials are read from env and never logged, including in the SDK's error paths.
→ **files** `packages/core/src/r2/client.ts` · `packages/core/src/r2/client.test.ts` · **verify** `pnpm test r2/client.test.ts` puts and re-reads an object against the compose MinIO from T0.4.4, and asserts a forced auth failure produces an error message containing no part of the secret key · **after** T0.4.4, T0.3.6

#### T3.4.2 · `feat: NDJSON serializer for event batches` [INV-4][INV-6] ✅ done (`9e00a07`)
`serializeBatch(events)` emits one JSON object per line, newline-terminated, UTF-8. Fields are copied through an **explicit allowlist** matching the `events` column set from spec §8 — not a spread — so a future extra field on the payload cannot silently reach the durable log. An `ip` or a verdict cannot appear in the log because the serializer has no key for one.
→ **files** `packages/core/src/r2/ndjson.ts` · `packages/core/src/r2/ndjson.test.ts` · **verify** `pnpm test ndjson.test.ts` asserts line count equals batch length, every line round-trips through `JSON.parse`, the emitted key set equals the `events` column list, and a payload with planted `ip` and `classification` keys serializes without them · **after** T3.2.5

#### T3.4.3 · `feat: partitioned R2 key scheme` ✅ done (`f1af8f2`)
`eventBatchKey(batchId, occurredAt)` → `events/dt=YYYY-MM-DD/hour=HH/<batchId>.ndjson`, always in UTC so a São Paulo `-03:00` timestamp partitions by its instant and not its local date. The key is derived from the `batch_id` minted once in T3.3.1, so every retry of the same batch PUTs to the same key and overwrites rather than duplicating.
→ **files** `packages/core/src/r2/keys.ts` · `packages/core/src/r2/keys.test.ts` · **verify** `pnpm test keys.test.ts` asserts `2026-07-21T02:30:00-03:00` produces `dt=2026-07-21/hour=05`, that hours are zero-padded, and that the same `batch_id` yields a byte-identical key across calls · **after** T3.4.2

#### T3.4.4 · `feat: one R2 PUT per batch from the flush path` ✅ done (`10c25e0`)
`flushBatch` serializes the batch and issues a single `PutObject`. One PUT per batch, never per event — R2 bills per PUT, and one object per click is real money at any volume, quite apart from turning a 10k-event burst into 10k round trips.
→ **files** `apps/worker/src/batch/flush.ts` · `apps/worker/src/batch/r2-put.test.ts` · **verify** `pnpm test r2-put.test.ts` flushes batches of 1, 100 and 100 against MinIO and asserts the PUT count is 3 and not 201, and that each object's line count matches its batch · **after** T3.4.3, T3.3.2

#### T3.4.5 · `feat: retry the R2 PUT and DLQ the batch on exhaustion`
Exponential backoff over 5 attempts on retryable S3 errors (5xx, timeouts, throttling); non-retryable errors (403, 404 on the bucket) fail immediately since retrying a misconfiguration only delays the alert. On exhaustion the whole batch goes to the DLQ with its payload intact.
→ **files** `apps/worker/src/batch/r2-retry.ts` · `apps/worker/src/batch/r2-retry.test.ts` · **verify** `pnpm test r2-retry.test.ts` asserts a PUT failing twice then succeeding lands the object, that 5 failures produce one DLQ entry holding all 100 events, and that a 403 fails after a single attempt · **after** T3.4.4, T3.1.5

#### T3.4.6 · `feat: couple the two writes — no Postgres commit if R2 failed` [INV-7]
Flush order becomes R2 PUT **then** the Postgres insert. If the PUT exhausts its retries, the transaction is never opened and the batch goes to the DLQ whole. The reverse order is the one that quietly kills invariant 7: Postgres would hold rows the log has never seen, and the "rebuildable projection" would rebuild into something smaller than what it replaced. The surviving asymmetry — R2 ahead of Postgres — is the recoverable one, because replay closes it.
→ **files** `apps/worker/src/batch/flush.ts` · `apps/worker/src/batch/coupled-writes.test.ts` · **verify** `pnpm test coupled-writes.test.ts` stops the MinIO container mid-run and asserts zero new rows in `events`, one DLQ entry, and that after MinIO returns the DLQ entry replays into both stores · **after** T3.4.5

#### T3.4.7 · `test: both stores agree after 10k events` [INV-7]
Pushes 10k events, drains, lists every NDJSON object in the covered hour prefixes, and compares the `event_id` set against Postgres **in both directions** — a one-directional check passes while Postgres silently holds extra rows, which is exactly the divergence T3.4.6 exists to prevent.
→ **files** `apps/worker/src/batch/reconciliation.test.ts` · **verify** `pnpm test reconciliation.test.ts` asserts the two sets are equal, that the symmetric difference is empty in both directions, and that each event's enrichment fields match between the NDJSON line and its row · **after** T3.4.6

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

#### T3.5.1 · `test: end-to-end pipeline harness over real Redis, Postgres and MinIO`
A shared harness that boots Postgres via the testcontainers helper from T1.1.2 plus Redis and MinIO containers, starts the real worker process, and exposes `push(n)` (generating events from the T3.2.6 UA corpus through the real BullMQ producer), `drain()` (waits on `last_flush_age_ms` from the health endpoint) and `stop()`. Every test in this story reuses it rather than each booting its own stack.
→ **files** `apps/worker/src/test/pipeline-harness.ts` · `apps/worker/src/test/pipeline-harness.test.ts` · **verify** `pnpm test pipeline-harness.test.ts` pushes 10 events, drains, asserts 10 rows and one R2 object, and that `stop()` releases all three containers · **after** T3.4.7, T1.1.2

#### T3.5.2 · `test: 10k events land exactly once in Postgres and once in R2` [INV-7][INV-8]
The epic's "done when" condition, through the real queue rather than by calling `flushBatch` directly: 10k events pushed, drained, then asserted at exactly 10k distinct rows and a matching `event_id` set across every R2 object. T3.4.7 tested the flush path; this tests the whole pipe including the consumer and the queue.
→ **files** `apps/worker/src/test/e2e-exactly-once.test.ts` · **verify** `pnpm test e2e-exactly-once.test.ts` asserts `count(*) = count(distinct event_id) = 10000` and R2/Postgres set equality · **after** T3.5.1

#### T3.5.3 · `test: duplicate delivery produces no duplicate rows` [INV-8]
Re-enqueues 500 of the 10k jobs with their original `event_id` values after the first drain, across a batch boundary so the duplicates land in different batches than the originals. BullMQ is at-least-once by design, so this is the normal steady state, not a fault injection.
→ **files** `apps/worker/src/test/e2e-duplicate-delivery.test.ts` · **verify** `pnpm test e2e-duplicate-delivery.test.ts` asserts the row count stays at 10000 after re-delivery and that no row's `occurred_at` was rewritten · **after** T3.5.2

#### T3.5.4 · `test: worker killed mid-batch loses nothing and doubles nothing`
SIGKILL — not SIGTERM, which T3.1.8 already covers — while a partial batch is buffered, then restart and drain. Asserts BullMQ redelivers the un-acked jobs and the final row count equals the distinct `event_id` count. This is the case where idempotency stops being theoretical: the buffered events *will* arrive twice.
→ **files** `apps/worker/src/test/e2e-kill-recovery.test.ts` · **verify** `pnpm test e2e-kill-recovery.test.ts` asserts no loss and no duplication after SIGKILL at three different points in the batch window · **after** T3.5.3

#### T3.5.5 · `test: enrichment fields correct end-to-end across the UA fixture corpus`
Pushes the whole T3.2.6 corpus through the live pipeline and asserts each row's enrichment columns match the fixture's expected values, and that the NDJSON line for the same event agrees. The unit test proves the function; this proves nothing between the consumer and the two writers drops or reorders a field.
→ **files** `apps/worker/src/test/e2e-enrichment.test.ts` · **verify** `pnpm test e2e-enrichment.test.ts` asserts every fixture's expected enrichment in both stores, and that no row carries a non-null value in a column the fixture expects null · **after** T3.5.4

#### T3.5.6 · `test: Postgres outage retries and eventually lands with no loss`
Pauses the Postgres container mid-drain, holds it down past several flush intervals, restores it, and asserts every event eventually lands exactly once. Also asserts the R2 objects written during the outage are the ones the recovered rows correspond to — the outage window is precisely where the two stores are allowed to diverge temporarily, and it must close.
→ **files** `apps/worker/src/test/e2e-pg-outage.test.ts` · **verify** `pnpm test e2e-pg-outage.test.ts` asserts final row count equals events pushed, zero DLQ entries, and store equality after recovery · **after** T3.5.5

#### T3.5.7 · `test: R2 outage retries and eventually lands, and Postgres does not run ahead` [INV-7]
Pauses MinIO mid-drain and asserts the flush path writes **nothing** to Postgres for the affected batches — the coupling from T3.4.6 observed through the real pipeline — then restores MinIO and asserts everything lands in both stores. The assertion that matters is the negative one taken during the outage.
→ **files** `apps/worker/src/test/e2e-r2-outage.test.ts` · **verify** `pnpm test e2e-r2-outage.test.ts` asserts the Postgres row count is frozen while MinIO is down, and full store equality after recovery · **after** T3.5.6

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

#### T3.6.1 · `feat: date-range prefix enumeration for the R2 event log` ✅ done (`6161e09`)
`eventPrefixes(from, to)` yields `events/dt=YYYY-MM-DD/hour=HH/` for every hour in an inclusive UTC range — the exact inverse of T3.4.3's key builder, so a change to the layout breaks one test rather than silently narrowing a replay. Pure and testable without R2 or a network.
→ **files** `packages/core/src/r2/keys.ts` · `packages/core/src/r2/prefixes.test.ts` · **verify** `pnpm test prefixes.test.ts` asserts a single day yields 24 prefixes, a 3-day range yields 72, `from === to` yields 24 not 0, and that every emitted prefix is a prefix of a key produced by `eventBatchKey` for an instant inside the range · **after** T3.4.3

#### T3.6.2 · `feat: memory-bounded streaming NDJSON reader over an R2 prefix range`
An async generator that paginates `ListObjectsV2` (1000 keys per page) across the prefixes from T3.6.1 and streams each object body line by line, parsing one record at a time. It never materialises an object, a page, or a range in memory — the whole point of replay is the day the range is a year wide, and a reader that buffers works perfectly in every test and OOMs exactly then.
→ **files** `packages/core/src/r2/ndjson.ts` · `packages/core/src/r2/stream-read.test.ts` · **verify** `pnpm test stream-read.test.ts` writes 500 objects × 100 lines to MinIO, streams all 50 000 records, asserts the count and ordering by key, and asserts peak RSS sampled during the run stays under 128 MB · **after** T3.6.1

#### T3.6.3 · `feat: replay feeds records through the live insert path`
The replay driver batches streamed records and calls the **same** `flushBatch` from T3.3.2 (Postgres side only — replay reads the log, it never re-PUTs it), so `ON CONFLICT` semantics, enrichment and column mapping are identical to live by construction. A parallel "restore" implementation drifts from the real one and you find out on the day you need it.
→ **files** `apps/worker/src/cli/replay-driver.ts` · `apps/worker/src/cli/replay-driver.test.ts` · **verify** `pnpm test replay-driver.test.ts` asserts replayed rows are byte-identical to live-written rows for the same input, and that no `INSERT INTO events` string literal exists anywhere in the repo outside `apps/worker/src/batch/flush.ts` · **after** T3.6.2, T3.3.2

#### T3.6.4 · `feat: posta replay CLI with range and tenant filters`
`posta replay --from <date> --to <date> [--tenant <id>] [--dry-run]`. Dates are parsed as UTC and rejected loudly if inverted or unparseable rather than silently replaying nothing. `--tenant` filters records after parse. `--dry-run` counts without inserting, so an operator can size the job before running it under pressure.
→ **files** `apps/worker/src/cli/replay.ts` · `apps/worker/src/cli/replay.test.ts` · **verify** `pnpm test replay.test.ts` asserts `--from` after `--to` exits non-zero naming the flag, `--tenant` restricts inserted rows to that tenant, and `--dry-run` inserts nothing while reporting a non-zero count · **after** T3.6.3

#### T3.6.5 · `feat: replay progress and final reconciliation report`
Periodic progress to stderr (objects read, records parsed, elapsed) and a final report on stdout: objects read, records parsed, rows inserted, rows skipped as already-present, and rows rejected with reasons. `inserted + skipped = parsed` is asserted before exit — if it does not hold, replay exits non-zero, because a rebuild that quietly lost 40 rows is worse than one that failed.
→ **files** `apps/worker/src/cli/replay-report.ts` · `apps/worker/src/cli/replay-report.test.ts` · **verify** `pnpm test replay-report.test.ts` asserts the arithmetic holds on a clean range, that a half-populated range reports non-zero skipped, and that a forced mismatch exits non-zero · **after** T3.6.4

#### T3.6.6 · `test: truncate an events partition and rebuild it from R2` [INV-7]
The headline test of this epic. Pushes a month of events through the live pipeline, snapshots the partition (all columns, ordered by `event_id`), `TRUNCATE`s that partition only, runs `posta replay` over its range, and asserts row-for-row equality with the snapshot — every column, same count, no extras in neighbouring partitions. Without this, invariant 7 is decoration.
→ **files** `apps/worker/src/cli/truncate-and-restore.test.ts` · **verify** `pnpm test truncate-and-restore.test.ts` asserts the post-replay partition is identical to the pre-truncation snapshot and that adjacent partitions are untouched · **after** T3.6.5, T3.5.7

#### T3.6.7 · `test: replay over a fully-populated range changes nothing` [INV-8]
Runs replay twice over an intact range and asserts zero rows inserted on both passes, every row's contents unchanged, and the report showing skipped equal to parsed. This is what makes replay safe to run when you are not sure whether you need it — which is the only state anyone is ever in.
→ **files** `apps/worker/src/cli/replay-idempotency.test.ts` · **verify** `pnpm test replay-idempotency.test.ts` asserts 0 inserted / N skipped on both runs and an unchanged row-hash over the range · **after** T3.6.6

#### T3.6.8 · `docs: replay runbook for the disaster case`
The procedure an operator follows at 3am: how to identify the affected range, how to check R2 coverage before truncating anything, the `--dry-run` sizing step, the actual command, how to read the reconciliation report, and what to do when `inserted + skipped ≠ parsed`. Also states plainly what replay cannot recover — events that never reached R2, which is why T3.4.6 couples the writes.
→ **files** `docs/runbooks/replay.md` · **verify** an operator who has not read this epic can follow the runbook end to end against a local stack and reproduce T3.6.6 by hand · **after** T3.6.7

> Replay must reuse the live insert path. A separate "restore" implementation drifts from the real one, and you find out on the day you need it.
