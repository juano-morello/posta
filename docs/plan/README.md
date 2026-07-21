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

**Commits.** `<type>: <description>` per the global git-workflow rule. Reference the story: `feat: resolve slug from redis cache (S2.2)`.

**Definition of done for a story.** Every acceptance box ticked · tests written first and passing · 80% coverage on touched code · the parallel review fan-out run (`code-reviewer` + `silent-failure-hunter` + `typescript-reviewer`, plus `security-reviewer` when the story touches auth, input handling, secrets, queries or external calls).

**Invariant tags.** Tasks that implement or protect a `CLAUDE.md` invariant are tagged `[INV-n]`. Those tasks may not be simplified away without amending the invariant in writing first — that is what happened to invariant 11 in this design, and it was done deliberately, in the open.

---

## Invariant coverage map

Where each invariant is implemented and where it is *tested*. An invariant with no test row is decoration.

| # | Invariant | Implemented | Tested |
|---|---|---|---|
| 1 | Redirect never blocks on analytics | S2.4 | S2.6 — queue-down test |
| 2 | Redirect route is lean, no DI | S2.1 | S2.6 — latency budget |
| 3 | 307, never 301 | S2.4 | S2.6 |
| 4 | Worker enriches, never judges | S3.2 | S1.2 — no verdict column exists |
| 5 | Verdict is a read-time view | S4.1 | S4.4 — the corpus |
| 6 | Raw IP never stored or queued | S2.3 | S2.6 — payload assertion |
| 7 | R2 is source of truth | S3.4 | S3.6 — the replay test |
| 8 | Event writes idempotent | S3.3 | S3.5 |
| 9 | `tenant_id == user_id` | S1.1, S5.1 | S5.5 |
| 10 | Hero metric is real humans | S6.4, S7.4 | S9.4 — the screen gate |
| 11 | *(amended)* One frontend surface | S8.1 | S8.6 |

---

## How to execute this

Per story, not per epic. Use `superpowers:subagent-driven-development` for stories with independent tasks; send review findings back to the subagent that wrote the code rather than spawning a fresh fixer.

Start at [E0](./00-foundation.md).
