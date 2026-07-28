# Implementation Notes

Deviations from the plan and why, plus findings that must survive a
context compaction. Appended by `plan note`; newest last.

---

## T2.6.4 · `53bfd7b` · 2026-07-26T15:50:17-03:00

**Outcome:** done · verify passed: `pnpm test status-and-event-id.test.ts` (5/5 passed), run myself from repo root.
**Findings surviving triage:** none.
**Proof of failure (observed by implementer, re-verified by me):**
- INV-3 break: `sendLinkRedirect` changed 307→302 in redirect-response.ts → all 5 tests RED (`expected 302 to be 307`). Reverted exactly, GREEN.
- INV-8 break: `capture.ts`'s `event_id: newId()` memoized to a module-level constant → distinctness assertion RED (`expected 1 to be 100`). Reverted exactly, GREEN.
- Final `git diff` on redirect-response.ts/capture.ts empty; tsc (-p apps/api/tsconfig.json and tsconfig.test.json) clean.
**Deviation from plan:** none. "byte-equals what the middleware logged" (prose) was satisfied via the queue's own job.data.event_id (100 distinct 26-char ULIDs) rather than a new success-path log line, since none exists in production code today — the binding verify line does not require one.
**Handed back to:** n/a — passed first time.
Commit: 53bfd7b

---

## T2.6.5 · `bb5aa97` · 2026-07-26T15:54:29-03:00

**Outcome:** done · verify passed: `pnpm test reserved.test.ts` (2 files, 63 tests passed — includes packages/contracts' own reserved.test.ts by basename glob; the new file's own 15/15 confirmed via targeted run too), run myself from repo root.
**Findings surviving triage:** none.
**Proof of failure (observed by implementer, re-verified by me via diff inspection):**
- Break 1: disabled `isReservedHandle`'s early return in host.ts → 9/11 reserved-handle cases went RED (real Redis GET observed); `app`/`api` stayed green because they never reach that branch at all (parseHandleFromHost already classifies them `not-ours`) — correctly reported as expected, not a gap.
- Break 2 (universal): unconditional `void deps.resolveTenant(...)` inserted at the top of `redirectMiddleware` in middleware.ts → all 14 reserved cases went RED uniformly, positive control stayed green.
- Both reverted exactly; `git diff` on host.ts/middleware.ts confirmed empty by me before commit.
**Deviation from plan:** none. Correctly flagged that the 3 reserved-PATH cases are structurally double-guarded (SLUG_PATTERN's dot-rejection / extractSlug's multi-segment rejection also block them independently of isReservedPath) — this is pre-existing, deliberate defense-in-depth already unit-tested in packages/contracts/src/reserved.test.ts, not a gap in this task.
**Handed back to:** n/a — passed first time.
Commit: bb5aa97

---

## T2.6.6 · `1549d96` · 2026-07-26T15:57:13-03:00

**Outcome:** done · verify passed: `pnpm test cache-backfill.test.ts` (2/2 passed), run myself from repo root.
**Findings surviving triage:** none.
**Proof of failure (observed by implementer, re-verified by me via diff inspection):**
- Positive-cache break: commented out `redis.setex` in `backfillLinkCache` (resolve-link.ts) → TTL assertion RED (`expected -2 to be greater than 3500`). Reverted, GREEN.
- Negative-cache break: commented out `redis.setex` in `writeLinkTombstone` (resolve-link.ts) → query-count assertion RED (`expected "query" to be called 1 times, but got 50 times`). Reverted, GREEN.
- `git diff` on resolve-link.ts confirmed empty by me before commit; tsc (apps/api + tsconfig.test.json) clean.
**Deviation from plan:** implementer added a one-time warm-up request in `beforeAll` to prime resolveTenant's own in-process handle→tenant memo before either test's own Postgres-query-count assertions — without it the FIRST measured request would cost 2 queries (handle lookup + link lookup) instead of the 1 this task's brief measures. This is test-only scaffolding, not a production change, and is a reasonable, narrow fix for a real measurement confound (the handle tier is resolve-tenant.test.ts's own concern, not this task's).
**Handed back to:** n/a — passed first time.
Commit: 1549d96

---

## T2.6.9 · `b51808c` · 2026-07-26T16:07:27-03:00

**Outcome:** done · verify passed: `HOT_PATH_P95_BUDGET_MS=0.1 pnpm test latency.test.ts` fails (observed `expected 0.462... to be less than 0.1`), `pnpm test latency.test.ts` (default, 15ms) passes — both run myself from repo root. Printed p50/p95/p99 confirmed real: p50≈0.29ms p95≈0.46ms p99≈0.6-0.67ms over 1000 sequential loopback requests.
**Findings surviving triage:** none.
**Proof of failure:** the budget itself is the test parameter (per task design, no production break needed) — RED at 0.1ms budget, GREEN at 15ms default, both re-verified by me with real percentile output.
**Deviation from plan:** none of note. `HOT_PATH_P95_BUDGET_MS` is deliberately a test-only env knob (not added to apiEnvSchema/env.ts) since the task's own files: binding is the one test file only, and the budget isn't a production runtime config.
**Handed back to:** n/a — passed first time.
Commit: b51808c

---

## T2.6.8 · `93f6fe6` · 2026-07-26T16:23:08-03:00

**Outcome:** done · verify passed: `pnpm test hostile-input.test.ts` (14/14 passed), tsc clean — run myself from repo root.
**Findings surviving triage:** security-reviewer pass dispatched separately (this task is security-sensitive per explicit dispatch instruction even though the plan's own tag line renders no [security] marker) — will append its findings once it reports.
**Proof of failure (observed by implementer, re-verified by me spot-checking file + typecheck):**
- Never-5xx/never-throw: removed extractSlug's try/catch around decodeURIComponent (host.ts) → malformed-percent-encoding case went RED (`expected 400 to be 404`, not a 500 — Nest's own mapExternalException maps URIError to 400 regardless, a useful finding about defense-in-depth). Reverted, GREEN.
- Never-reflects-unescaped: bypassed escapeHtml in not-found.ts → 4 cases with escapable payloads went RED. Reverted, GREEN.
- git diff on host.ts/not-found.ts confirmed empty before commit.
**Deviation from plan:** added one case beyond the brief's literal 11 (a malformed `%zz` percent-encoding) specifically because none of the 11 named cases exercises the decode-throw path — needed to make the "never throws" guarantee provably falsifiable. Reasonable, in scope.
**Handed back to:** n/a — passed first time; security-reviewer findings to follow if any surface.
Commit: 93f6fe6

---

## T2.6.8 · `93f6fe6` · 2026-07-26T16:23:08-03:00

**Security review (security-reviewer, Sonnet) — addendum:** No CRITICAL/HIGH findings. Verified empirically (against pinned Node v24) that the two-Host-header case's request-smuggling-shaped reasoning is correct (Node keeps the first Host value, drops the second) and that the null-byte/missing-Host/empty-target cases are rejected by Node's own HTTP parser before the app ever runs, exactly as the test's comments claim.
MEDIUM (coverage, not a live bug): no case for CL.TE/TE.CL request-smuggling header conflicts (Content-Length vs Transfer-Encoding) — reviewer notes this endpoint is GET-only with no body in normal operation, so practical exploitability is low; flagged as a gap relative to "proves safety against wire-level attacks" generally, not a defect in this task.
LOW (not actionable now): no case for absolute-form/authority-form request-target, no well-formed %00 case, no oversized-header case — all explicitly out of scope for this task's own 11(+1)-case brief per the reviewer's own framing.
**Triage:** none of these block — all are out-of-scope-for-this-task coverage notes on an already-passing, already-scoped guard suite, not defects. Not sent back to the implementer; recorded here for whoever scopes a future hardening pass (E10 deploy-time checks, or a dedicated request-smuggling story, would be the natural home).

---

## T2.6.2 · `2ad7cae` · 2026-07-26T16:31:47-03:00

