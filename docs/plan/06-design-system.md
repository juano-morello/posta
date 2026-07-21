# E6 — Design system in code

**Milestone:** M2 · **Depends on:** E0 only · **Unblocks:** E7, E8

**Goal:** DESIGN.md and POSTA.md rendered as working code — tokens, app shell, and the four honesty primitives that *are* the product.

**Done when:** every primitive renders correctly in dark and light, dark islands stay dark in both, and a Storybook-style gallery proves it without needing the backend.

> **This epic has no backend dependency.** It runs in parallel with E1–E4. It is the only real parallelism in the plan — use it.

---

## S6.1 — Tokens

**As a** developer **I want** one token source feeding both Tailwind and runtime theming **so that** no component ever contains a hex value.

**Acceptance:**
- [ ] `_tokens.scss` (POSTA.md §8) emits CSS custom properties for both themes
- [ ] Tailwind config reads those variables — `bg-primary` and `var(--primary)` are the same value, never two definitions
- [ ] Theme switching is a `.light` class toggle at runtime, no rebuild
- [ ] The `--n1/n2/n3` no-humano gray ramp is defined per theme and **never renders near-black on white**
- [ ] Radius scale (4/8/12), spacing scale (4→64), `$bp-mobile: 800px`
- [ ] Space Grotesk + Space Grotesk only for UI; JetBrains Mono for slugs, handles, metrics, prompts — **no third family**
- [ ] Fonts self-hosted with `font-display: swap` and preloaded, not fetched from Google at runtime
- [ ] **Grep test: no hex literals in component files** [DESIGN.md §6]
- [ ] Theme preference persisted and SSR-safe — no flash of wrong theme

**Tasks:**
- [ ] T6.1.1 `_tokens.scss` with both theme maps
- [ ] T6.1.2 Tailwind config bound to the CSS variables
- [ ] T6.1.3 gray ramp with per-theme values
- [ ] T6.1.4 radius/spacing/breakpoint scales
- [ ] T6.1.5 self-host both fonts, subset, preload
- [ ] T6.1.6 theme provider + persistence, no FOUC
- [ ] T6.1.7 hex-literal grep test
- [ ] T6.1.8 contrast check — AA for text pairs in both themes [a11y]

> Lime `#B4FF39` on white fails AA, which is why light mode drops `primary` to `#3F9142`. Any component hardcoding the dark lime breaks accessibility in light mode silently — hence T6.1.7.

---

## S6.2 — shadcn baseline

**As a** developer **I want** shadcn primitives themed once **so that** screens compose instead of hand-rolling overlays.

**Acceptance:**
- [ ] shadcn initialised against our tokens
- [ ] Installed and themed: button, input, sheet, dialog, toast, dropdown, tabs, select, switch, tooltip, skeleton, badge
- [ ] Button variants per DESIGN.md §4: primary (lime), secondary, outline, ghost, destructive — with hover/disabled/loading
- [ ] Inputs: focus = `--ring` + 3px halo; error = `--error` + halo
- [ ] Cards: surface + border, **no shadow** — elevation only on real overlays
- [ ] Toasts are mono (POSTA.md microcopy is mono)
- [ ] Every primitive verified in both themes

**Tasks:**
- [ ] T6.2.1 shadcn init against tokens
- [ ] T6.2.2 install + theme the twelve primitives
- [ ] T6.2.3 button variants and states
- [ ] T6.2.4 input focus/error treatment
- [ ] T6.2.5 borders-over-shadows card treatment
- [ ] T6.2.6 mono toast variant
- [ ] T6.2.7 both-theme visual check

---

## S6.3 — App shell

**As a** user **I want** navigation that works on phone and desktop **so that** the dashboard is usable where I actually am.

