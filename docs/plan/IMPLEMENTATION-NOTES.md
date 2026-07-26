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
