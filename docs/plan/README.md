# Posta — Build Plan

Design spec: [`../superpowers/specs/2026-07-21-posta-design.md`](../superpowers/specs/2026-07-21-posta-design.md)

11 EPICs across 3 milestones. Every EPIC is independently reviewable and ends in something verifiable.

---

## Milestones

| | Milestone | Meaning | EPICs |
|---|---|---|---|
| **M1** | *el número es honesto* | The engine works. Provable with `curl` + one SQL query. **No UI at all.** | E0 · E1 · E2 · E3 · E4 |
| **M2** | *lo podés usar* | Auth, CRUD, dashboard. You can run your own links. | E5 · E6 · E7 |
| **M3** | *el mundo lo ve* | Public bio, polish, deployed. | E8 · E9 · E10 |

M1 ships with zero pixels on purpose. If the honest number isn't real, no dashboard makes it real.

---

## Dependency graph

```
E0 ──┬── E1 ── E2 ── E3 ── E4 ──── E5 ──┬── E7 ── E9 ── E10
     │                                   │
     └── E6 ─────────────────────────────┴── E8
```

**E6 has no backend dependency** — it can run in parallel with all of E1–E4. That is the only meaningful parallelism in the plan; everything else is a chain.

| EPIC | Depends on | Unblocks |
|---|---|---|
| [E0 Foundation](./00-foundation.md) | — | E1, E6 |
| [E1 Data model](./01-data-model.md) | E0 | E2 |
| [E2 Redirect hot path](./02-redirect-hot-path.md) | E1 | E3 |
| [E3 Event pipeline](./03-event-pipeline.md) | E2 | E4 |
| [E4 Classification & analytics](./04-classification-analytics.md) | E3 | E5 |
| [E5 Auth & link CRUD](./05-auth-link-crud.md) | E4 | E7, E8 |
| [E6 Design system](./06-design-system.md) | E0 | E7, E8 |
| [E7 Dashboard screens](./07-dashboard-screens.md) | E5, E6 | E9 |
| [E8 Bio page](./08-bio-page.md) | E5, E6 | E9 |
| [E9 Settings & polish](./09-settings-polish.md) | E7, E8 | E10 |
| [E10 Deploy & operate](./10-deploy-operate.md) | E9 | — |

---

## Conventions

**IDs.** `E<n>` epic · `S<n>.<m>` story · `T<n>.<m>.<k>` task. Stable — referenced from commits and PRs.

### One task = one commit

Every task is sized so that it lands as a single commit leaving the repo green. The task heading **is** the commit subject:

```
#### T0.4.2 · `chore: add redis service with volatile-lru`
Redis 7 with an explicit maxmemory and maxmemory-policy volatile-lru, set via a
mounted redis.conf rather than a CLI flag so the value is reviewable in a diff.
→ **files** `docker-compose.yml`, `docker/redis.conf` · **verify** `docker compose exec
  redis redis-cli config get maxmemory-policy` returns `volatile-lru` · **after** T0.4.1
```

- **heading** — conventional-commit subject (`feat` `fix` `test` `chore` `refactor` `docs` `ci` `perf`). Copy it verbatim into the commit.
- **body** — what the task does, concrete enough to start without asking questions.
- **files** — roughly what it touches. More than ~3 files usually means the task should split.
- **verify** — a runnable command or observable outcome. Never "looks right".
- **after** — task IDs that must land first, or `—`.

**TDD happens inside a task, not across two.** Write the test, watch it fail, implement, commit once. A separate RED commit would break "main is always deployable" and trip the coverage gate. Tasks whose entire purpose is test infrastructure still get their own `test:` commit.

**Status markers.** `✅ done (<sha>)` on completed tasks · `⛔ blocked` with the reason inline.

**Definition of done for a story.** Every acceptance box ticked · tests written first and passing · 80% coverage on touched code · the parallel review fan-out run (`code-reviewer` + `silent-failure-hunter` + `typescript-reviewer`, plus `security-reviewer` when the story touches auth, input handling, secrets, queries or external calls).

### Refinement depth

Epics are refined to commit-level granularity **just in time**, not all at once — task detail written months ahead goes stale before it is read.