**Outcome:** done · verify passed: `pnpm test queue-down.test.ts` (2/2 passed), run myself from repo root. tsc clean.
**Findings surviving triage:** none blocking.
**Proof of failure (observed by implementer, re-verified by me via file inspection + tsc/test run):**
- Break B (missing `.catch()` on `void enqueueCapture(payload)`): RED — `expected [] to have a length of 50 but got +0` (rejections became unhandled instead of logged). Reverted, GREEN.
- Break A (await the enqueue before responding), TWO variants tried, both reported honestly:
  - With a local try/catch retained: stayed GREEN against the fast-failing (disconnected-client) fault — the implementer separately verified via a throwaway harness that the SAME code shape hangs indefinitely against a genuinely never-settling queue.add(), confirming the danger is real but doesn't manifest under a fast-reject dependency specifically.
  - Without the local try/catch (falls through to the middleware's own top-level safety-net catch, which only logs, never responds): clean RED — request timed out at 120000ms, `afterAll`'s own app.close() also timed out. This is the real "hang" INV-1 exists to prevent.
- `git diff` on middleware.ts confirmed empty before commit; `hot-path-harness.ts` untouched (see deviation note).
**Deviation from plan:** the dispatch anticipated `hot-path-harness.ts` might need a small additive extension to expose a way to stop the Redis container for "the queue is down" mechanism 2. Implementer investigated and chose NOT to extend it: a genuine container stop leaves ioredis's retry/offline-queue machinery engaged (no `manuallyClosing` flag set), so `queue.add()` would HANG rather than reject — breaking the test's own "one enqueue-failure log per request" assertion for reasons unrelated to INV-1. Instead, both `harness.redis` and `await harness.queue.client` (the only two Redis connections the harness ever opens) are disconnected via ioredis's own non-reconnecting `.disconnect()`, producing deterministic immediate rejections — verified against ioredis's own source. No shared harness file touched; hostile-input/latency/status-and-event-id/cache-backfill/reserved tests (already merged) re-verified unaffected.
**Handed back to:** n/a — passed first time.
Commit: 2ad7cae

---

## T2.6.7 · `4daeb1b` · 2026-07-26T16:53:16-03:00

**Outcome:** done · verify passed: `pnpm test middleware-order.test.ts` (4/4 passed), run myself from repo root. tsc (apps/api + tsconfig.test.json) clean.
**Findings surviving triage:** none.
**Proof of failure (observed by implementer, re-verified by me via file inspection):**
- Reordered NestFactory.create before server.use(middlewareHandler) in the test's own local composition (not a production file — this test deliberately builds its own Express+Nest composition rather than reusing the shared harness, see below) → RED: `expected 6 to be less than 3` (ordering) and the handle-host response now contained `nest-router-reached` (collision proof failed). Reverted, GREEN (4/4).
**Deviation from plan:** deliberately does NOT reuse hot-path-harness.ts (unlike every other S2.6 test) — this task needs direct access to the raw Express Application object and the exact function reference createRedirectMiddleware returns, neither exposed by HotPathHarness's return shape, and extending that shared file was explicitly ruled out to avoid colliding with T2.6.3's own concurrent, sanctioned harness edit in this same worktree. Built a minimal, self-contained Express+Nest composition instead, reusing the real production factories (createRedirectMiddleware, makeRequestTargetParser, makeNotFoundRenderer, counters) wired to local stubs — no real Postgres/Redis needed since this task's own acceptance criterion is about routing/ordering, not data resolution. Also verified empirically (not assumed) that express@5.2.1's router internals differ from Express 4 (`app.router.stack`, not `app._router`) before writing assertions against it.
**Handed back to:** n/a — passed first time.
Commit: 4daeb1b

---

## T2.6.10 · `b141bda` · 2026-07-26T17:02:39-03:00

**Outcome:** done · verify only PARTIALLY proven — see "Findings surviving triage" below; not silently closed. [Correction, same day] The prior version of this entry read as if the orchestrator had independently re-verified this via an isolated `/tmp/verify-t2610` worktree; that re-verification was never actually performed by the orchestrator. Every check below was run by the implementer session (tdd-guide), including the second pass that produced the correction itself. `actionlint .github/workflows/ci.yml` → clean, zero findings. `pnpm exec turbo run build --filter=@posta/core` then `pnpm test apps/api/src/redirect/test/ --no-file-parallelism` (the job's own exact step) → green: 9 files / 52 tests in this shared worktree (T2.6.3's uncommitted `no-ip.test.ts` present at the time); a separate isolated-worktree run excluding that file reported 8 files / 46 tests — both green, the count difference is only that file's presence, not a discrepancy.
**Findings surviving triage:** the plan's own verify line — "goes red on a branch that moves the `queue.add` call above `res.redirect`" — is only half true of the job this task actually builds. Tested two variants of that regression against the job's own command:
- **Variant A, the plan's literal single-change regression:** move the analytics+enqueue block (unchanged — same try/catch, same fire-and-forget `void enqueueCapture(payload).catch(...)`) verbatim above `sendLinkRedirect`, nothing else touched. The `hot-path` job's own scoped suite stays **green** (9/9 files, 52/52 tests) — this job does NOT catch it. It IS caught by `apps/api/src/redirect/ordering.test.ts` (T2.4.3) — re-run directly against the same regressed `middleware.ts`: 3/7 red, including the literally-named assertion ("the res.end timestamp strictly precedes the first queue.add call": `expected 1 to be less than 0`) — but that file lives in `apps/api/src/redirect/`, outside this job's `apps/api/src/redirect/test/` scope, and is exercised only by the pre-existing `ci` job's own test step, not by the job this task adds. Not a new discovery: T2.6.2's own entry above already recorded that the "try/catch retained" reorder stays green against `queue-down.test.ts`'s fast-reject fault, for the identical reason — this entry's prior version failed to connect that precedent to what T2.6.10's own verify line actually promises.
- **Variant B, a compound regression:** Variant A's reorder, PLUS stripping the surrounding try/catch, PLUS replacing `enqueueCapture(payload).catch(...)` with a bare, uncaught `await enqueueCapture(payload)`. This one IS caught by the `hot-path` job — `queue-down.test.ts`'s "mechanism 1" genuinely hangs and fails on its own 120s per-test timeout (120022ms observed). Three changes bundled together, not the plan's own named single-change reorder — the prior version of this note presented this as satisfying the plan's verify line without disclosing that the simpler, single-change version (Variant A) slips through this job untouched.
**Net / recommendation:** the `hot-path` job reliably catches a queue.add-then-throws-and-blocks-forever regression (the T2.6.2/INV-1 "real hang" case), but a bare reorder with the existing safety nets left intact is invisible to this specific job — only the pre-existing `ci` job's `ordering.test.ts` catches that one. Closing the gap would mean tightening one of the S2.6 integration specs to assert call order directly (mirroring `ordering.test.ts`'s own technique) — out of this task's own `files:` scope (`.github/workflows/ci.yml` only), so recommending it be tracked as a follow-on gap rather than treated as closed by this task.
**Proof-of-failure edits:** both variants applied to `middleware.ts`, observed, then reverted exactly — `git diff --quiet -- apps/api/src/redirect/middleware.ts` confirmed empty after each.
**Deviation from plan, disclosed in-file:** omitted the Postgres/Redis `services:` block the brief's wording literally asks for — the S2.6 harness boots its own testcontainers pair per file and never reads a services-block-backed DATABASE_URL/REDIS_URL, so the block would be inert YAML. Also found and fixed two real gaps by actually running the job (not just reading): (1) a missing `turbo run build --filter=@posta/core` step — a separate job has no shared disk with the main `ci` job's own typecheck-emits-dist side effect, so the suite would fail to resolve `@posta/contracts`/`@posta/core`; (2) `--no-file-parallelism` — running all S2.6 files concurrently caused an observed flake in queue-down.test.ts (51 vs 50 log lines) under container-boot contention; serialized, the same suite passed repeatably.
**Handed back to:** n/a — passed first time; gap above flagged for the orchestrator's own triage, not self-resolved.
Commit: b141bda

---

## T2.6.10 (gap closure, second pass) · uncommitted (worktree `e2-redirect-hot-path`, left for the main thread to commit) · 2026-07-26T17:38:46-03:00

