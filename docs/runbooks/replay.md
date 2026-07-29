# Replay runbook — rebuilding Postgres from R2

**Audience:** whoever is on call when part of the `events` table needs to be rebuilt — a
bad migration, an accidental `TRUNCATE`, a corrupted partition, or anything else that
leaves Postgres wrong while the R2 event log is still intact. You do not need to have
read E3 (the event-pipeline epic) to follow this. Every command below is real and was
run against a local `docker compose` stack before this document was written.

**Design background**, if you want it, lives in `docs/plan/03-event-pipeline.md` (story
S3.6) and in the code comments of the files this runbook drives — this document only
covers *how to operate the tool*, not why it's built the way it is.

**The one-sentence mental model:** invariant 7 says R2 is the source of truth for events
and Postgres is a rebuildable projection of it. `posta replay` re-derives Postgres rows
from the R2 NDJSON log for a date range. It cannot recover anything that never reached
R2 in the first place — see [What replay cannot recover](#5-what-replay-cannot-recover)
before you start, so you don't walk in expecting more than the tool provides.

---

## 0. Before you do anything destructive

Nothing in steps 1–3 below touches Postgres. Do not run a `TRUNCATE` or any other
destructive statement until you have completed the dry-run in step 2 and are confident
in the range you're about to replay.

---

## 1. Identify the affected range

You need a `[from, to]` UTC range and, usually, which partition(s) it touches.

**If you already know the incident window** (from an alert, a deploy timestamp, or a log
line), skip to step 2 — you don't need to inspect Postgres first.

**If you don't**, find the affected partition(s) directly. Against the local
`docker compose` stack (what this runbook was verified against), the psql client lives
inside the `postgres` service — no local `psql` install needed:

```bash
# List every monthly partition and how many rows it currently holds.
docker compose exec postgres psql -U posta -d posta -c "
  SELECT
    c.relname AS partition,
    pg_size_pretty(pg_relation_size(c.oid)) AS size
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = 'events'::regclass
  ORDER BY c.relname;
"
```

(In staging/production there is no local `postgres` compose service to exec into —
use `psql "$DATABASE_URL"` directly, or the debug-pod path `docs/runbooks/datastores.md`
documents, once that runbook exists. Every `docker compose exec postgres psql ...`
command below has the identical `psql -U posta -d posta -c "..."` body either way.)

Partitions are named `events_YYYY_MM` (`create_events_partition`,
`packages/core/migrations/sql/003_partition_fn.sql`). A partition that's missing
entirely, or whose row count looks obviously wrong for the traffic you'd expect in that
month, is your signal.

To check a specific partition's row count directly:

```bash
docker compose exec postgres psql -U posta -d posta -c "SELECT count(*) FROM ONLY events_2026_07;"
```

`FROM ONLY <partition>` reads exactly that leaf table, not the whole partitioned
`events` view — this is the same technique the codebase's own tests use to prove a row
landed in one partition and not another.

Once you know the month(s), convert to a UTC range. `posta replay`'s own range logic
(`eventPrefixes`, `packages/core/src/r2/keys.ts`) works at **whole UTC calendar day**
granularity — it always covers full days on both ends, never a partial day — so for "all
of July 2026" use:

```
--from 2026-07-01T00:00:00Z --to 2026-07-31T00:00:00Z
```

(the day of `--to` is included in full, so you do not need to write `2026-08-01`).

**A range spanning a month boundary touches multiple partitions** — each calendar month
is its own `events_YYYY_MM` leaf table, and `posta replay` writes rows into whichever
partition each row's `occurred_at` belongs to; it does not confine itself to one. If
you're truncating before replaying, enumerate every affected partition first with this
runbook's own `pg_inherits` listing query above and truncate each one the range touches
— not just the one you had in mind first.

---

## 2. Check R2 coverage before touching Postgres — `--dry-run`

This is the safe sizing step. It counts matching records **without opening a write path
to Postgres at all** — `runReplayCli`'s dry-run branch never even reads the `db` handle
it's given (`apps/worker/src/cli/replay.ts`). Run this before any `TRUNCATE`,
always (though "safe" means "writes nothing," not "cannot fail" — a dry-run still reads
from R2, so it can exit `2` too, e.g. R2 unreachable or a corrupt NDJSON line hit
mid-stream; see the exit-codes table below):

```bash
./node_modules/.bin/dotenv -e .env -- node apps/worker/dist/cli/replay.js \
  --from 2026-07-01T00:00:00Z \
  --to 2026-07-31T00:00:00Z \
  --dry-run
```

Real output looks like:

```
posta replay --dry-run: 5 record(s) would be replayed, 0 inserted
```

(See [3. The actual command](#3-the-actual-command) for how `node` here gets `DATABASE_URL_WORKER`/`R2_*` from the environment, and for the `docker compose run` alternative.)

### Flags (from `apps/worker/src/cli/replay.ts`'s `parseReplayArgs`)

| Flag | Required | Notes |
|---|---|---|
| `--from` | yes | ISO-8601 instant. Compared against `--to` at raw-instant precision (catches a same-day swapped-flags typo that the day-granularity range logic alone would not). |
| `--to` | yes | ISO-8601 instant. |
| `--tenant <id>` | no | Restricts to one tenant. Applied *after* the R2 read — `recordsRead`/the dry-run's raw count still reflect everything in range, only the matched/inserted count is scoped. |
| `--dry-run` | no | Counts matches, writes nothing, never touches Postgres. |
| `--batch-size <n>` | no | Overrides the INSERT batch size (default 500). Capped at **500** — the same ceiling `EVENT_BATCH_SIZE` uses on the live path, so an operator override can never make a replay less safe than production traffic already is. `--batch-size 3000` is rejected before any I/O: `posta replay: --batch-size "3000" exceeds the maximum of 500 (...)`. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Completed — dry-run counted, or a real replay ran (a `--tenant` that matched zero records is still exit 0; see the stderr warning below). |
| `1` | Bad arguments — a missing/unparseable `--from`/`--to`, `--from` after `--to`, an unrecognized flag, or an out-of-range `--batch-size`. The message always names the offending flag. |
| `2` | A real runtime failure — R2 or Postgres unreachable, or a corrupt NDJSON line in the log (`streamEventLog` throws rather than silently skipping a corrupt record — a partial replay that quietly drops rows is worse than one that stops and names exactly where). |

If `--tenant` is set and matches nothing in a non-empty range, exit stays `0` (not an
error — the tenant may genuinely have nothing in that window) but a line goes to
stderr: `posta replay: --tenant "..." matched 0 of N record(s) read in range — not an
error, but double-check the tenant id if that is unexpected.` Read it as "should I
double check I typed the tenant id right", not as a failure.

**On exit `2`:** each batch's INSERT is atomic and the whole operation is idempotent
(`ON CONFLICT DO NOTHING`) — if replay exits `2` partway through a range, some batches
may already be committed to Postgres and others never attempted (not "no partial data
was written"; that overstates it). That's safe either way: fix the underlying issue
named in the stderr message (R2/Postgres reachability, or a corrupt NDJSON line and
key) and re-run the exact same command. Already-inserted rows are matched by
`ON CONFLICT` and skipped on the re-run; nothing gets duplicated.

### Decision point

- `0 record(s)` on the dry-run → nothing in R2 for this range/tenant. Before concluding
  there's nothing to replay, double-check your `--from`/`--to`/`--tenant` values —
  this is far more often an input mistake than an actual empty range.
- A non-zero count that looks right for the expected traffic volume → proceed to step 3.
- A count that looks *too small* for the expected volume → you may be looking at a
  range/partition where events themselves were lost before ever reaching R2. Read
  [What replay cannot recover](#5-what-replay-cannot-recover) below — this is not
  something a wider replay range can fix.

---

## 3. The actual command

There is currently **no packaged `posta` binary** — `posta replay` is descriptive
shorthand for running the compiled CLI file directly. Two real, working ways to do that
today:

### Dev-mode invocation (fastest, what you'll usually reach for)

Build the worker once (or after pulling new code):

```bash
pnpm --filter @posta/worker run build
```

Then run the CLI with the repo's `.env` loaded (this is the same `dotenv -e ../../.env
--` convention every other CLI script in this codebase uses — `pnpm migrate`, `pnpm
seed`, etc.):

```bash
./node_modules/.bin/dotenv -e .env -- node apps/worker/dist/cli/replay.js \
  --from 2026-07-01T00:00:00Z \
  --to 2026-07-31T00:00:00Z
```

This needs `DATABASE_URL_WORKER`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_EVENTS`, and (locally) `R2_ENDPOINT` set — `.env` already has all of these
for local dev.

### Against the built worker image (what you'd reach for in staging/prod-shaped debugging)

The image's own `CMD` runs the long-running BullMQ consumer (`main.js`), not the
replay CLI — so run it with the command overridden:

```bash
docker compose run --rm worker node apps/worker/dist/cli/replay.js \
  --from 2026-07-01T00:00:00Z \
  --to 2026-07-31T00:00:00Z
```

`docker compose run` reuses the `worker` service's own env wiring (`DATABASE_URL_WORKER`
pointed at the `postgres` service, `R2_ENDPOINT` pointed at `minio`) with no extra flags
needed. In production this is the shape `k8s/worker/replay-job.yaml` will wrap as a
one-off Job (T10.11.1, not yet built) — until that lands, this `docker compose run` form
(or the equivalent `kubectl run`/`docker run` against the deployed image) is the real
invocation.

Both forms print the same summary line — see the next section for how to read it.

---

## 4. Reading the summary/report — current state

**Read this section before you expect anything richer than what's described here.**

### What `posta replay` actually prints today

A real (non-dry-run) invocation prints exactly one summary line to stdout:

```
posta replay: read 5 record(s), wrote 1 batch(es)
```

(with `(filtered to tenant "...")` appended if `--tenant` was set). That's it — no
inserted/skipped/rejected counts, no "parsed" vocabulary, no reconciliation arithmetic.
This is a coarse but real signal:

- **`read 0 record(s)`** → nothing in R2 matched the range/tenant. Same interpretation
  as a `0` dry-run count above.
- **`wrote N batch(es)`** where `N` is much lower or higher than you'd expect given
  the batch size (500 by default, or your `--batch-size`) and the record count — worth
  investigating. `batchesWritten` counts *flushes*, not rows; a range with 1,200 matching
  records at the default batch size should write 3 batches (500 + 500 + 200), not 1 or
  12.
- **Re-running the same command a second time** over an already-replayed range prints
  the *same* `read N record(s), wrote M batch(es)` line — the summary cannot currently
  tell you "0 inserted, N already present" apart from "N freshly inserted". Both look
  identical from this line alone. (Verified directly: running replay twice in a row over
  the same range produced `read 5 record(s), wrote 1 batch(es)` both times, and the
  Postgres row count stayed at 5, not 10 — the underlying `INSERT ... ON CONFLICT DO
  NOTHING` is doing its job, invariant 8; the CLI's own output just doesn't say so.)

If you need to confirm data actually landed (or didn't duplicate), query Postgres
directly:

```bash
docker compose exec postgres psql -U posta -d posta -c "SELECT count(*) FROM ONLY events_2026_07;"
```

### The richer reconciliation report — a known, named gap

Why you'd actually want this: it's the only thing in this codebase today that tells
"rows skipped because they're safe, already-present duplicates" apart from "rows
rejected because they fail record-shape validation." The live CLI's own driver
(`replayEventLog`, `apps/worker/src/cli/replay-driver.ts`) has no rejection step at
all — every streamed record is mapped and inserted unconditionally, so a genuinely
malformed record isn't cleanly skipped-and-reported, it either gets inserted degraded
or makes the whole run abort on a Postgres error. That distinction is exactly what
matters when you're trying to confirm a recovery was clean, not just that it finished.

A significantly more detailed reconciliation report **exists in this codebase and is
fully implemented and tested**, but it is **not currently exposed through the `posta
replay` CLI you actually run**. Specifically:

- `apps/worker/src/cli/replay-report.ts`'s `replayWithReport` function computes and
  prints, per run: objects read, records parsed, rows inserted, rows skipped (already
  present), rows rejected (with human-readable reasons, grouped and counted — not one
  line per row), and a `reconciled` verdict (`inserted + skipped === parsed`).
- If that arithmetic doesn't hold, `replayWithReport` returns exit code
  `EXIT_RECONCILIATION_MISMATCH` (`3`) instead of `0` — deliberately distinct from the
  CLI's own `1` (bad args) and `2` (runtime failure), because "the numbers don't add up"
  is a more specific and more alarming failure than either. This exit code and the
  underlying `reconciled: false` verdict are real and directly tested — see
  `apps/worker/src/cli/replay-report.test.ts`'s `[forced mismatch]` cases, which feed
  `buildReplayReport` fabricated counts (e.g. `recordsParsed: 40, rowsInserted: 30,
  rowsSkipped: 5`) and assert `reconciled === false` and `exitCode ===
  EXIT_RECONCILIATION_MISMATCH`.
- **But `apps/worker/src/cli/replay.ts` — the file `posta replay` actually runs — never
  imports or calls `replayWithReport`.** `replay-report.ts`'s own file header says this
  wiring is deliberately left as "a later task's decision, not this one's," and no task
  since has picked it up. If you run the two commands above and expect to see "rows
  inserted: X / rows skipped: Y / reconciliation OK" in the output, you won't — that
  vocabulary belongs to a module the CLI doesn't call yet.

**If you need that richer report today**, it is only reachable by writing a short script
that calls `replayWithReport` directly (same shape as
`apps/worker/src/cli/replay-report.test.ts`'s own usage) with a real `db`/`r2Client`, not
via any `posta replay` flag — there is no flag for it. Wiring `replayWithReport` into
`replay.ts` so `posta replay` itself prints this report is open, unclaimed follow-up
work; if you pick it up, update this section.

---

## 5. What replay cannot recover

`posta replay` makes Postgres match what R2 already has for a range. It is **not** a way
to recover an event that never reached R2 in the first place.

This isn't a corner case worth hand-waving past: the write path
(`apps/worker/src/batch/flush.ts`, T3.4.6) deliberately **couples** the two writes — the
R2 `PutObjectCommand` is awaited to completion *before* the Postgres `INSERT` is ever
attempted, and if the R2 put fails after exhausting retries, the whole batch is routed to
the DLQ and the Postgres transaction is never opened at all. So for any batch that ever
reached the live pipeline, "landed in R2" and "eligible to land in Postgres" are the same
condition by construction — there's no scenario where an event is in Postgres but
missing from R2, and no scenario where replay could rebuild an event that's missing from
both.

Concretely, replay cannot help with:

- Events dropped before enqueue (e.g. the redirect hot path itself never enqueuing —
  invariant 1 says a redirect never blocks on analytics, so an enqueue failure is
  swallowed *by design* at that layer, not a replay-recoverable gap).
- A batch that exhausted its R2 retries and was routed to the DLQ, if that DLQ entry is
  itself later lost or drained without being reprocessed.
- Any data loss that happened *before* a successful R2 `PutObjectCommand` for that batch.

If you suspect events are missing from R2 itself (not just from Postgres), that is a
different, worse problem than the one this runbook solves — check the DLQ
(`EVENTS_DLQ_QUEUE`) and worker logs around the incident window, not a wider replay
range. A wider `--from`/`--to` only ever finds more of what's *already in R2*; it cannot
manufacture records that were never written there.

**Not every DLQ entry has the same R2 status, so check the reason before assuming
either way.** `flush.ts` also runs a Postgres `SELECT` (resolving each event's
destination) *before* the R2 PUT, and a real, non-duplicate Postgres error on either
that `SELECT` or the later `INSERT` can independently exhaust a job's retries and land
it in the DLQ under reason `'attempts-exhausted'` (`apps/worker/src/consumer/dlq.service.ts`'s
`DlqReason` union) — same as `'r2-put-failed'`, from the outside. Only
`'r2-put-failed'` structurally guarantees the batch never reached R2; an
`'attempts-exhausted'` entry might have (if the failing call was the post-PUT `INSERT`)
or might not have (if it was the pre-PUT `SELECT`) — the entry's own `errorMessage`
usually names which, or check R2 coverage directly with `--dry-run` (section 2) for
that batch's range rather than guessing from the reason alone.

---

## 6. Worked example — reproducing T3.6.6 by hand

This walks through exactly the scenario `apps/worker/src/cli/truncate-and-restore.test.ts`
(T3.6.6) proves automatically: seed a real partition through the live pipeline, truncate
it, and rebuild it via `posta replay`. Every command below was run for real against a
local `docker compose` stack (`postgres`/`redis`/`minio` up via `docker compose ps`)
while writing this document.

**You'll need**: a running local stack, `packages/core` and `apps/worker` built
(`pnpm migrate` builds core as a side effect; `pnpm --filter @posta/worker run build`
builds the worker), and a way to seed a few events — there is no `posta seed` CLI for
arbitrary event data, so this uses a short one-off script that calls the same
`createFlushBatch` the live pipeline uses (the same pattern
`truncate-and-restore.test.ts` itself uses to seed its fixtures, just against the real
compose stack instead of a testcontainer). None of this seeding step is something you'd
run against production — production events arrive from real traffic. It exists here only
to give you something real to truncate and replay in a rehearsal.

**Use an out-of-the-way month for the rehearsal**, never a partition that might already
hold real local dev data — `TRUNCATE` is genuinely destructive. The commands below use
`2099-06` (`events_2099_06`) as a placeholder precisely because nothing else in this
codebase's own tests or dev workflow ever writes there; substitute your own far-future
month if you're rehearsing a second time and want a clean partition. When you're doing
this for a *real* incident, steps 1–2 target the real affected partition instead — you
skip the seeding step entirely, since real data is already there.

0. **(Rehearsal only) seed a fixture partition** — not a real runbook step, just what
   gives you something to truncate. Write a short script that calls
   `createFlushBatch` (`apps/worker/dist/batch/flush.js`) against `2099-06-15T12:00:00Z`
   for a handful of events, the same way `truncate-and-restore.test.ts`'s own
   `beforeAll` does, then run it with `./node_modules/.bin/dotenv -e .env -- node
   your-seed-script.ts`.

1. **Confirm the partition exists and has rows**, using this runbook's own step 1 query:

   ```bash
   docker compose exec postgres psql -U posta -d posta -c "SELECT count(*) FROM ONLY events_2099_06;"
   ```

2. **Truncate it** (in a real incident, this is the destructive action you were sizing
   for in step 2 — never run it before a `--dry-run` has told you what's at stake):

   ```bash
   docker compose exec postgres psql -U posta -d posta -c "TRUNCATE TABLE events_2099_06;"
   docker compose exec postgres psql -U posta -d posta -c "SELECT count(*) FROM ONLY events_2099_06;"  # expect 0
   ```

3. **Size the rebuild** with `--dry-run` — this is what actually protects you: run it
   *before* you trust that the truncate above was scoped correctly, and confirm the
   count matches what you expected from step 1:

   ```bash
   ./node_modules/.bin/dotenv -e .env -- node apps/worker/dist/cli/replay.js \
     --from 2099-06-01T00:00:00Z --to 2099-06-30T00:00:00Z --dry-run
   # posta replay --dry-run: N record(s) would be replayed, 0 inserted
   ```

4. **Run the real replay**:

   ```bash
   ./node_modules/.bin/dotenv -e .env -- node apps/worker/dist/cli/replay.js \
     --from 2099-06-01T00:00:00Z --to 2099-06-30T00:00:00Z
   # posta replay: read N record(s), wrote 1 batch(es)
   ```

5. **Confirm the rebuild** — row count back to what it was in step 1, and (if you want
   the same proof T3.6.6 makes automatically) spot-check a few rows:

   ```bash
   docker compose exec postgres psql -U posta -d posta -c "SELECT count(*) FROM ONLY events_2099_06;"
   docker compose exec postgres psql -U posta -d posta -c "
     SELECT event_id, occurred_at, tenant_id, link_id, dest_host
     FROM ONLY events_2099_06 ORDER BY event_id LIMIT 5;
   "
   ```

**What was actually observed running this end to end** (a private test fixture, a
distinct month/tenant chosen to avoid colliding with real data — the exact mechanics
generalize to any real partition/range):

- Seeded 5 events through the real coupled write path (one R2 object PUT, one Postgres
  batch INSERT).
- `TRUNCATE`d the target partition — row count confirmed `0` before replay ran.
- `--dry-run` reported `5 record(s) would be replayed, 0 inserted` — matching the seeded
  count, with the partition still empty (dry-run never opens a write path).
- The real replay reported `read 5 record(s), wrote 1 batch(es)` — exit `0`.
- Row count was back to `5`, and every column (including `dest_host`, which replay
  reuses verbatim from the R2 log rather than re-resolving) matched the pre-truncation
  values.
- Running the exact same replay command a **second** time reported the identical `read
  5 record(s), wrote 1 batch(es)` line, and the row count stayed at `5` — not `10` — the
  live `ON CONFLICT (event_id, occurred_at) DO NOTHING` behind `posta replay` made the
  second run a no-op, exactly matching invariant 8 and `replay-idempotency.test.ts`
  (T3.6.7)'s own assertion, even though the CLI's own summary line gives no direct
  "0 inserted" signal for it (see [section 4](#4-reading-the-summaryreport--current-state)).

This is the full loop: identify → size with `--dry-run` → truncate → replay → verify.
