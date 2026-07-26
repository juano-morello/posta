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