**Acceptance:**
- [ ] Desktop ≥800px: 220px sidebar, active item = left indicator + lime tint + lime text; topbar with `⌘K`, avatar, lime **Nuevo link**
- [ ] Mobile <800px: sidebar hidden → compact top bar + fixed bottom tab bar (Links / Bio / Ajustes / Pública), active tab lime
- [ ] Bottom bar respects `env(safe-area-inset-bottom)`
- [ ] Hit targets ≥44px on mobile [a11y]
- [ ] **One lime focus per view** — the shell reserves it for the active nav item, so screens must not add a second [BRAND.md §0.2]
- [ ] Cards use `repeat(auto-fit, minmax(...))` so they wrap 4→2→1 with no media queries
- [ ] `clamp()` for page padding and large numerals
- [ ] Keyboard navigable, visible focus ring throughout [a11y]

**Tasks:**
- [ ] T6.3.1 sidebar with active state
- [ ] T6.3.2 topbar with `⌘K` affordance
- [ ] T6.3.3 bottom tab bar + safe area
- [ ] T6.3.4 responsive switch at 800px
- [ ] T6.3.5 auto-fit card grid utility
- [ ] T6.3.6 `clamp()` type/padding scales
- [ ] T6.3.7 keyboard + focus-ring pass [a11y]

---

## S6.4 — The honesty primitives

**As a** user **I want** the honest split to be legible at a glance **so that** the product's claim is visible rather than asserted.

These four are the product. They get built as real reusable primitives with tests and states — not as decoration inside a screen [INV-10].

**Acceptance:**

**`<HumanoBar>`**
- [ ] Segmented bar, 16px, 6px radius, 2px gaps
- [ ] Humans lime; bots/unfurlers/prefetch across `--n1/n2/n3`
- [ ] Handles 0 clicks, 100% human, and 0% human without collapsing or dividing by zero
- [ ] Segments <1% stay visibly present rather than vanishing
- [ ] Accessible: not colour-alone — labels/legend carry the meaning too [a11y]

**`<BadgeHumano>`**
- [ ] `% humano`, mono, lime on `color-mix(in srgb, var(--primary) 16%, transparent)`
- [ ] `color-mix` reaches the CSS output — SCSS must not try to evaluate it (interpolate the token)

**`<SourceChip>`**
- [ ] Instagram · WhatsApp · TikTok · directo, mono, coloured dot
- [ ] Unknown platform falls back to `directo` rather than rendering blank

**`<Recibos>`**
- [ ] Dark island in **both** themes (DESIGN.md §1)
- [ ] `~/posta $ tail -f recibos --link=<slug>`, live dot
- [ ] Rows: `time · source · [classification] · why`
- [ ] Classification colours: humano=`--primary` · bot=`--error` · unfurler=`--info` · prefetch=`--warning`
- [ ] Virtualised or capped so a long stream cannot degrade the page
- [ ] Empty state in terminal voice
- [ ] `why` text is **escaped** — it is derived from attacker-controlled user-agent strings [security]

**Tasks:**
- [ ] T6.4.1 `<HumanoBar>` with edge cases
- [ ] T6.4.2 `<BadgeHumano>` with `color-mix` interpolation
- [ ] T6.4.3 `<SourceChip>` with fallback
- [ ] T6.4.4 `<Recibos>` island with capped rows
- [ ] T6.4.5 classification colour map in `contracts`, shared with the view's vocabulary
- [ ] T6.4.6 escape `why` [security]
- [ ] T6.4.7 unit tests incl. zero/100/0-percent cases
- [ ] T6.4.8 a11y pass — colour is never the only channel [a11y]

> `why` renders raw user-agent fragments. `<img onerror=...>` in a UA is a real thing that happens, and the receipts panel is precisely where it would land. Escape it.

---

## S6.5 — Component gallery

**As a** developer **I want** every primitive rendered in isolation **so that** E7 and E8 assemble known-good parts.

**Acceptance:**
- [ ] Gallery route (or Storybook) showing every primitive in both themes
- [ ] Honesty primitives shown across their edge cases (0%, 100%, tiny segments, long `why`)
- [ ] Theme toggle in the gallery
- [ ] Runs with **no backend** — fixtures only, so it works during E1–E4
- [ ] Visual regression snapshots in CI

**Tasks:**
- [ ] T6.5.1 gallery scaffold
- [ ] T6.5.2 entries for all primitives + shell
- [ ] T6.5.3 edge-case fixtures
- [ ] T6.5.4 theme toggle
- [ ] T6.5.5 visual regression in CI
