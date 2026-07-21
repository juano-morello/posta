# E7 — Dashboard screens

**Milestone:** M2 · **Depends on:** E5, E6 · **Unblocks:** E9

**Goal:** the four authed screens from POSTA.md — login, links overview, create/edit sheet, link analytics — assembled from E6 primitives on E5/E4 data.

**Done when:** you can log in, create a link, click it from your phone, and watch the honest number move on the analytics screen.

---

## S7.1 — Login (`/login`)

**Acceptance:**
- [ ] Single terminal card, **always-dark island** in both themes
- [ ] Chrome 3-dots, title `~/posta $ login`, Posta wordmark with blinking lime block cursor
- [ ] Tagline `links honestos. clicks reales.`
- [ ] Email + password, lime **Entrar**
- [ ] No signup link — there is no signup [scope]
- [ ] Errors are generic and Spanish; no user enumeration [security]
- [ ] Loading state on submit; double-submit prevented
- [ ] Authed users hitting `/login` are redirected to `/`
- [ ] Keyboard-first: autofocus email, Enter submits, visible focus rings [a11y]

**Tasks:**
- [ ] T7.1.1 terminal card with blinking cursor
- [ ] T7.1.2 form + Better Auth client wiring
- [ ] T7.1.3 generic error handling [security]
- [ ] T7.1.4 loading + double-submit guard
- [ ] T7.1.5 authed redirect + route protection
- [ ] T7.1.6 a11y pass

---

## S7.2 — Links overview (`/`)

The home screen and the workhorse.

**Acceptance:**
- [ ] Stat card band: clicks reales · % no humano (global) · mejor link · top fuente — bordered, no shadow
- [ ] Row: mono slug, destination (favicon + host), **real clicks bold**, bot % muted, 7-day sparkline, copy button
- [ ] **Slug display handles the longer host** — `juano.posta.lat/promo` truncates to `…/promo`, full host on hover, copy yields the full URL (see E0/S0.6)
- [ ] Client-side search filter + lime **Nuevo link**
- [ ] Empty state: `~/posta $ todavía no hay links`, dark island
- [ ] Copy → mono toast `copiado: juano.posta.lat/promo`
- [ ] Row hover lifts the left border to lime; row click → analytics
- [ ] Sparkline dropped on narrow screens
- [ ] Sparklines come from the **batched** query [no N+1]
- [ ] Loading = skeletons matching real row shape; error state is actionable, not a blank page
- [ ] Rows are keyboard-focusable and Enter-activatable [a11y]

**Tasks:**
- [ ] T7.2.1 stat card band from `/v1/overview`
- [ ] T7.2.2 link row with truncation + hover host
- [ ] T7.2.3 sparkline component (SVG polyline)
- [ ] T7.2.4 search filter
- [ ] T7.2.5 copy + mono toast
- [ ] T7.2.6 terminal empty state
- [ ] T7.2.7 skeletons + error state
- [ ] T7.2.8 responsive column dropping
- [ ] T7.2.9 keyboard interaction [a11y]

> Favicons are fetched from third-party hosts. Proxy them or fall back to the `favLetter`/`favColor` treatment from POSTA.md §5 — hotlinking leaks the user's browsing surface to every destination host and breaks on CSP.

---

## S7.3 — Create / edit sheet

**Acceptance:**
- [ ] shadcn **sheet** over the list; header `~/posta $ new` or `~/posta $ edit <slug>`
- [ ] Destination URL; slug toggle **Aleatorio / Personalizado**; vanity input showing the live domain prefix; reroll for random
- [ ] Optional title
- [ ] Inline validation, debounced against `check-slug`: taken → error border + halo + `✕ ese slug ya existe — probá otro`
- [ ] Client validation mirrors server rules from `contracts` — one source, no drift
- [ ] Save → row appears highlighted with short link + copy surfaced
- [ ] Edit prefills; changing the slug warns that the old one stops working
- [ ] Server 409 on save handled gracefully (someone won the race)
- [ ] Sheet closes on Escape, traps focus, restores focus on close [a11y]
- [ ] Unsaved changes prompt before dismiss

