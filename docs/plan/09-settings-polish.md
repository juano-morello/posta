# E9 — Settings & polish

**Milestone:** M3 · **Depends on:** E7, E8 · **Unblocks:** E10

**Goal:** the remaining screens, and turning the POSTA.md §7 shipping checklist from a document into an executable gate.

**Done when:** every screen passes the checklist as an automated check, not as a promise.

---

## S9.1 — Settings (`/settings`)

**Acceptance:**
- [ ] Handle/subdomain read-only, showing `juano.posta.lat`
- [ ] Account: email + **Free** plan badge
- [ ] Appearance: theme toggle, persisted
- [ ] **Dimmed "próximamente" placeholders** for *Dominio propio* (v1.5) and *API keys* (v2) — present so the layout anticipates them, explicitly not built [scope]
- [ ] Placeholders are visibly inert: not focusable, not clickable, marked `aria-disabled` [a11y]
- [ ] Logout
- [ ] Vertical section nav + right-hand form per DESIGN.md §5

**Tasks:**
- [ ] T9.1.1 settings layout
- [ ] T9.1.2 read-only handle + account section
- [ ] T9.1.3 theme toggle with persistence
- [ ] T9.1.4 inert próximamente placeholders [a11y]
- [ ] T9.1.5 logout
- [ ] T9.1.6 responsive stack

> The placeholders are a deliberate scope statement: they show where v1.5 and v2 land without inviting anyone to build them now. Keep them inert — a dimmed thing that responds to clicks reads as broken, not as forthcoming.

---

## S9.2 — System pages

**Acceptance:**
- [ ] Dashboard 404 in terminal shell voice, matching the API's redirect 404 (S2.5)
- [ ] Error boundary page in the same voice; never exposes a stack trace [security]
- [ ] Loading/splash for slow initial loads
- [ ] All three are dark islands in both themes
- [ ] Every system page offers a way back

**Tasks:**
- [ ] T9.2.1 dashboard 404
- [ ] T9.2.2 error boundary page, trace-free [security]
- [ ] T9.2.3 loading/splash
- [ ] T9.2.4 voice consistency check against S2.5

---

## S9.3 — Responsive & accessibility pass

**Acceptance:**
- [ ] Every screen verified at 320 / 375 / 768 / 1024 / 1440
- [ ] **No horizontal scroll at any width**
- [ ] Sidebar → bottom tabs below 800px everywhere
- [ ] Cards wrap 4→2→1 without media queries
- [ ] Hit targets ≥44px on mobile [a11y]
- [ ] Keyboard navigable end to end; visible focus ring throughout [a11y]
- [ ] Contrast AA in both themes, including the `--n1/n2/n3` ramp [a11y]
- [ ] Charts and the honesty bar are not colour-only [a11y]
- [ ] Screen-reader pass on the analytics screen — the honest split must be *stateable*, not merely visible [a11y]
- [ ] `prefers-reduced-motion` respected — the blinking cursor and typing effects stop [a11y]

**Tasks:**
- [ ] T9.3.1 breakpoint sweep, all screens
- [ ] T9.3.2 horizontal-scroll test in CI
- [ ] T9.3.3 keyboard traversal audit
- [ ] T9.3.4 contrast audit both themes
- [ ] T9.3.5 screen-reader pass on analytics
- [ ] T9.3.6 `prefers-reduced-motion` handling
- [ ] T9.3.7 automated axe run in CI

> The blinking lime cursor is a brand signature and a vestibular trigger. `prefers-reduced-motion` is not a nice-to-have here — it is the one place where the identity and accessibility genuinely collide, and accessibility wins.

---

## S9.4 — The shipping checklist as a gate

**As a** maintainer **I want** POSTA.md §7 enforced automatically **so that** the honesty rule cannot erode one screen at a time.

**Acceptance:**
- [ ] **Hero number is humans** on every metric surface — asserted per screen [INV-10]
- [ ] Non-human always present as a visible secondary split, never in the headline [INV-10]
- [ ] Dark islands stayed dark in both themes — asserted, not eyeballed
- [ ] Grays adapt per theme, never near-black on white
- [ ] Only **one lime focus per view** — a lint or visual test counting lime accents
- [ ] Only Space Grotesk + JetBrains Mono load — asserted against the font manifest
- [ ] Copy is Spanish rioplatense throughout — no English strings in the UI
- [ ] The gate runs in CI and fails the build

**Tasks:**
- [ ] T9.4.1 hero-is-humans assertion per screen [INV-10]
- [ ] T9.4.2 dark-island theme test
- [ ] T9.4.3 gray-ramp adaptation test
- [ ] T9.4.4 lime-focus counter
- [ ] T9.4.5 font manifest assertion
- [ ] T9.4.6 English-string detector for UI copy
- [ ] T9.4.7 wire the gate into CI

> Invariant 10 is the one most likely to die by a thousand small reasonable decisions — a "total clicks" card here, a combined number there. Automating the check is what keeps it alive after the enthusiasm of building it wears off.

---

## S9.5 — Performance & final review

**Acceptance:**
- [ ] Lighthouse mobile ≥90 on the public bio page
- [ ] Dashboard initial JS budgeted and enforced in CI
- [ ] No layout shift on any screen (CLS ~0)
- [ ] Images sized, lazy where appropriate
- [ ] Full review fan-out run: `code-reviewer` + `silent-failure-hunter` + `typescript-reviewer` + `security-reviewer`
- [ ] All CRITICAL and HIGH findings resolved
- [ ] Coverage ≥80% across the repo
- [ ] Findings sent back to the subagent that wrote the code, per the global baseline

**Tasks:**
- [ ] T9.5.1 Lighthouse CI on the bio page
- [ ] T9.5.2 JS bundle budget
- [ ] T9.5.3 CLS audit
- [ ] T9.5.4 image optimisation pass
- [ ] T9.5.5 review fan-out
- [ ] T9.5.6 triage and route findings to original implementers
- [ ] T9.5.7 coverage verification
