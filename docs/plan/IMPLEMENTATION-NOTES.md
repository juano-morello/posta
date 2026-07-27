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