| Epics | State | Tasks |
|---|---|---|
| E0–E6, E10 | Refined to atomic tasks | **416** |
| E7–E9 | Story-level. Refine as dependencies land. | — |

E0–E5 are refined because the spec pins them tightly — the hot path, every capture signal, the eight classification rules in order, batching thresholds, the R2 layout. E6 is refined because it is the parallel track.

**E10 was refined once the deployment model became containers + Kubernetes.** It had been deferred as "blocked on provider choice", but images and plain manifests are precisely what makes provider choice bind *late* — so the block dissolved. Five tasks remain `⛔ blocked` on a cloud account existing; every manifest, test and runbook can be built today against `kind`.

E7–E9 stay coarse: dashboard and polish tasks depend on component decisions E6 has specified but not yet built. Refining them now would be inventing detail rather than capturing it — though that argument has already been wrong once, so it is worth re-testing rather than assuming.

**Invariant tags.** Tasks that implement or protect a `CLAUDE.md` invariant are tagged `[INV-n]`. Those tasks may not be simplified away without amending the invariant in writing first — that is what happened to invariant 11 in this design, and it was done deliberately, in the open.

---

## Invariant coverage map

Where each invariant is implemented and where it is *tested*. An invariant with no test row is decoration.

Task-level, generated from the `[INV-n]` tags rather than maintained by hand — so it cannot quietly drift from the plan it indexes. Truncated to five per cell.

| # | Invariant | Implemented | Tested |
|---|---|---|---|
| 1 | Redirect never blocks on analytics | T2.4.3, T10.2.7, T10.9.2, T10.9.3, T10.10.3 | T2.6.2 — queue-down |
| 2 | Redirect route is lean, no DI | T2.1.4, T4.5.10, T10.2.7, T10.9.2 | T2.6.7, T5.2.7 |
| 3 | 307, never 301 | T2.4.1 | T2.6.4 |
| 4 | Worker enriches, never judges | T1.3.4, T3.2.3, T3.4.2 | T1.2.5 — no verdict column, T3.2.7 |
| 5 | Verdict is a read-time view | T4.1.1, T10.7.7, T10.9.6, T10.10.7 | T4.1.4, T4.2.1 |
| 6 | Raw IP never stored or queued | T0.7.10, T2.3.1, T2.3.7, T3.4.2, T10.9.7 | T1.2.5, T2.3.8, T2.6.3, T10.9.8 |
| 7 | R2 is source of truth | T0.4.2, T3.4.6, T10.4.4, T10.7.3, T10.7.4 | T0.4.8, T3.4.7, T3.5.2, T3.5.7, **T3.6.6 — the replay test** |
| 8 | Event writes idempotent | T1.2.2, T2.3.1, T3.3.2, T10.6.4 | T2.6.4, T3.3.5, T3.5.2, T3.5.3, T3.6.7 |
| 9 | `tenant_id == user_id` | T1.1.4, T1.1.5, T1.5.5, T4.3.1, T4.5.1 | T4.5.9, T5.4.12, T5.5.2, T5.5.3, T5.5.5 |
| 10 | Hero metric is real humans | T4.3.1, T4.3.2 | T4.3.10 |
| 11 | *(amended)* One frontend surface | T10.2.2, T10.4.4 | T10.2.6, T10.4.5 |

Two things this map makes visible that prose would not:

**Invariant 3 has the thinnest coverage** — one implementation task, one test. That is proportionate: `307` versus `301` is a single constant, and the test asserts the status code directly. Thin here means small, not neglected.

**Invariant 11's enforcement lives entirely in E10**, not in E8 where the bio page is built. That is because its real failure mode is multi-replica cache divergence, which does not exist until there is more than one pod. An invariant whose only teeth are in the deploy epic is worth watching — if E10 slips, invariant 11 becomes unenforced without anyone deciding to unenforce it.

---

## How to execute this

Per story, not per epic. Use `superpowers:subagent-driven-development` for stories with independent tasks; send review findings back to the subagent that wrote the code rather than spawning a fresh fixer.

Start at [E0](./00-foundation.md).