**Tasks:**
- [ ] T7.3.1 sheet + terminal header
- [ ] T7.3.2 destination field with validation
- [ ] T7.3.3 slug toggle, vanity input with live prefix, reroll
- [ ] T7.3.4 debounced check-slug
- [ ] T7.3.5 shared `contracts` validation
- [ ] T7.3.6 save → highlighted row + copy
- [ ] T7.3.7 edit mode + slug-change warning
- [ ] T7.3.8 409 handling
- [ ] T7.3.9 focus trap, Escape, unsaved guard [a11y]

---

## S7.4 — Link analytics (`/l/:id`)

**The honesty screen. This is where the thesis is felt or missed.**

**Acceptance:**
- [ ] Header: short link large in mono + copy + destination + **Editar link**
- [ ] Hero: `clicks reales` as a large lime number [INV-10], `<BadgeHumano>`, `<HumanoBar>` with a legend showing humanos/bots/unfurlers/prefetch counts
- [ ] Toggle **solo humanos (on)** / todo — humans-only is the default, always [INV-10]
- [ ] Time-series area chart, two series (humanos vs no-humano), range 7d / 30d / todo
- [ ] Chart data is zero-filled — gaps must not redraw the week's shape
- [ ] Breakdown cards: top países · fuentes (`<SourceChip>` + bars) · dispositivos · in-app browser flag
- [ ] **`recibos`** island at the bottom, `~/posta $ tail -f recibos --link=<slug>`, live dot
- [ ] Hero numeral uses `clamp(40px, 9vw, 52px)`
- [ ] Zero-data state that explains rather than showing zeroes
- [ ] The non-human number is never folded into the headline [INV-10]
- [ ] Chart is not colour-only — series are labelled and reachable [a11y]

**Tasks:**
- [ ] T7.4.1 header with copy
- [ ] T7.4.2 hero row: numeral + badge + bar + legend [INV-10]
- [ ] T7.4.3 solo-humanos toggle, default on [INV-10]
- [ ] T7.4.4 area chart (SVG polyline + gradient) with range toggle
- [ ] T7.4.5 breakdown cards
- [ ] T7.4.6 recibos island wired to `/v1/links/:id/recibos`
- [ ] T7.4.7 zero-data state
- [ ] T7.4.8 responsive layout
- [ ] T7.4.9 chart a11y [a11y]

> The `todo` toggle must never become the default, and the two numbers must never be summed into one headline. That single design choice is the entire difference between Posta and every competitor — it is worth being stubborn about in review.

---

## S7.5 — Data layer & polish

**Acceptance:**
- [ ] One typed API client in `web`, consuming `contracts` DTOs
- [ ] Server Components for initial loads; client fetching only for interaction (toggles, recibos polling)
- [ ] Recibos polls on a sane interval, backs off when the tab is hidden, and stops on unmount
- [ ] Every screen has explicit loading, empty and error states — no silent blanks [error-handling]
- [ ] 401 → redirect to login with a return path
- [ ] Network failure shows an actionable Spanish message with retry
- [ ] No `console.log` left in shipped code

**Tasks:**
- [ ] T7.5.1 typed API client
- [ ] T7.5.2 Server Component data loading
- [ ] T7.5.3 recibos polling with visibility backoff
- [ ] T7.5.4 loading/empty/error states across screens
- [ ] T7.5.5 401 handling with return path
- [ ] T7.5.6 error boundaries
- [ ] T7.5.7 console/debug sweep

---

## S7.6 — E2E: the money flow

**Acceptance:**
- [ ] Playwright: log in → create a vanity link → visit it in a fresh context → return to analytics → the real-humans count incremented
- [ ] A `curl`-flavoured request against the same link increments **bots**, not humans — asserted in the UI, not just the DB
- [ ] Copy-to-clipboard yields the full correct URL
- [ ] Mobile viewport run: bottom tabs present, no horizontal scroll

**Tasks:**
- [ ] T7.6.1 Playwright setup with seeded auth
- [ ] T7.6.2 the full create→click→count flow
- [ ] T7.6.3 bot-vs-human assertion through the UI
- [ ] T7.6.4 mobile viewport run
- [ ] T7.6.5 wire into CI

> T7.6.3 is the acceptance test for the entire product. Everything else is infrastructure for making that one assertion true.