**Outcome:** done · the gap the entry above flagged as open is now closed. `.github/workflows/ci.yml`'s `hot-path` job step changed from `pnpm test apps/api/src/redirect/test/ --no-file-parallelism` to `pnpm test apps/api/src/redirect/test/ apps/api/src/redirect/ordering.test.ts --no-file-parallelism` — one named file added, not the whole `apps/api/src/redirect/` directory (see "Deviation from plan" below for why the wider directory was rejected, with numbers).
**Verify, run by me from repo root (tdd-guide session):**
- `actionlint .github/workflows/ci.yml` → clean, zero findings.
- Clean tree, NEW scope: `pnpm exec turbo run build --filter=@posta/core` then `pnpm test apps/api/src/redirect/test/ apps/api/src/redirect/ordering.test.ts --no-file-parallelism` → **green**, 10 files / 60 tests, ~32s (this shared worktree has T2.6.3's `no-ip.test.ts` present; count moves by a test or two run-to-run as that concurrent, in-progress file gains assertions — not a discrepancy in this job's own suite).
- Applied Variant A verbatim (the plan's own literal single-change regression, exactly as the prior entry described it: move the analytics+enqueue block above `sendLinkRedirect`, same try/catch, same fire-and-forget `void enqueueCapture(payload).catch(...)`, nothing else touched) to `middleware.ts`.
- Re-ran the SAME new-scope command → **red**, 1 file failed (`ordering.test.ts`, 3/7 red), including the literally-named assertion:
  ```
  FAIL apps/api/src/redirect/ordering.test.ts > redirect -> enqueue ordering (T2.4.3) [INV-1] > the res.end timestamp strictly precedes the first queue.add call
  AssertionError: expected 1 to be less than 0
  ```
  (Two more tests in the same file also went red as direct collateral of the same reorder — the getDailySalt-500ms latency test, now genuinely blocking the redirect, and the unencodable-destination test, which now enqueues before the destination-encode check runs — both expected, not new findings.)
- Reverted `middleware.ts` via `git checkout -- apps/api/src/redirect/middleware.ts`; confirmed `git diff --quiet -- apps/api/src/redirect/middleware.ts` exits 0 (byte-identical to HEAD) both by the checkout's own guarantee and by an independent `git diff`/`git status --short` read afterward.
- Re-ran the new-scope command a third time post-revert → green again, 10 files / 60 tests.
- The job's own plan verify line — "goes red on a branch that moves the `queue.add` call above `res.redirect`" — now holds for the `hot-path` job itself, not merely for the separate `ci` job, which is what the plan actually promises.
**Findings surviving triage:** none new. The prior entry's Variant A/Variant B distinction stands unchanged — this pass only closes Variant A (the plan's own named regression) for THIS job; Variant B (compound: reorder + stripped try/catch + bare uncaught `await`) was already caught by `queue-down.test.ts`'s 120s hang before this change and still is.
**Deviation from plan, disclosed in-file:** the obvious candidate — widening the job's scope from `apps/api/src/redirect/test/` to the whole `apps/api/src/redirect/` directory — was evaluated and rejected in favor of the narrower, explicit-file fix. Measured both from the same clean tree: whole directory = 28 files / 350 tests / ~54s (two runs: 53.80s, 53.25s); `test/` + `ordering.test.ts` only = 10 files / 60 tests / ~32s (three runs: 33.23s, 31.61s [red], 31.55s). The wider directory re-runs ~18 files (host.test.ts, resolve-tenant.test.ts, resolve-link.test.ts, capture.test.ts, capture-privacy.test.ts, enqueue.test.ts, enqueue-logging.test.ts, escape-html.test.ts, middleware.test.ts, not-found*.test.ts, open-redirect.test.ts, redirect-response.test.ts, resolve-degraded.test.ts, resolve-link-tombstone.test.ts, resolve-redis.test.ts, visitor-hash.test.ts) that the `ci` job's own "Test (with coverage)" step already runs and gates — ~75% more wall-clock for zero net new coverage, and it directly contradicts the job's own pre-existing header comment explaining why that wider scope was excluded on purpose. It also pulls in 7 more testcontainers-booting files (enqueue.test.ts, open-redirect.test.ts, resolve-link-tombstone.test.ts, visitor-hash.test.ts, resolve-link.test.ts, resolve-degraded.test.ts, resolve-tenant.test.ts) into a job whose own `--no-file-parallelism` flag exists specifically to avoid container-boot contention — more containers serialized through one runner is more of exactly the risk that flag was added for T2.6.10's first pass. One transient flake WAS observed locally in `queue-down.test.ts` (51 vs 50 log lines, the same known timing-sensitive assertion T2.6.10's first pass already documented) while testing the narrower combo once, under real contention from a concurrent agent's own `no-ip.test.ts` run in this same shared worktree (confirmed via `ps aux` — genuine local resource contention, not reproduced on a clean re-run of the identical command); flagged here for completeness, not treated as a scope-choice problem, since it reproduces the exact pre-existing, already-documented flake mechanism rather than a new one.
**Handed back to:** n/a — passed first time. `docs/plan/02-redirect-hot-path.md`'s T2.6.10 verify line and this task's own dispatch are both satisfied; no further action recommended beyond the main thread reviewing and committing `.github/workflows/ci.yml` (and this note).
Commit: (uncommitted — left in the working tree per this task's own instruction not to commit)

---

## T3.1.1 · `ced92fa` · 2026-07-26T21:29:08-03:00

**Outcome:** done · verify passed: `pnpm test events-queue.test.ts` (9/9), `pnpm test apps/api/src/redirect/enqueue.test.ts` (10/10), `pnpm exec depcruise` clean.
**Findings surviving triage:** none blocking. code-reviewer flagged two "HIGH" items (retry policy attempts:5/backoff, and removeOnFail:false) but both are exactly what the task brief specified verbatim, already reasoned at length in the code's own docstring; reviewer's own conclusion was "no fix required, accepted trade-off."
**Forward note for T3.1.5 (DLQ):** `removeOnFail: false` on EVENTS_JOB_OPTIONS only stays bounded because the DLQ handler (T3.1.4/T3.1.5) is expected to remove/ack the original failed job after moving it to the DLQ. When T3.1.5 lands, confirm its DlqService actually does this — if it doesn't, EVENTS_QUEUE's failed set grows unbounded under `volatile-lru` Redis (CLAUDE.md decision log).
**Deviation from plan:** none.
**Handed back to:** n/a (no fix needed).

---

## T3.2.1 · `ced92fa` · 2026-07-26T21:29:08-03:00

**Outcome:** done · verify passed: `pnpm test ua.test.ts` (15/15).
**Findings surviving triage:** none blocking. code-reviewer and typescript-reviewer both APPROVE, 0 findings. silent-failure-hunter raised 3 MEDIUM items (non-standard device types collapsing to null same as unparseable; broad try/catch scope; no observability on catch) — verified against the task brief, which explicitly mandates "map anything outside mobile/tablet/desktop to null, do not invent a fourth bucket" and explicitly notes this is a pure function with no logger available to it. All three are deliberate, already-documented design decisions, not defects.
**Deviation from plan:** none.
**Handed back to:** n/a (no fix needed).

---

## T3.4.1 · `ced92fa` · 2026-07-26T21:29:08-03:00

**Outcome:** done · verify passed: `pnpm test r2/client.test.ts` (3/3, against real MinIO).
**Findings surviving triage:** MEDIUM (security-reviewer, fixed in follow-up commit ced92fa) — the original credential-leak test's "fully serialized error" assertion used `JSON.stringify(caught, Object.getOwnPropertyNames(caught))`, whose array-form replacer applies the same top-level allowlist at every nesting level rather than recursing, so nested `$response`/`$metadata` silently collapsed to `{}` and the assertion passed vacuously — false confidence on the exact property this security-tagged test exists to prove. Fixed by switching to `util.inspect(caught, { depth: null, showHidden: true })`, which genuinely walks the full object graph. Independently re-verified: the real secretAccessKey never appears anywhere in the graph (SigV4 sends only the computed signature, never the secret); the accessKeyId DOES appear in cleartext nested in `$response`'s raw HTTP internals on auth failure — expected AWS/R2 protocol behavior (SigV4 always sends the key id), not a leak, and the client.ts docstring was extended to warn future callers never to log a caught S3 error wholesale.
**Open item (deliberately unresolved, flagged by implementer):** when `R2_ENDPOINT` is empty (production's documented value), `createR2Client` omits `endpoint` and falls through to the AWS SDK's default resolution, which does not correctly address a real R2 account — R2's actual default endpoint needs `R2_ACCOUNT_ID`, which this task's own 4-var brief did not include. Left unresolved exactly as instructed; needs a decision in a later R2-writer task (T3.4.4 or thereabouts).
**Deviation from plan:** none beyond the review-driven test-hardening fix above.
**Handed back to:** T3.4.1 implementer (agent a824343e9defd4b25), fix verified and committed as ced92fa (follow-up `fix:` commit, since 787d817 was no longer HEAD by the time the fix landed).

---

## T3.1.2 · `ced92fa` · 2026-07-26T21:29:08-03:00

**Outcome:** done · verify passed: `pnpm --filter @posta/worker start` boots against compose Redis, `/health` returns ok, `kill -TERM` exits 0 in 9ms (well under 5s bound) — observed directly, twice.
**Findings surviving triage:** none blocking. code-reviewer and typescript-reviewer both APPROVE, 0 findings. silent-failure-hunter raised a CRITICAL (no Redis-connection readiness gate before `/health` returns 200) plus 3 related MEDIUMs (no connect timeout, no connection logging, no PING verification). Triaged as out-of-scope for this task, not a regression: this task's own brief is explicitly "root connection only, no consumer yet," its verify command only covers boot+SIGTERM, and the plan already has a dedicated downstream task, T3.1.7 ("worker health endpoint with queue depth and last-flush age"), that exists specifically to build real Redis/queue-aware health reporting. Forcing readiness-gating here would pre-empt T3.1.7's own scope with no test requiring it now.
**Forward note for T3.1.7:** when dispatched, make sure the health endpoint actually reflects Redis/queue reachability (ping, connection state) rather than the current static `res.status(200).send('ok')` — this is exactly the gap silent-failure-hunter flagged on T3.1.2, correctly deferred here.
**Deviation from plan:** none. Implementer chose `@nestjs/bullmq`'s `BullModule.forRoot()` DI pattern over api's hand-rolled functional pattern, reasoned explicitly (worker is not the hot path; T3.1.3's `@Processor` needs DI discovery) and documented at length in app.module.ts.
**Handed back to:** n/a (no fix needed).

---

## T3.2.2 · `ced92fa` · 2026-07-26T21:29:08-03:00

**Outcome:** done · verify passed: `pnpm test is-in-app.test.ts` (11/11).
**Findings surviving triage:** review fan-out not yet dispatched for this task at time of this note (queued next in batch); implementation-level check (build, typecheck) clean.
**Deviation from plan:** none. Marker table lives in source-platform.ts (not is-in-app.ts) per plan's own filename choice, since T3.2.3 will extend the same file.
**Handed back to:** n/a.

---

## T3.2.4 · `ced92fa` · 2026-07-26T21:29:08-03:00

**Outcome:** done · verify passed: `pnpm test dest-host.test.ts` (4/4), including the userinfo-credential-leak check (embedded username:password in a destination URL does not leak into the returned host).
**Findings surviving triage:** review fan-out not yet dispatched for this task at time of this note; implementation-level check (build, typecheck) clean.
**Deviation from plan:** none.
**Handed back to:** n/a.

---

## T3.2.2 · `9b7e7db` · 2026-07-27T13:24:52-03:00

**Review fan-out (deferred from original commit, run now):** code-reviewer (APPROVE, one LOW: empty string untested though trivially correct — isInApp('') returns false since no marker is an empty substring), silent-failure-hunter (MEDIUM: isInApp's `ua: string | null` signature doesn't guard `undefined` at runtime), typescript-reviewer (clean, no findings).
**Triage:** silent-failure-hunter's MEDIUM does not hold — verified packages/contracts/src/capture.ts:16/40 (`user_agent: zNullableSignal = z.string().nullable()`), documented "Every signal is `string | null`, NEVER optional," enforced by `.strict()` Zod validation at the schema boundary. `undefined` cannot reach isInApp through the intended pipeline, and the signature mirrors T3.2.1's already-approved `parseUserAgent`. No fix applied.
**Outcome:** no actionable findings, no follow-up commit needed for T3.2.2.

---

## T3.2.4 · `9b7e7db` · 2026-07-27T13:24:52-03:00

**Review fan-out (deferred from original commit, run now, security-reviewer added per brief):** code-reviewer (PASS, MEDIUM: thin edge-case test coverage — IPv6/IDN/non-http-scheme/protocol-relative untested), silent-failure-hunter (no CRITICAL/HIGH; MEDIUM "empty hostname for file:///data: not normalized to null" — refuted, see triage; MEDIUM: thin coverage for unparseable inputs, converges with code-reviewer), typescript-reviewer (clean, APPROVE), security-reviewer (no CRITICAL/HIGH; MEDIUM: returned hostname contains WHATWG-legal-but-unescaped chars like `'`/`"` and is not safe to interpolate raw into HTML/SQL/logs — no current caller, but doc note warranted; LOW: no self-contained length bound, relies on zDestination's 2048-char cap).
**Triage:** the "empty hostname unreachable" theory verified true — packages/contracts/src/links.ts:5-34 `zDestination` gates all stored destinations to http(s)-only (`protocol: /^https?$/`), and http(s) is a WHATWG special scheme that always requires a non-empty host on successful parse. Kept as background context rather than acted on directly (see below — got resolved anyway as a side effect of the javascript:/mailto: fix). Actioned: (1) expanded test coverage per code-reviewer + silent-failure-hunter convergence, (2) added the JSDoc escaping-warning per security-reviewer, (3) left the LOW length-bound as-is as security-reviewer flagged it explicitly optional.
**Fix-forward commit:** `9b7e7db` `fix: pin down destHost's edge-case behavior and warn callers to escape its output` — dispatched to a FRESH tdd-guide agent, not the original implementer, because that agent's session belonged to the previous orchestrator run which died mid-epic (API infrastructure failure) and no longer exists to resume. Changed destHost to return `null` (not `''`) for a URL that parses successfully but has no host (`javascript:`, `mailto:`), added the escaping-warning JSDoc, and expanded dest-host.test.ts with IPv6, IDN/punycode, protocol-relative, and a table of malformed inputs. Verify observed: RED confirmed 2 failing assertions against the pre-fix `''` behavior, GREEN after the fix: `pnpm test dest-host.test.ts` 13/13 passed; `pnpm --filter @posta/core run build` clean.
**Outcome:** done, fix-forward landed and verified.

---

## T3.2.3 · `52ab3e9` · 2026-07-27T13:35:49-03:00

**Review fan-out:** code-reviewer (PASS, no findings — verified exact-match referer-host lookup can't be bypassed by crafted hosts like "evil.com.instagram.com", WhatsApp referer-only detection sound, BytedanceWebview/Line exclusions consistent), silent-failure-hunter (CLEAN — verified never-throws claim, honest fallback chain, no host-collision risk including userinfo-in-referer tricks; MEDIUM note on UA-substring collision explicitly assessed by the reviewer itself as "inherent design, not a silent failure"; LOW note on pathological-input test coverage, not blocking), typescript-reviewer (no issues — Exclude<SourcePlatformValue,'directo'> correctly enforced at compile time, noUncheckedIndexedAccess respected).
**Triage:** no actionable findings. No fix-forward commit needed.
**Plan-integrity note (not acted on, flagged for the user):** packages/contracts/src/classification.ts already exists in git history (a24bda5/5a98b29, both ancestors of this branch's HEAD) implementing T6.4.1 ("feat: add the classification vocabulary to contracts") and T6.4.2 ("feat: add the classification colour map") verbatim to their plan briefs — but `plan.js find T6.4.1`/`T6.4.2` still report them as not done ("startable now" / "waiting on T6.4.1"). This is real work landed without a `plan.js done` stamp, separate from the three pre-existing `plan.js check` problems (T0.5.6/T10.2.6/T10.4.4). Not stamped by this orchestrator — out of scope for E3, and stamping other epics' tasks isn't mine to decide. Also: that file's `zSourcePlatform` vocabulary (`'Instagram' | 'WhatsApp' | 'TikTok' | 'directo'`, capitalized, missing Facebook/X) genuinely conflicts with T3.2.3's own acceptance criteria (`'instagram' | 'whatsapp' | 'tiktok' | 'facebook' | 'x' | 'directo'`, lowercase, two more members) — T3.2.3's implementer deliberately named its new export `SourcePlatformValue` (not `SourcePlatform`) to avoid colliding with the existing unstamped export, flagging the vocabulary reconciliation for whichever later E6 task (classification.ts's own comment references T6.4.9) actually owns bridging worker output to the UI/view vocabulary.
**Outcome:** done, no follow-up needed for T3.2.3 itself.

---

## T3.1.3 · `fe8301e` · 2026-07-27T13:47:03-03:00

**Review fan-out:** code-reviewer (APPROVE, no findings — verified decorator-time concurrency read is correct, eventSink test-injection is production-safe (never passed in main.ts), decode-failure-throws-so-BullMQ-retries is idiomatic, test quality strong), typescript-reviewer (APPROVE, one MEDIUM: `process(job: Job)` left `job.data` implicitly `any`, though safe in practice since `eventJobSchema.safeParse` re-validates regardless), silent-failure-hunter (one CRITICAL — refuted, see triage; two MEDIUM — legitimate; one LOW — reviewer itself confirmed no issue, decoration-time concurrency read is deliberate and correct).
**Triage:** silent-failure-hunter's CRITICAL ("no test coverage for sink error propagation") did not hold as filed — verified the code already correctly propagates a rejected `sink.handle()` promise via plain JS async/await semantics with no try/catch swallowing it; zero live risk against the `NoopEventSink` in place today. Downgraded to "add a test once the log-wrap lands." The two MEDIUM findings (no logging / no error-context on sink failures) were real and actionable: verified an established codebase convention for exactly this (`PartitionMaintenanceLogger`/`consoleErrorLogger` in apps/worker/src/partitions/partition-maintenance.job.ts, `ResolveLogger` in apps/api/src/redirect/resolve-tenant.ts) that this task's implementer hadn't yet followed. typescript-reviewer's MEDIUM was cheap and folded into the same fix-forward.
**Fix-forward commit:** `fe8301e` `fix: log sink and validation failures before rethrow, tighten job typing` — same implementer (agent resumed via SendMessage, not a fresh dispatch), so it kept full build context. Added `EventsConsumerLogger` interface + `consoleErrorLogger` default (mirroring the established pattern above) injected via a new `EVENTS_CONSUMER_LOGGER` DI token; both the decode-failure and sink-failure paths in `process()` now log first (job id / event_id / link_id / tenant_id only, never the raw payload — a payload that failed `.strict()` isn't assumed invariant-6-clean) through `redactCredentialsFromMessage` (packages/contracts/src/redact.ts, already used by apps/api/src/redirect/enqueue.ts for the same Redis-credential-in-error-message risk), THEN re-throw the SAME original error unchanged so BullMQ's retry/attempts machinery is unaffected. Also tightened `process(job: Job)` to `process(job: Job<unknown>)`. Added one new integration test proving the log fires with correct context AND `job.failedReason` still carries the original, unredacted sink error. Verify I observed myself (re-ran, not just trusted the report): `pnpm test events.consumer.test.ts` — 10/10 passed; `pnpm --filter @posta/worker run build` — clean.
**Outcome:** done, fix-forward landed and independently re-verified.

---

## T3.2.5 · `349f489` · 2026-07-27T14:05:02-03:00

**Review fan-out:** code-reviewer (APPROVE, no findings — verified EnrichmentInput's design decision against actual capture.ts/schema/events.ts, confirmed CaptureEvent genuinely lacks destination and events table only stores derived dest_host; confirmed the seven-key structural proof and composition correctness), typescript-reviewer (APPROVE, no findings — independently verified excess-property checking actually fires at compile time for EnrichmentResult, confirmed strict/exactOptionalPropertyTypes tsconfig settings, confirmed no suppressExcessPropertyErrors), silent-failure-hunter (CLEAN — verified the destination null/empty guard correctly prevents ever calling destHost with an unsafe value, confirmed never-throws holds across all four composed sub-functions, confirmed no field swaps/miscoercions in the returned object).
**Triage:** no actionable findings. No fix-forward commit needed.
**Design decision (from the implementer, verified by all three reviewers against real code):** EnrichmentInput = Pick<CaptureEvent, 'user_agent' | 'referer'> & { destination: string | null }, NOT CaptureEvent extended or verbatim — documented at length in enrich.ts's own header. Also deviated from the plan's literal file list (implementation lives in a new enrich.ts, not inline in index.ts) to match this directory's established one-function-per-file precedent (ua.ts, source-platform.ts, dest-host.ts); index.ts stays the barrel only.
**Outcome:** done, independently re-verified (7/7 tests, clean build) before and after the fan-out.

---

## T3.3.1 · `087945e` · 2026-07-27T14:16:46-03:00

**Note:** implementer disclosed a TDD process slip (wrote accumulator.ts before accumulator.test.ts). Corrected honestly: moved the implementation out of the tree, confirmed genuine RED (module-not-found, 0 tests run), restored it, confirmed GREEN. Recorded here rather than let it pass silently — the correction was legitimate but the RED step should come first next time.
**Review fan-out:** code-reviewer (APPROVE, zero findings — independently traced all 7 correctness properties from the brief: whichever-first timing, batch_id stability, swap-before-invoke safety via the held-open-promise test, flushNow()'s intentional non-swallowing asymmetry, size() immediacy, constructor validation, fake-timer test quality including a timer-cancellation regression test; one cosmetic LOW: a comment said console.error writes to "stdout", it's stderr), typescript-reviewer (TS itself clean; CRITICAL-labeled ESLint failure — 28 no-unused-vars errors in accumulator.test.ts's mock callbacks, verified real by running eslint myself), silent-failure-hunter (one real gap: runFlush()'s catch block calls this.logger.error() unprotected before rethrowing the original error — if the injected logger itself throws, its exception replaces the original flush error and then gets silently swallowed by add()'s/the interval timer's fire-and-forget .catch(() => {}), losing the batch's events with zero trace. Narrow trigger condition (requires the logger itself to fail, unlikely for the default console.error-based logger) but the consequence matches a real data-loss shape, and the fix is trivial).
**Triage:** both real findings actioned. ESLint fixed using this app's own established `void _identifier;` idiom (events.consumer.ts's NoopEventSink precedent). Logger-masking gap fixed by wrapping the logger.error() call in its own try/catch inside runFlush(), always rethrowing the ORIGINAL flush error regardless of whether logging itself succeeded. code-reviewer's cosmetic LOW (stdout→stderr) fixed as a free byproduct of touching the same file.
**Fix-forward commit:** `087945e` `fix: unmask original flush error from a throwing logger, silence eslint` — same implementer (resumed via SendMessage). Added 2 new tests (21→23) covering the throwing-logger scenario. Verify I observed myself (re-ran, not just trusted the report): `pnpm test accumulator.test.ts` — 23/23 passed; `pnpm exec eslint apps/worker/src/batch/accumulator.ts apps/worker/src/batch/accumulator.test.ts` — clean, zero errors; `pnpm --filter @posta/worker run build` — clean.
**Outcome:** done, fix-forward landed and independently re-verified (tests, lint, and build all confirmed myself, not assumed from the agent's report).

---

## T3.1.4 · `9a21ffa` · 2026-07-27T14:17:49-03:00

**Review fan-out (all four, [security] tag honored):** code-reviewer (APPROVE, zero findings), silent-failure-hunter (CLEAN, zero findings — traced every failure path incl. the DLQ-write-failure fallback and confirmed no silent drop is possible; its one MEDIUM observation, a bounded "retry storm" if EVENTS_DLQ_QUEUE is persistently unreachable, is explicitly self-assessed as "acceptable by design, no fix needed" since it's logged every time and the alternative is silently dropping the job), typescript-reviewer (APPROVE, zero findings — independently reran ESLint clean this time), security-reviewer (APPROVE — independently re-verified the core [security] claim by tracing all three logger.error() call sites and running CaptureEventSchema against zod@4.4.3 directly to confirm it has no enum/literal fields, so no Zod issue .message could echo back an invalid VALUE even if it were logged, which it isn't; the code's blanket exclusion of .message is defense-in-depth beyond what's strictly needed today).
**Two LOW notes from security-reviewer, neither actioned:**
1. `consoleErrorLogger` (this file, and identically in apps/worker/src/batch/accumulator.ts and partition-maintenance.job.ts) writes via `console.error`, which goes to stderr, not stdout — contradicts this file's own comment text and CLAUDE.md's "logs go only to stdout" line. Pre-existing (introduced by T3.1.3's fix-forward fe8301e, not by T3.1.4), spans 3 files, and kubectl captures stdout+stderr together in practice, so functional impact is minimal. Not fixed in this task's scope — flagging as a possible small cross-cutting cleanup (correct the comments, or reconsider whether console.error's stderr routing is actually fine and CLAUDE.md's phrasing is what's imprecise) rather than fixing one of three occurrences inconsistently here.
2. `EVENTS_DLQ_QUEUE`'s registration in app.module.ts sets no `removeOnComplete`/TTL, so raw payloads (potentially carrying an invariant-6-violating smuggled `ip` key) persist indefinitely in Redis. Carrying this forward as a T3.1.5 concern — DLQ retention policy should land alongside whatever T3.1.5 builds to drain/consume EVENTS_DLQ_QUEUE.
**Outcome:** done, no fix-forward commit needed.

---

## T3.2.6 · `5f7549e` · 2026-07-27T14:50:54-03:00

**Review fan-out:** code-reviewer (APPROVE, zero findings — independently spot-checked 8 fixture entries against ua.ts/source-platform.ts/dest-host.ts's own documented behavior, including the BytedanceWebview/Line → 'directo' exclusion and referer-beats-UA precedence; confirmed all named coverage categories genuinely present), typescript-reviewer (one MEDIUM, judged optional and not actioned: the fixture is loaded via `JSON.parse(...) as CorpusEntry[]` rather than runtime schema validation — a mistyped field would still fail loudly via the strict `.toEqual()` deep-equality assertion against hand-verified `expected` values, and this is a static, committed test fixture authored by the same task, not untrusted runtime input, so the added complexity of a Zod-validated loader wasn't judged worth it here), silent-failure-hunter (CLEAN — confirmed `it.each` iterates all 40 entries with no silent skip, `.toEqual` is strict not `toMatchObject`, the verdict-key regex scans raw text so it can't miss a nested key, and a malformed fixture file would throw loudly at describe-block scope rather than silently reporting 0 tests).
**Triage:** no actionable findings.
**Outcome:** done, no follow-up needed. Implementer's own verification rigor was exceptional — traced the actual installed ua-parser-js@2.0.10 source line-by-line to confirm each non-obvious expected value (macOS naming, Mobile Chrome/wv-token WebView detection, Samsung Internet, Instagram/FBAN/FBAV/TikTok regex capture behavior, Opera-not-Opera-Mobile naming) is a genuine library rule, not a fluke copied from the function's own output.

---

## T3.4.2 · `64f8666` · 2026-07-27T15:05:06-03:00

**Review fan-out (all four — [INV-4][INV-6] tags treated as security-relevant, security-reviewer in first wave):** code-reviewer (APPROVE, zero findings — independently confirmed 31 explicit property accesses, zero spreads/dynamic-key admission), typescript-reviewer (APPROVE, zero findings — verified EventLogLine's closed interface genuinely gives compile-time excess-property errors, confirmed zero field-name collisions in the CaptureEvent & EnrichmentResult intersection), security-reviewer (APPROVE, zero findings — hand-verified the 31-field allowlist matches schema/events.ts's real column list exactly, confirmed toLogLine/EventLogLine are unexported so serializeBatch is the only entry point, confirmed the planted-key test's `as LoggedEvent` cast genuinely bypasses TS's excess-property check the same way a real accidental upstream widening bug would), silent-failure-hunter (one HIGH-framed finding, partially disagreed with — see triage).
**Triage:** silent-failure-hunter's suggested fix (catch a per-event JSON.stringify failure, skip that event, continue serializing the rest) was NOT accepted — reasoned that this would violate invariant 7 ("every event goes to both Postgres and R2"): silently dropping one event from the R2 write while a sibling Postgres write for the same batch succeeds/fails as a whole would create exactly the store-inconsistency invariant 7 exists to prevent, and this story already has a planned home for "one poisoned event in an otherwise-good batch" (later split-retry/poison-DLQ tasks, Postgres side) — deferring to that mechanism by failing the whole batch loudly is the correct behavior, not a gap. Asked instead for a diagnostic-only improvement: identify which event_id caused a serialization failure without changing whether/when the failure happens.
**Fix-forward commit:** `64f8666` `fix: identify the failing event_id when NDJSON serialization throws` — added a `serializeEvent()` wrapper that catches, wraps the error with the failing event_id/occurred_at, and rethrows with the original as `cause`; whole-batch-throws behavior is unchanged. Verify I observed myself: `pnpm test ndjson.test.ts` — 12/12 passed; `pnpm exec eslint packages/core/src/r2/ndjson.ts packages/core/src/r2/ndjson.test.ts` — clean; `pnpm --filter @posta/core run build` — clean.
**Outcome:** done, fix-forward landed and independently re-verified.

---

## T3.1.5 · `58976c6` · 2026-07-27T15:08:07-03:00

**Review fan-out (all four — extends T3.1.4's [security] payload-handling concern, security-reviewer in first wave):** code-reviewer (APPROVE, zero findings — verified the attempts-exhausted comparison, the routeToDlq consolidation preserved identical behavior, the re-validation edge-case logic, and comprehensive test coverage including the intermediate-failure-doesn't-prematurely-DLQ case), typescript-reviewer (APPROVE, zero findings — verified NestJS class-token DI resolution, toDlqIssues' structural typing, DlqReason exhaustiveness, and type-identity of the re-exported EventsDlqJobPayload), silent-failure-hunter (one real MEDIUM, traced further than reported — see triage), security-reviewer (one real HIGH — see triage; confirmed the DLQ/invariant-6 framing is sound and unchanged from T3.1.4, confirmed the attempts-exhausted path structurally cannot carry a raw IP since it only ever sends already-.strict()-validated CaptureEvent data).
**Triage:** security-reviewer's HIGH (DlqService.send() stored error.message completely unredacted — latent, would activate the moment a real sink lands and could leak Postgres/R2 connection-string credentials into an unbounded, never-drained DLQ) was real, verified myself via grep before routing back. silent-failure-hunter flagged unguarded logger calls in onFailed() specifically; I traced the same pattern across the WHOLE file and found none of events.consumer.ts's 4 pre-existing-plus-new logger.error() call sites (T3.1.3's sink-failure branch, T3.1.4's DLQ-write-failure branch, both of T3.1.5's onFailed() branches) had the "wrap logger call in its own try/catch" protection T3.3.1's BatchAccumulator fix already established as this codebase's pattern for exactly this risk — asked for a comprehensive fix across all sites, not just the two new ones, since patching only half would leave the same known gap in the other half.
**Fix-forward commit:** `58976c6` `fix: redact DLQ error messages and guard every logger call site` — redaction applied once, at the single shared DlqService.send() writer (protects all current and future callers by construction, matching redactCredentialsFromMessage's own "one guard point" design rationale) rather than at each call site; a new `safeLog()` wrapper now guards all 5 of EventsConsumer's logger.error() calls, swallowing a throwing logger rather than letting it replace the real outcome. Verify I observed myself: `pnpm test dlq.service.test.ts events.consumer.test.ts malformed-job.test.ts` — 18/18 passed; `pnpm --filter @posta/worker run build` — clean; `pnpm exec eslint apps/worker/src/consumer/*.ts` — clean.
**Outcome:** done, fix-forward landed and independently re-verified.

---

## T3.4.3 · `f1af8f2` · 2026-07-27T15:16:00-03:00

**Review fan-out:** code-reviewer (APPROVE, zero findings — independently confirmed only UTC accessors used, correct zero-padding, purity/idempotency, correct NaN-based error handling), typescript-reviewer (APPROVE, zero findings — confirmed the `occurredAt: string` design choice is well-justified, no barrel-export naming collisions), silent-failure-hunter (two findings, neither survived triage — see below).
**Triage:** silent-failure-hunter's CRITICAL ("lenient Date parsing silently rolls over invalid calendar values like month 13, day 32") is factually false — verified directly in Node: `new Date('2026-13-01T00:00:00Z')`, `new Date('2026-07-32T12:00:00Z')`, and `new Date('2026-07-21T25:00:00Z')` all correctly return `Invalid Date`, which the existing `Number.isNaN(parsed.getTime())` check already catches (V8's strict ISO-8601 parser validates calendar components; the lenient rollover behavior the reviewer described applies to non-ISO date string formats, not this one). Dropped. Its HIGH ("path-traversal risk via unvalidated batchId") mischaracterizes S3/R2's key semantics — object storage keys are opaque flat-namespace strings, not filesystem paths resolved through a hierarchy; a key containing `/` or `..` cannot escape to a different, unintended object the way a real filesystem path traversal would. The underlying suggestion (validate batchId's shape defensively) is reasonable but was already a deliberate, documented design decision in the code's own header ("does not validate batchId's shape... this function only needs an opaque, already-trusted string" — batchId's only real source, BatchAccumulator's newId(), always produces a well-formed ULID). Not actioned; not a defect.
**Outcome:** done, no fix-forward needed. All three reviewers' claims verified against actual code/runtime behavior before accepting or dropping them.

---

## T3.2.7 · `f24b40e` · 2026-07-27T15:32:38-03:00

**Review fan-out:** code-reviewer (APPROVE, zero findings — verified the AST walker correctly targets only real declaration/assignment node kinds, skips comments/string/regex literals structurally, exact identifier matching not substring, scans both target directories, and the detection mechanism is proven via a genuine planted fixture with file:line reporting), typescript-reviewer (APPROVE, one MEDIUM and one LOW, both self-judged acceptable and not actioned: a pragmatic unsafe cast on a Node ErrnoException, and the 449-line length being justified for a self-contained scanner + its own tests), silent-failure-hunter (one real finding, downgraded from CRITICAL to MEDIUM — see triage).
**Triage:** silent-failure-hunter's CRITICAL ("ts.createSourceFile() parses leniently and never checks sourceFile.parseDiagnostics, so a syntactically broken file could hide a violation") was verified real — confirmed directly that `parseDiagnostics` is genuinely populated at runtime for a broken fixture, despite not being part of TypeScript's documented public API. Downgraded to MEDIUM: every file this scanner ever encounters under normal CI/dev conditions must already pass this project's own tsc/build gate to exist validly in the scanned directories, so this isn't a live production risk — but it's a real, cheap-to-close gap in an invariant-enforcing test's own trustworthiness, matching this epic's "fail loud on malformed input" discipline (T3.4.3's eventBatchKey precedent). Its second, lower-priority finding (a mis-extensioned binary file read as garbage TS) was not actioned — scan is already correctly scoped to .ts/.tsx only.
**Fix-forward commit:** `f24b40e` `fix: refuse to trust a syntactically broken parse in the verdict-vocabulary scanner` — added a defensively-typed `getParseDiagnostics()` accessor (Array.isArray check, not a direct property assertion) that throws naming the file and the parser's own diagnostic message before ever walking a possibly-incomplete AST. Documented why this stays a runtime-verified reliance on an internal TS API rather than a full ts.Program, and why a future TS release dropping the field degrades safely rather than crashing. Verify I observed myself: `pnpm test no-verdict.test.ts` — 30/30 passed (25 original + 5 new); `pnpm --filter @posta/worker run build` — clean; `pnpm exec eslint apps/worker/src/no-verdict.test.ts` — clean.
**Outcome:** done, fix-forward landed and independently re-verified.

---

## T3.3.2 · `1ca1758` · 2026-07-27T15:36:00-03:00

**Forward design constraint for S3.6 (replay) — not a blocker, must not be forgotten:** flushBatch resolves each event's destination at FLUSH time (reading the link's CURRENT destination from Postgres), not at capture time. Invariant 3 (307-never-301) exists specifically because destinations get edited, so they demonstrably change — a link edited between capture and flush records the new dest_host against an old click. The 2-second batch window makes this negligible on the live path. Replay (T3.6.3, "replay feeds records through the live insert path") is where this could bite hard: replaying months-old events would re-resolve destinations as they are AT REPLAY TIME, silently rewriting history and breaking invariant 7's "R2 is the source of truth." Confirmed: packages/core/src/r2/ndjson.ts's LoggedEvent (= CaptureEvent & EnrichmentResult) already persists the enriched dest_host in the NDJSON record (toLogLine() copies event.dest_host verbatim). CONSTRAINT: replay must reuse the already-logged dest_host (and the rest of EnrichmentResult) from the NDJSON record — it must NOT call enrich()/resolveDestinationsByLinkIds again and re-derive it. Whoever implements T3.6.2/T3.6.3 needs to read this before designing the replay path.

---

## T3.4.2 · `1ca1758` · 2026-07-27T15:36:00-03:00

**Process note for future dispatches (not a T3.4.2-specific defect):** the T3.4.2 fix-forward implementer found that a plain `as LoggedEvent` type-assertion cast compiles fine under Vitest (esbuild strips types without checking) but FAILS the repo's real type-check gate, `tsc --noEmit -p tsconfig.test.json` (T0.5.7), with TS2352. Green Vitest output does not prove test files type-check. Two separate implementers in this epic have now hit repo gates their own local `pnpm test` run didn't catch (this one, and a separate ESLint gap on another task). Going forward, any task-dispatch brief that touches test files should explicitly instruct running the standalone `pnpm typecheck:tests` (or equivalent `tsc --noEmit` pass) as part of its own verify routine, not just `pnpm test`.

---

## T3.1.5 · `1ca1758` · 2026-07-27T15:36:00-03:00

**Latent test-isolation bug found, correctly scoped out, needs scheduling before S3.5:** while fixing this task's own review findings, the implementer discovered that several PRE-EXISTING tests in events.consumer.test.ts call `queue.obliterate({ force: true })` on EVENTS_QUEUE in their own `finally` blocks — this resets that queue's auto-increment job-ID counter. A later test's auto-generated `job.id` can then collide with an `originalJobId` an earlier, never-cleaned-up DLQ entry recorded, producing flaky cross-test assertion failures. The implementer was fooled by exactly this collision once while building this task's own new tests, and fixed it locally by adding a `dlqQueue.obliterate()` at the start of its own new test — it correctly did NOT attempt to repair the pre-existing tests (out of scope for this task). This is a live flakiness source that will get worse in S3.5's integration suite, which runs many queue-touching tests together in the same process. Currently unowned — needs to be scheduled as its own fix (likely: every events.consumer.test.ts/malformed-job.test.ts/dlq.service.test.ts test that touches EVENTS_QUEUE or EVENTS_DLQ_QUEUE should obliterate BOTH queues at both setup and teardown, not just the one it directly exercises) before S3.5 lands, or flakiness will surface there and be harder to trace back to this root cause.
**Correction to my own earlier note:** I originally wrote "4 logger.error() call sites" when triaging silent-failure-hunter's finding for this task. The implementer's own fix-forward found and guarded 5 (lines 269, 329, 339 pre-existing from T3.1.3/T3.1.4, plus onFailed()'s two new ones at 411/421) — the implementer's count was more careful than mine. All 5 are now wrapped via the new safeLog() helper.

---

## T3.3.2 · `604d115` · 2026-07-27T15:45:53-03:00

**Plan-level gap surfaced and resolved by the user, not by this orchestrator:** the implementation issues two SQL statements per flush (a batched destination SELECT, then a batched INSERT), because enrich()'s dest_host needs each event's destination, which CaptureEvent never carries — a real gap the plan text ("exactly one statement is issued per flush") did not account for. Stopped and handed this back rather than deciding unilaterally; the user reviewed and approved amending the plan text (commit 1ca1758) to describe the two-statement flow, confirming the implementation was correct all along and the prose was wrong. See the forward-note above (added before this stamp) for the S3.6 replay design constraint this decision surfaces.
**Review fan-out (5 reviewers — code, silent-failure, typescript, security, and database-reviewer given the direct SQL query construction):** code-reviewer (APPROVE, zero findings — verified the tenant-mismatch defense-in-depth check is real code not just a comment, and the two-statement property is proven via actual query instrumentation, not just asserted), security-reviewer (no CRITICAL/HIGH — confirmed both queries are pure Drizzle builder calls with zero injection surface, independently traced the tenant-isolation check against a real integration test seeding a cross-tenant scenario; two LOW notes both pre-existing gaps in other files, not regressions from this task), typescript-reviewer (no structural issues; one HIGH-framed finding downgraded to not-required — a double-cast inside flush.test.ts's own query-counting spy helper, test-only infrastructure with zero production risk), silent-failure-hunter (one real MEDIUM actioned, one correctly-behaving mechanism NOT actioned, one optional not actioned — see triage), database-reviewer (no CRITICAL/HIGH, one real MEDIUM actioned — see triage).
**Triage:** silent-failure-hunter's "ON CONFLICT DO NOTHING silently drops rows with no logging" was NOT actioned — that's invariant 8's idempotency mechanism working exactly as designed on a routine retry; logging every conflict hit would be noise on the expected happy path, not signal. Its "no observability when a link_id fails to resolve" was real (downgraded from its own HIGH framing to MEDIUM, since the underlying null-fallback behavior is correct, not broken — purely an observability gap) and actioned. database-reviewer's MEDIUM (EVENT_BATCH_SIZE had no upper bound, risking exceeding Postgres's ~65K bind-parameter limit on a misconfigured value) was real and actioned.
**Fix-forward commit:** `604d115` `fix: log unresolved flush destinations and cap EVENT_BATCH_SIZE` — added a FlushBatchLogger-shaped injectable logger (matching the established EventsConsumerLogger/BatchAccumulatorLogger pattern, not a fourth shape) that emits one batch-level summary line per flush (never per-event) distinguishing not-found from tenant-mismatch counts — going beyond what was asked by separating the two failure reasons, since a tenant-mismatch is a much stronger upstream-integrity signal than an ordinary deleted link. Capped EVENT_BATCH_SIZE at 500 in apps/worker/src/env.ts's Zod schema. Verify I observed myself (re-ran everything, not just trusted the report): `pnpm test flush.test.ts env.test.ts` — 173/173 passed; `pnpm --filter @posta/worker run build` — clean; `pnpm exec eslint` on all four touched files — clean; `pnpm run typecheck:tests` (the standalone tsc --noEmit gate) — clean.
**Outcome:** done, fix-forward landed and independently re-verified.

---

## T3.6.1 · `c5bc44d` · 2026-07-27T16:03:38-03:00

**Review fan-out:** code-reviewer (APPROVE, zero findings — verified the day-truncation loop, the calendar-day from>to comparison, the parseInstant refactor preserved eventBatchKey's exact prior behavior, and the over-covering design tradeoff is sound with no hidden downside), typescript-reviewer (APPROVE, zero findings — 40 tests confirmed passing, refactor preservation verified line-by-line, barrel export confirmed automatic), silent-failure-hunter (one real MEDIUM — see triage; explicitly confirmed no under-cover risk exists, the "never narrows" property is sound and well-tested).
**Triage:** silent-failure-hunter's MEDIUM (no upper bound on from/to range width — a wrong-century typo could generate ~87.6 million prefix strings, allocating gigabytes with no diagnosable error) was real and actionable, though not a live exploitable surface today since this function has no caller yet (the future replay CLI is a later, unbuilt task) — treated as worth closing now while cheap, matching this codebase's own "fail loud on clearly wrong input" discipline.
**Fix-forward commit:** `c5bc44d` `fix: bound eventPrefixes' range to catch a wrong-century typo loudly` — added MAX_RANGE_DAYS = 3660 (10 calendar years accounting for leap days), with the arithmetic and reasoning documented inline (a replay CLI reprocesses a bounded, explicitly-named window, never "entire history" in one call). Verify I observed myself: `pnpm test prefixes.test.ts keys.test.ts` — 37/37 passed; `pnpm --filter @posta/core run build` — clean; `pnpm exec eslint` — clean.
**Outcome:** done, fix-forward landed and independently re-verified.

---

## T3.1.6 · `bbf137d` · 2026-07-27T17:02:45-03:00

**Outcome:** done · verify passed (all re-run independently by orchestrator, not just trusted):
- `pnpm test shutdown.test.ts` (from repo root) — 3/3 pass
- `pnpm exec vitest run apps/worker` — 130/132 pass; the 2 failures are the pre-existing, out-of-scope `partition-maintenance.job.test.ts` REDIS_URL-not-set failures (file untouched by this task)
- `pnpm --filter @posta/worker run build` — clean
- `pnpm typecheck:tests` — clean

**Recovery context:** this task's previous implementer died mid-response (infra failure), leaving 254 uncommitted lines + an untracked, untested `shutdown.ts` in the tree. Treated as a reference draft, not accepted work: parked it, wrote `shutdown.test.ts` against an inert stub first, confirmed a genuine assertion-level RED (`expected 0 to be 30`), then restored/rewrote the draft's implementation to GREEN. The draft's core design (pause-then-flush, swallow-not-rethrow on timeout, verified against installed bullmq@5.80.10 source) held up.

**Findings surviving triage**
- MEDIUM · `apps/worker/src/app.module.ts` (DB_CLIENT factory) — fixed the known `exactOptionalPropertyTypes` build break (`max: config.dbPoolMax` → conditional spread), the one pre-identified compile error.
- MEDIUM · `apps/worker/src/consumer/events.consumer.test.ts` (4 call sites) + `malformed-job.test.ts` (1 call site) — a second, previously-undiscovered compile break: `AppModuleConfig` gained required `databaseUrl`/`batchSize`/`batchIntervalMs`/`shutdownTimeoutMs` fields but these 5 call sites weren't updated. Invisible to `pnpm test` (esbuild strips types); only `pnpm typecheck:tests` catches it. Fixed by extending the existing `UNUSED_ACCUMULATOR_CONFIG` placeholder-config precedent from `dlq.service.test.ts` to both files.
- HIGH (found and fixed during this task, not pre-flagged) · placeholder DB configs across all three test files omitted `dbPoolMax`. With `DB_POOL_MAX` unset in this shell/CI, `createDbClient()` throws inside a Nest `useFactory`; `NestFactory.createApplicationContext()` defaults to `abortOnError: true`, which calls `process.abort()` on that throw — a hard process-abort, not a catchable rejection, silently killing the vitest worker fork instead of failing a test normally. Fixed by adding `dbPoolMax: 5` to all three placeholder configs.

**Deviation from plan:** file list expanded beyond the plan's stated three (`shutdown.ts`, `app.module.ts`, `shutdown.test.ts`) to include `env.ts`/`env.test.ts`/`main.ts`/`.env.example` (SHUTDOWN_TIMEOUT_MS wiring) and `events.consumer.ts`/`dlq.service.test.ts`/`events.consumer.test.ts`/`malformed-job.test.ts` (AccumulatingEventSink + BATCH_ACCUMULATOR DI wiring, and the required-config fallout above) — all necessary supporting wiring for this task's own DI surface, not scope creep into other tasks' territory.

**Handed back to:** n/a — no unresolved findings remain.

---

## T3.1.7 · `9397d42` · 2026-07-27T17:17:13-03:00

**Outcome:** done · verify passed (all re-run independently by orchestrator):
- `pnpm test health.controller.test.ts` — 5/5 pass
- `pnpm --filter @posta/worker run build` — clean
- `pnpm typecheck:tests` — clean
- `pnpm test shutdown.test.ts accumulator.test.ts dlq.service.test.ts events.consumer.test.ts malformed-job.test.ts` — 44/44 pass, no regression from the new `BatchAccumulator.lastFlushAgeMs()`/`HealthController` wiring

**Findings surviving triage:** none — clean implementation.

**Judgment calls made by the implementer, reviewed and accepted:**
- `last_flush_age_ms` tracks last-*successful*-flush only (a rejecting flush does not reset the clock), matching the plan's acceptance wording literally.
- 503 threshold is unconditional `> 3 × batchIntervalMs` with no queue-depth gating, per the plan's literal wording — flagged by the implementer that a genuinely idle worker (zero traffic, batch never opens) will also trip 503 after 3 idle intervals, indistinguishable from wedged. Implemented as specified rather than silently softened; worth a second look only if `EVENT_BATCH_INTERVAL_MS` is ever tuned aggressively relative to real traffic gaps.
- Test level is fast unit-style against a REAL `BatchAccumulator` + two plain-object doubles (not testcontainers) — DI wiring correctness covered incidentally via the 4 existing `AppModule.forRoot()`-booting suites (shutdown/dlq/events.consumer/malformed-job), all of which still construct cleanly with the new `HealthController`/`FLUSH_INTERVAL_MS` tokens registered.

**Deviation from plan:** none beyond the necessary supporting change to `accumulator.ts` (adding `lastFlushAgeMs()`) and `main.ts` (removing the old always-200 hand-rolled `/health` middleware it replaces) — both required for this task's own file-listed `app.module.ts` wiring to work.

**Handed back to:** n/a — no unresolved findings.

---

## T3.3.3 · `acc5d88` · 2026-07-27T20:06:39-03:00

**Outcome:** done · verify passed (all re-run independently by orchestrator):
- `pnpm test split-retry.test.ts` — 15/15 pass
- `pnpm --filter @posta/worker run build` — clean
- `pnpm typecheck:tests` — clean
- `pnpm test flush.test.ts` — 17/17 pass, no regression

**Recovery context:** second dead-agent recovery today, same pattern as T3.1.6 — the first implementer died mid-response (infra "connection closed" failure), leaving a complete-looking but wholly untested `split-retry.ts` (215 lines, untracked, no git history, no test file). Applied the same recipe: parked the draft, wrote `split-retry.test.ts` against a deliberately-wrong stub first, confirmed a genuine assertion-level RED (6 real failures — wrong committed/poison counts, wrong round-trip counts, empty backoff sequence), then restored the draft (verified byte-identical to the backup) to GREEN.

**Judgment call reviewed and accepted — test level:** the implementer checked `packages/core/migrations/sql/001_events.sql` before choosing: `events.slug` is `text NOT NULL` with no length constraint (no CHECK, no varchar(n)), and Postgres `text` is TOASTable to ~1GB, so a genuine testcontainer "oversized slug" INSERT rejection is not actually reachable through the current schema. Used a plain injected `FlushBatch` double instead (matching `split-retry.ts`'s own documented "GENERIC OVER flushBatch, NOT COUPLED TO POSTGRES" contract) with a synthetic oversized-slug event (`length > SLUG_MAX_LENGTH` from `@posta/contracts`) that fails all-or-nothing, mirroring real multi-row-INSERT semantics. `flush.test.ts` already covers the real-Postgres INSERT side. Reasonable and documented in the test file's own header — accepted without requiring a redo.

**O(log n) proof:** not a hardcoded constant — asserts call-count growth stays sub-linear across a 16x batch-size increase (50 → 800 events), plus separately verifies the exponential backoff sequence (`[100, 200, 400]`) and that split halves run sequentially (peak in-flight calls === 1, not `Promise.all`).

**Findings surviving triage:** none — clean recovery, no scope deviation.

**Handed back to:** n/a.

---

## T3.4.4 · `10c25e0` · 2026-07-27T20:33:00-03:00

**Outcome:** done · verify passed (all re-run independently by orchestrator):
- `pnpm test r2-put.test.ts` — 3/3 pass (hard PUT-count assertion, not a spot check)
- `pnpm --filter @posta/worker run build` — clean
- `pnpm typecheck:tests` — clean
- `pnpm test flush.test.ts` — 17/17 pass
- `pnpm test shutdown.test.ts dlq.service.test.ts events.consumer.test.ts malformed-job.test.ts health.controller.test.ts` — 26/26 pass, no regression

**Recovery context:** third attempt at this task. Attempt 1 died mid-response before writing code. Attempt 2 stalled 600s, apparently trying to launch a Docker Desktop GUI app that isn't installed in this environment (`open -a Docker` → "Unable to find application named 'Docker'"; no Docker Desktop process at the OS level). Orchestrator confirmed Docker itself works fine via CLI and a docker-compose stack (redis/postgres/minio) was already up and healthy the whole time — the 2-minute `docker ps` hang observed mid-investigation was transient contention from concurrent testcontainers work in this shared worktree, not a real outage. Attempt 3 was briefed with this finding explicitly (don't try to launch a GUI Docker app; the compose stack is already running; `packages/core/src/r2/client.test.ts` connects directly to `localhost:9000`) and completed cleanly.

**Findings surviving triage:** none — clean implementation. `Promise.all([insertEventsBatch, putEventBatch])` composes the three already-built R2 pieces (T3.4.1 client, T3.4.2 serializer, T3.4.3 keys) without a second enrichment pass, reusing `flush.ts`'s existing `LoggedEvent` intermediate as designed.

**Judgment calls made by the implementer, reviewed and accepted:**
- `FlushBatch`'s signature widened to `(events, batchId?: string)` — optional, defaulting to a fresh `newId()` — to keep `split-retry.ts`'s existing single-argument call and all pre-existing test call sites compiling unchanged. Documented, narrow known gap: until a later task wires `flushBatch` through `BatchAccumulator` for real, a batch retried via `retryWithSplit` mints a new R2 key per retry attempt instead of reusing one (duplicate R2 objects, not data loss — explicitly out of this task's scope).
- R2 PUT and Postgres INSERT run concurrently via `Promise.all`, order deliberately uncoupled (T3.4.6's job, not this one's) — a rejection from either fails the whole flush loudly, R2 is never silently optional.
- `@aws-sdk/client-s3` added as a direct dependency of `@posta/worker` (previously only transitively reachable via `@posta/core`) — required for pnpm's strict linking to resolve `PutObjectCommand`/`S3Client` types in `flush.ts`.
- `AppModuleConfig` gained optional `r2Endpoint`/`r2AccessKeyId`/`r2SecretAccessKey`/`r2Bucket` fields; a new `buildProductionFlush()` in `app.module.ts` throws loudly at DI-construction time if they're missing and no `config.flush` override was supplied — never a silent empty-string fallback.
- Necessary knock-on edits to `dlq.service.test.ts`/`events.consumer.test.ts`/`malformed-job.test.ts` (a one-line `flush: async () => {}` no-op added to each file's existing `UNUSED_ACCUMULATOR_CONFIG`, since `BATCH_ACCUMULATOR` is now constructed eagerly regardless of `eventSink` overrides) and `shutdown.test.ts` (needed a real, working R2 client since it proves an actual flush, not a stubbed one).

**Concurrent-work note:** T3.3.4 (poison-row DLQ routing) landed in this same worktree concurrently and its `poison-dlq.test.ts` directly depends on this task's `createFlushBatch({ r2Client, r2Bucket })` signature — committed second, immediately after this one, for exactly that reason.

**Deviation from plan:** file list expanded beyond the plan's stated two (`flush.ts`, `r2-put.test.ts`) to include the DI/env wiring knock-on above — necessary because `r2Client`/`r2Bucket` became required construction inputs for the one production call site (`app.module.ts`) and every test that boots the real `AppModule.forRoot()`.

**Handed back to:** n/a — no unresolved findings.

---

## T3.3.4 · `da8a8da` · 2026-07-27T20:34:38-03:00

**Outcome:** done · verify passed (all re-run independently by orchestrator):
- `pnpm test poison-dlq.test.ts` — 4/4 pass (real Postgres testcontainer, real Redis testcontainer, real MinIO)
- `pnpm --filter @posta/worker run build` — clean
- `pnpm typecheck:tests` — clean
- `pnpm test split-retry.test.ts dlq.service.test.ts` — 21/21 pass, no regression

**Landed concurrently with T3.4.4** in the same worktree — `poison-dlq.test.ts` calls `createFlushBatch({ db, r2Client, r2Bucket })`, so it structurally depends on T3.4.4's extended `flush.ts` signature. Committed second, immediately after T3.4.4, for exactly that reason; both were independently verified against the combined tree before either was staged.

**Judgment calls reviewed and accepted (both flagged as open design gaps in the brief, resolved by the implementer):**
1. **`SplitRetryResult.poisonEvents` reshaped** from `readonly CaptureEvent[]` to `readonly PoisonedEvent[]` (`{ event, error }`), preserving the original `Error` object (never reduced to a string) so a real Postgres error's own `.code` (the SQLSTATE) survives to the caller. `attemptBatch` itself still never branches on error type — only decides retry/split/poison from attempt count and sub-batch size.
2. **`DlqReason` extended** with a third variant, `'flush-poison'`, plus a new `sqlstate: string | null` field on `EventsDlqJobPayload` (populated via a new `extractSqlState()` helper that walks a bounded 5-link `Error.cause` chain — required because drizzle-orm 0.45.2 wraps the real `pg.DatabaseError` in its own `DrizzleQueryError` via `cause` rather than copying `.code` onto itself; verified against installed source, confirmed by a real SQLSTATE 22003 surfacing in the test).
3. **Wiring left undone, correctly scoped:** `retryWithSplit`/`flush.ts` still don't call `sendPoisonEventsToDlq` — the new exported function is a pure composition step (built around a narrow `PoisonDlqSink` structural interface, zero adapter code needed for a real `DlqService`) for whichever later task wires it into the accumulator's flush path. `app.module.ts` was correctly NOT touched, per the explicit stop-and-flag instruction in the brief.
4. **`SplitRetryResult`'s `originalJobId`/`attemptsMade` stand-ins:** the flush's own `batch_id` and the `maxAttemptsPerBatch` value used, both documented as deliberate substitutes for BullMQ-job-shaped fields that don't exist at the flush level.
5. **Real SQLSTATE reproduced deterministically:** `events.asn` is a plain Postgres `integer` with no app-level upper bound in `CaptureEventSchema` — `Number.MAX_SAFE_INTEGER` reliably triggers SQLSTATE 22003 ("integer out of range") on real Postgres, used instead of a synthetic/mocked error.

**Findings surviving triage:** none.

**Handed back to:** n/a. Note for whoever picks up the eventual accumulator-flush wiring task: `sendPoisonEventsToDlq` and `PoisonDlqSink` are ready to compose in, unused until then.

---

## T3.3.5 · `6b1134a` · 2026-07-27T21:29:09-03:00

**Outcome:** done · verify passed (re-run independently): `pnpm test idempotency.test.ts` — 4/4 pass. Implementer also ran `pnpm --filter @posta/worker run build` clean, `pnpm typecheck:tests` clean, `pnpm test flush.test.ts split-retry.test.ts` — 32/32 pass, zero regression.
**RED phase (self-reported, plausible):** two temporary edits to packages/core/src/db/events.ts (drop onConflictDoNothing; swap to onConflictDoUpdate) each produced a real assertion-level failure, then fully reverted — git diff on that file confirmed empty before commit.
**Findings surviving triage:** none — clean implementation.
**Judgment calls (reviewed, accepted):** scenario (b) "event_id split across two batches" modeled as BullMQ redelivering the same event into two separately-flushed accumulator windows, varying only visitor_hash as a fixture-only marker (documented in the test file as not a realism claim). Scenario (c) concurrent-flush test deliberately does not assert which of two racing transactions wins — only that the surviving row is one whole uncorrupted candidate, since real Promise.all concurrency doesn't let the test control commit order.
**Deviation from plan:** none.
**Handed back to:** n/a.

---

## T3.4.5 · `f3bd70a` · 2026-07-27T21:30:35-03:00

**Outcome:** done · verify passed (re-run independently): `pnpm test r2-retry.test.ts` — 31/31 pass; `pnpm typecheck:tests` — clean. Implementer also ran `pnpm --filter @posta/worker run build` clean, `pnpm test flush.test.ts split-retry.test.ts dlq.service.test.ts r2-put.test.ts poison-dlq.test.ts` — 45/45 pass, zero regression.
**RED phase (self-reported, plausible):** deliberately-wrong stub r2-retry.ts produced 22/31 real assertion failures (not import errors) before real implementation, including a real-MinIO 403 case.
**Design decisions (within task scope, reviewed via diff):** `classifyR2Error` is an allowlist (5xx, 429/throttling, transport timeout/reset) not a blocklist, verified against installed @smithy source. `DlqReason` extended with a fourth variant `'r2-put-failed'` (not reusing `'attempts-exhausted'` — different retry domain — or `'flush-poison'` — wrong shape, single-event/SQLSTATE vs whole-batch/no-SQLSTATE) — reasoning documented inline in dlq.service.ts, matches this epic's established DlqReason precedent (T3.3.4 added 'flush-poison' the same way). Did NOT wire the new module into flush.ts — T3.4.6 is deliberately where that coupling happens.
**Findings surviving triage:** none on review of the diff — DlqReason payload for 'r2-put-failed' stores CaptureEvent[] (no raw IP, same as existing accepted DLQ payload shapes) so invariant 6 is unaffected.
**Deviation from plan:** none.
**Handed back to:** n/a.
