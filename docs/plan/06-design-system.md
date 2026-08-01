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

#### T6.1.1 · `feat: emit dark theme CSS custom properties from _tokens.scss` ✅ done (`02345cb`)
Create `_tokens.scss` with the `$themes` SCSS map, the `emit-vars` mixin and the `t($name)` helper from POSTA.md §8.1, emitting the dark map under `:root`. Import it at the top of `globals.css` so the variables exist before any Tailwind layer.
→ **files** `apps/web/src/styles/_tokens.scss` · `apps/web/src/styles/globals.css` · **verify** `pnpm test tokens.test.ts` compiles the sheet with `sass` and asserts `:root` contains `--primary:#B4FF39`, `--bg:#0D1117`, `--surface:#161B22` · **after** —

#### T6.1.2 · `feat: add the light theme map behind the .light class` ✅ done (`a1685ed`)
Add the light entry to `$themes` and emit it under `.light`, dropping `primary` to `#3F9142` and `ring` to `#3F9142`. Page background is `#F6F8FA` and `surface` is pure `#FFFFFF` — cards are never grayer than the page (DESIGN.md §1).
→ **files** `apps/web/src/styles/_tokens.scss` · **verify** `pnpm test tokens.test.ts` asserts `.light` emits `--primary:#3F9142` and that `--surface` is lighter than `--bg` in the light map · **after** T6.1.1

#### T6.1.3 · `feat: emit the no-humano gray ramp per theme` ✅ done (`0f581bc`)
Add `n1/n2/n3` to both theme maps — dark `#5a6069/#3f444c/#2b3038`, light `#8B94A0/#B7BFC9/#D6DCE3` — so the non-human segments never render near-black on white.
→ **files** `apps/web/src/styles/_tokens.scss` · **verify** `pnpm test tokens.test.ts` asserts `--n1` differs between `:root` and `.light`, and that every light-mode `n*` has relative luminance above 0.35 · **after** T6.1.2

#### T6.1.4 · `feat: alias shadcn token names onto the Posta token set` ✅ done (`d6ff7d9`)
shadcn primitives read `--background`, `--card`, `--muted-foreground`, `--destructive`, `--input`; `_tokens.scss` emits `--bg`, `--surface`, `--muted`, `--error`, `--border`. Emit the shadcn names as aliases of the Posta names inside the same `emit-vars` pass so there is exactly one value per colour and no second definition to drift.
→ **files** `apps/web/src/styles/_tokens.scss` · **verify** `pnpm test tokens.test.ts` asserts `--destructive` resolves to the same computed colour as `--error` in both themes · **after** T6.1.3

#### T6.1.5 · `feat: add radius, spacing and $bp-mobile scales` ✅ done (`93cd4e1`)
Add `$radius-sm: 4px / $radius-badge: 6px / $radius: 8px / $radius-lg: 12px`, the `$space` map (`4 8 12 16 24 32 48 64`), `$bp-mobile: 800px` and the `@mixin mobile` wrapper from POSTA.md §8.2. `$radius-badge` is the named 6px used by badges, chips and thin data bars (DESIGN.md §2.3) — it exists so no component carries a bare `6px`.
→ **files** `apps/web/src/styles/_tokens.scss` · **verify** `pnpm test tokens.test.ts` asserts the emitted `--radius`, `--radius-sm`, `--radius-badge`, `--radius-lg` values and that `$bp-mobile` is `800px` · **after** T6.1.1

#### T6.1.6 · `feat: bind the Tailwind config to the CSS custom properties` ✅ done (`873c514`)
Point every `theme.extend.colors` entry at `var(--token)` and map `borderRadius`, `spacing` and the `mobile` screen at the same variables, so `bg-primary` and `var(--primary)` resolve to one value. No hex appears in the Tailwind config.
→ **files** `apps/web/tailwind.config.ts` · **verify** `pnpm test tailwind-tokens.test.ts` resolves the Tailwind config and asserts every colour value matches `/^var\(--/` · **after** T6.1.4, T6.1.5

#### T6.1.7 · `test: assert Tailwind and _tokens.scss never drift apart` ✅ done (`1fe61fd`)
Parse the token names emitted by `_tokens.scss` and the colour keys in the resolved Tailwind config, and fail if either side has a name the other lacks. This is the test that catches a token added in one place only.
→ **files** `apps/web/tailwind-tokens.test.ts` · **verify** `pnpm test tailwind-tokens.test.ts` — deleting one entry from `tailwind.config.ts` makes it fail · **after** T6.1.6

#### T6.1.8 · `feat: self-host Space Grotesk and JetBrains Mono as woff2 subsets` ✅ done (`55936d8`)
Vendor latin + latin-ext woff2 subsets into `apps/web/public/fonts/` and declare `@font-face` with `font-display: swap` in `globals.css`. Weights: Space Grotesk 400/500/600/700, JetBrains Mono 400/500/600. No third family.
→ **files** `apps/web/public/fonts/*.woff2` · `apps/web/src/styles/globals.css` · **verify** `pnpm test fonts.test.ts` asserts every `src: url(...)` in `globals.css` is a local `/fonts/` path and that exactly two families are declared · **after** T6.1.1

#### T6.1.9 · `feat: preload both fonts in the root layout` ✅ done (`d9b507b`)
Add `<link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous">` for the Space Grotesk 400 and JetBrains Mono 400 subsets, and set the two families as the `font-sans` / `font-mono` Tailwind stacks.
→ **files** `apps/web/src/app/layout.tsx` · `apps/web/tailwind.config.ts` · **verify** `pnpm test layout.test.tsx` asserts two `rel="preload"` font links render and `font-mono` resolves to the JetBrains Mono stack · **after** T6.1.8

#### T6.1.10 · `test: forbid runtime Google Fonts requests` ✅ done (`7bcbedb`)
Grep the whole of `apps/web/src` and `apps/web/public` for `fonts.googleapis.com` and `fonts.gstatic.com` and fail on any hit. DESIGN.md §3 still shows the Google `<link>` import; this test is what stops it being copied in.
→ **files** `apps/web/no-remote-fonts.test.ts` · **verify** `pnpm test no-remote-fonts.test.ts` — adding the DESIGN.md §3 `<link>` to `layout.tsx` makes it fail · **after** T6.1.8

#### T6.1.11 · `feat: add an SSR-safe ThemeProvider with a .light class toggle` ✅ done (`c06648d`)
Create `theme.tsx` exporting `ThemeProvider` and `useTheme()`. Toggling adds or removes `.light` on `document.documentElement` at runtime — no rebuild, no re-render of the token sheet. The provider renders identically on the server and never reads `window` during render.
→ **files** `apps/web/src/lib/theme.tsx` · **verify** `pnpm test theme.test.tsx` asserts `renderToString` succeeds with no `window` access and that `setTheme('light')` toggles the `light` class on the root element · **after** T6.1.2

#### T6.1.12 · `feat: persist the theme and block the flash with a pre-hydration script` ✅ done (`1bf2720`)
Persist the choice to `localStorage` under `posta-theme` and inject a small blocking inline script in `<head>` that applies the stored class before first paint, falling back to dark. Dark is the default when nothing is stored.
→ **files** `apps/web/src/lib/theme.tsx` · `apps/web/src/app/layout.tsx` · **verify** `pnpm test theme.test.tsx` asserts the inline script runs before hydration and resolves to `dark` with empty storage; Playwright `gallery-no-fouc` snapshot shows no light frame on a stored-dark reload · **after** T6.1.11

#### T6.1.13 · `test: grep test forbidding hex literals in component files` ✅ done (`269b112`)
Scan `apps/web/src/components/**` and `apps/web/src/app/**` for `#rgb`/`#rrggbb` literals and fail on any hit, with `_tokens.scss` and the vendored font files as the only allowed exceptions. A component hardcoding `#B4FF39` breaks AA in light mode silently, so this is a gate, not tidiness.
→ **files** `apps/web/no-hex.test.ts` · **verify** `pnpm test no-hex.test.ts` — adding `color: #B4FF39` to any component file makes it fail · **after** T6.1.6

#### T6.1.14 · `test: assert AA contrast for text pairs in both themes` [a11y] ✅ done (`fec7b03`)
Compute WCAG 2.1 contrast ratios for the token pairs that carry text — `fg`/`bg`, `fg`/`surface`, `muted`/`bg`, `muted`/`surface`, `primary-fg`/`primary`, `primary`/`bg` — in both themes, and fail below 4.5:1 for body text and 3:1 for large text. This is the test that proves why light drops primary to `#3F9142`.
→ **files** `apps/web/src/styles/contrast.test.ts` · **verify** `pnpm test contrast.test.ts` — setting light `primary` back to `#B4FF39` makes it fail · **after** T6.1.3

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

#### T6.2.1 · `chore: init shadcn/ui against the Posta tokens` ✅ done (`2259b9f`)
Run the shadcn init, point `components.json` at `apps/web/src/components/ui`, `apps/web/src/styles/globals.css` and the existing Tailwind config, and set the base colour to the aliased token names rather than letting it write its own palette block.
→ **files** `apps/web/components.json` · `apps/web/src/lib/utils.ts` · **verify** `pnpm test shadcn-config.test.ts` asserts `components.json` aliases resolve to the canonical paths and that init added no second `:root` colour block to `globals.css` · **after** T6.1.6

#### T6.2.2 · `feat: add the shadcn form primitives` ✅ done (`e1b5c6a`)
Add `button`, `input`, `select` and `switch` to `components/ui/` and strip any generated hex or hardcoded palette so they read only token classes.
→ **files** `apps/web/src/components/ui/{button,input,select,switch}.tsx` · **verify** `pnpm test no-hex.test.ts` passes and `pnpm test ui-primitives.test.tsx` renders each without throwing · **after** T6.2.1

#### T6.2.3 · `feat: add the shadcn overlay primitives` ✅ done (`50f5478`)
Add `sheet`, `dialog`, `dropdown-menu` and `tooltip`. The sheet is what S7.3's create/edit link screen mounts over the list, so its side and width defaults are set here.
→ **files** `apps/web/src/components/ui/{sheet,dialog,dropdown-menu,tooltip}.tsx` · **verify** `pnpm test ui-primitives.test.tsx` asserts each opens on trigger and traps focus · **after** T6.2.1

#### T6.2.4 · `feat: add the shadcn feedback primitives` ✅ done (`61588d0`)
Add `toast`, `tabs`, `skeleton` and `badge`, with tabs carrying the lime `border-bottom: 2px` active underline from DESIGN.md §4.
→ **files** `apps/web/src/components/ui/{toast,tabs,skeleton,badge}.tsx` · **verify** `pnpm test ui-primitives.test.tsx` asserts the active tab carries the `border-primary` class · **after** T6.2.1

#### T6.2.5 · `feat: implement the five Button variants with hover, disabled and loading` ✅ done (`729b3d6`)
Wire `primary` (lime fill, graphite text), `secondary` (surface-2), `outline`, `ghost` and `destructive`, plus `sm/md/lg` sizes. Hover is `brightness(1.08)` on filled and `border-color: primary` on outline; disabled is `opacity .5` + `cursor:not-allowed`; loading swaps in the spinner and sets `aria-busy`.
→ **files** `apps/web/src/components/ui/button.tsx` · **verify** `pnpm test button.test.tsx` asserts all five variants render, disabled sets `aria-disabled`, and loading sets `aria-busy` and blocks the click handler · **after** T6.2.2

#### T6.2.6 · `feat: add Input focus halo and error treatment` ✅ done (`2e9bd22`)
Focus is `--ring` plus a `0 0 0 3px` halo at 25% ring; error state swaps the border to `--error` with the matching halo and wires `aria-invalid` + `aria-describedby` to the mono message. Disabled is surface-2 plus opacity.
→ **files** `apps/web/src/components/ui/input.tsx` · **verify** `pnpm test input.test.tsx` asserts the error state sets `aria-invalid="true"` and links the message via `aria-describedby` · **after** T6.2.2

#### T6.2.7 · `feat: add the borders-over-shadows Card primitive` ✅ done (`53282de`)
Card is `surface` + 1px `border` with `--radius`, and no `box-shadow` at all. Optional hover lifts `translateY(-3px)` and swaps the border to primary.
→ **files** `apps/web/src/components/ui/card.tsx` · **verify** `pnpm test card.test.tsx` asserts the computed `box-shadow` is `none` in both themes · **after** T6.2.1

#### T6.2.8 · `feat: reserve elevation shadows for real overlays` ✅ done (`e568ab6`)
Add a single `--shadow-overlay` token (`0 8px 28px rgba(0,0,0,.35)` dark, softened in light) and apply it only to dropdown, dialog, sheet and toast. Flat surfaces keep borders.
→ **files** `apps/web/src/styles/_tokens.scss` · `apps/web/src/components/ui/{sheet,dialog,dropdown-menu,toast}.tsx` · **verify** `pnpm test elevation.test.tsx` asserts the four overlays carry `--shadow-overlay` and that no file under `components/ui` other than those four references it · **after** T6.2.3, T6.2.4, T6.2.7

#### T6.2.9 · `feat: add the mono toast variant` ✅ done (`7796e63`)
Posta's toast copy is mono microcopy (`copiado: juano.posta.lat/promo`, `link creado: …`). Give the toast a mono body, tight radius and a lime accent bar, keeping the destructive variant on `--error`.
→ **files** `apps/web/src/components/ui/toast.tsx` · **verify** `pnpm test toast.test.tsx` asserts the toast description carries `font-mono` and renders the rioplatense sample copy unchanged · **after** T6.2.4

#### T6.2.10 · `test: snapshot every primitive in dark and light` ✅ done (`7d158c8`)
Add a Playwright visual-regression spec that renders each of the twelve primitives in both themes and compares against committed baselines. This is the executable form of "verified in both themes".
→ **files** `apps/web/e2e/primitives.spec.ts` · **verify** `pnpm test:e2e primitives.spec.ts` — snapshots `primitives-dark` and `primitives-light` match baseline · **after** T6.2.5, T6.2.6, T6.2.8, T6.2.9

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

#### T6.3.1 · `feat: add the 220px Sidebar with the v1 route list` ✅ done (`181a1ca`)
Build `Sidebar` as a 220px rail rendering Links / Bio / Ajustes / Pública as `next/link` items with Lucide icons, reading the current route from `usePathname`. Structure only — active styling lands next.
→ **files** `apps/web/src/components/shell/sidebar.tsx` · **verify** `pnpm test sidebar.test.tsx` asserts four nav links render with `role="navigation"` and the rail is `w-[220px]` · **after** T6.2.2

#### T6.3.2 · `feat: mark the active sidebar item with indicator, tint and lime text` ✅ done (`85d6416`)
The active item gets a left indicator bar, a lime tint background and lime text, plus `aria-current="page"`. This is the view's one reserved lime focus.
→ **files** `apps/web/src/components/shell/sidebar.tsx` · **verify** `pnpm test sidebar.test.tsx` asserts exactly one item carries `aria-current="page"` and that it is the only element in the rail using a `primary` colour class · **after** T6.3.1

#### T6.3.3 · `feat: add the Topbar with ⌘K, avatar and Nuevo link` ✅ done (`765aeb9`)
Build `Topbar` with a search affordance showing the `⌘K` hint (renders `Ctrl K` on non-Mac), an avatar dropdown, and the lime **Nuevo link** button. The search opens nothing yet — S7.1 wires the palette.
→ **files** `apps/web/src/components/shell/topbar.tsx` · **verify** `pnpm test topbar.test.tsx` asserts the `⌘K` hint renders and the CTA reads `Nuevo link` · **after** T6.2.2, T6.2.3

#### T6.3.4 · `feat: add BottomTabs with the four v1 tabs` ✅ done (`5b15a0a`)
Build `BottomTabs` as a fixed bar rendering Links / Bio / Ajustes / Pública with icon-over-label, active tab in lime with `aria-current="page"`.
→ **files** `apps/web/src/components/shell/bottom-tabs.tsx` · **verify** `pnpm test bottom-tabs.test.tsx` asserts four tabs render and exactly one is `aria-current="page"` · **after** T6.2.2

#### T6.3.5 · `feat: respect safe-area inset and 44px hit targets on the bottom bar` [a11y] ✅ done (`a19c15b`)
Pad the bar with `env(safe-area-inset-bottom)` so iOS home-indicator devices do not clip the last row, and floor every tab at 44×44px.
→ **files** `apps/web/src/components/shell/bottom-tabs.tsx` · **verify** `pnpm test bottom-tabs.test.tsx` asserts the computed padding-bottom includes the `env()` expression and every tap target measures ≥44px · **after** T6.3.4

#### T6.3.6 · `feat: swap Sidebar for BottomTabs at the 800px breakpoint` ✅ done (`d38f2ad`)
Compose `AppShell` so ≥800px renders Sidebar + Topbar and <800px renders the compact top bar + BottomTabs. The swap is CSS-driven off the `mobile` Tailwind screen, not a JS width listener, so it is SSR-correct on first paint.
→ **files** `apps/web/src/components/shell/app-shell.tsx` · **verify** `pnpm test:e2e shell.spec.ts` asserts the sidebar is visible at 1280px and hidden at 390px with the tab bar visible, on a server-rendered load with JS disabled · **after** T6.3.2, T6.3.3, T6.3.5

#### T6.3.7 · `feat: add the auto-fit card grid utility` ✅ done (`88bc954`)
Add a `grid-cards` utility using `repeat(auto-fit, minmax(220px, 1fr))` so stat and breakdown cards wrap 4→2→1 with no media queries.
→ **files** `apps/web/src/styles/globals.css` · **verify** `pnpm test:e2e shell.spec.ts` asserts four cards lay out in 4, 2 and 1 columns at 1280px, 700px and 390px · **after** T6.2.7

#### T6.3.8 · `feat: add clamp() page padding and hero numeral scales` ✅ done (`d0b3561`)
Add `--pad-page` and `--text-hero` (`clamp(40px, 9vw, 52px)` per POSTA.md §3) as tokens and apply them in the shell's content wrapper, so the hero number scales without breakpoints.
→ **files** `apps/web/src/styles/_tokens.scss` · `apps/web/src/components/shell/app-shell.tsx` · **verify** `pnpm test tokens.test.ts` asserts both emit a `clamp(` expression · **after** T6.3.6

#### T6.3.9 · `test: keyboard traversal and visible focus ring across the shell` [a11y] ✅ done (`f0342bd`)
Tab through the shell asserting a logical order (skip link → topbar → nav → content), a visible `--ring` outline on every focusable, and no keyboard trap in the avatar dropdown.
→ **files** `apps/web/e2e/shell-a11y.spec.ts` · **verify** `pnpm test:e2e shell-a11y.spec.ts` — axe reports zero violations and every focused element has a non-`none` outline · **after** T6.3.6

#### T6.3.10 · `test: assert one lime focus per view` ✅ done (`a38423a`)
Count elements using a `primary` background or text class in a rendered shell and fail above one. This turns BRAND.md §0.2 from a review note into a gate that E7 and E8 inherit.
→ **files** `apps/web/src/components/shell/one-lime.test.tsx` · **verify** `pnpm test one-lime.test.tsx` — adding a second lime CTA to the shell makes it fail · **after** T6.3.6

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

#### T6.4.1 · `feat: add the classification vocabulary to contracts` ✅ done (`a24bda5`)
Add the `Clasificacion` union (`humano | bot | unfurler | prefetch`) and `SourcePlatform` union (`Instagram | WhatsApp | TikTok | directo`) as Zod schemas in `contracts`, matching the `events_classified` view's vocabulary from E4 so the UI and the SQL cannot drift.
→ **files** `packages/contracts/src/classification.ts` · **verify** `pnpm test classification.test.ts` asserts the union members exactly match the four verdicts the view emits · **after** —

#### T6.4.2 · `feat: add the classification colour map` ✅ done (`5a98b29`)
Map each verdict to its semantic token — humano→`primary`, bot→`error`, unfurler→`info`, prefetch→`warning` — as a typed record keyed by `Clasificacion`, so adding a verdict is a compile error until it has a colour.
→ **files** `packages/contracts/src/classification.ts` · **verify** `pnpm test classification.test.ts` asserts the map is total over `Clasificacion` and holds token names, never hex · **after** T6.4.1

#### T6.4.3 · `feat: add HumanoBar with the lime/gray-ramp segments` ✅ done (`d00cdfa`)
Build `HumanoBar` as a 16px flex bar with 2px gaps and `--radius-badge`, rendering humans on `--primary` and bots/unfurlers/prefetch on `--n1/--n2/--n3`. Segment widths are percentages of the total. No bare `6px` — the token or nothing.
→ **files** `apps/web/src/components/honesty/humano-bar.tsx` · **verify** `pnpm test humano-bar.test.tsx` asserts four segments render with widths proportional to the counts · **after** T6.4.2

#### T6.4.4 · `feat: HumanoBar handles zero, all-human and no-human inputs` ✅ done (`d26f0da`)
Guard the percentage maths so a total of 0 renders an inert empty track instead of dividing by zero, 100% human renders one full lime segment, and 0% human renders the ramp with no lime — none of which collapse the bar's height.
→ **files** `apps/web/src/components/honesty/humano-bar.tsx` · **verify** `pnpm test humano-bar.test.tsx` asserts no `NaN` width for `{humano:0,bot:0,unfurler:0,prefetch:0}` and that the track keeps its 16px height in all three cases · **after** T6.4.3

#### T6.4.5 · `feat: keep sub-1% HumanoBar segments visible` ✅ done (`8d8ba66`)
Floor any non-zero segment at a minimum rendered width so a single prefetch out of ten thousand clicks is still visible — the honest split is the point, and a segment that vanishes is a rounded-away lie.
→ **files** `apps/web/src/components/honesty/humano-bar.tsx` · **verify** `pnpm test humano-bar.test.tsx` asserts a 1-in-10000 segment renders with width ≥ the minimum and that widths still sum to 100% · **after** T6.4.4

#### T6.4.6 · `feat: add the HumanoBar legend with labels and counts` [a11y] ✅ done (`4d8bf2a`)
Render a legend of swatch + Spanish label + count (`humanos` / `bots` / `unfurlers` / `prefetch`) and give the bar `role="img"` with an `aria-label` stating the split in words, so colour is never the only channel.
→ **files** `apps/web/src/components/honesty/humano-bar.tsx` · **verify** `pnpm test humano-bar.test.tsx` asserts every segment has a matching legend entry with its count and that the `aria-label` names all four groups · **after** T6.4.5

#### T6.4.7 · `feat: add BadgeHumano with an interpolated color-mix tint` ✅ done (`fde2233`)
Render `% humano` in mono 600 on `color-mix(in srgb, var(--primary) 16%, transparent)` with a 40% border. The `color-mix()` must survive into the emitted CSS — interpolate the token as `#{t(primary)}` so SCSS does not try to evaluate it.
→ **files** `apps/web/src/components/honesty/badge-humano.tsx` · `apps/web/src/styles/_tokens.scss` · **verify** `pnpm test badge-humano.test.tsx` asserts the compiled stylesheet still contains the literal string `color-mix(in srgb, var(--primary) 16%` · **after** T6.4.2

#### T6.4.8 · `feat: add SourceChip with a coloured dot per platform` ✅ done (`6a6bb73`)
Render a mono chip with a platform-coloured dot for Instagram, WhatsApp, TikTok and directo, sized to sit inline in the links list and the fuentes breakdown.
→ **files** `apps/web/src/components/honesty/source-chip.tsx` · **verify** `pnpm test source-chip.test.tsx` asserts each of the four platforms renders its label and a distinct dot colour · **after** T6.4.1

#### T6.4.9 · `feat: SourceChip falls back to directo for unknown platforms` ✅ done (`60f6dfc`)
An unrecognised or empty `source_platform` from the worker's enrichment renders as `directo` rather than a blank chip, so a new referrer shape never produces an invisible row.
→ **files** `apps/web/src/components/honesty/source-chip.tsx` · **verify** `pnpm test source-chip.test.tsx` asserts `""`, `undefined` and `"Threads"` all render the `directo` chip · **after** T6.4.8

#### T6.4.10 · `feat: add the Recibos dark island shell` ✅ done (`0d3ea56`)
Build the `Recibos` container as an always-dark island — `#0D1117` bg, `#161B22` chrome, `#E6EDF3` text, mono — carrying the prompt line `~/posta $ tail -f recibos --link=<slug>` and a pulsing lime live dot. It is not themed: it stays dark under `.light`.
→ **files** `apps/web/src/components/honesty/recibos.tsx` · **verify** `pnpm test:e2e islands.spec.ts` asserts the Recibos background is identical at both theme settings · **after** T6.2.1

#### T6.4.11 · `feat: render Recibos rows as time · source · [classification] · why` ✅ done (`d7954a5`)
Render each `Recibo` as a mono row with the timestamp, the source, the bracketed verdict coloured from the T6.4.2 map, and the `why` string. Long rows wrap rather than causing horizontal scroll.
→ **files** `apps/web/src/components/honesty/recibos.tsx` · **verify** `pnpm test recibos.test.tsx` asserts a `bot` row renders `[bot]` with the `error` token class and a `prefetch` row with `warning` · **after** T6.4.10, T6.4.2

#### T6.4.12 · `perf: cap the Recibos row buffer` ✅ done (`f23911d`)
Keep at most N rows in state, dropping the oldest as new ones arrive, so a busy link streaming for an hour cannot grow the DOM without bound. N is a named constant, not a literal.
→ **files** `apps/web/src/components/honesty/recibos.tsx` · **verify** `pnpm test recibos.test.tsx` asserts pushing 5000 receipts leaves exactly `MAX_RECIBOS` rows in the DOM, newest first · **after** T6.4.11

#### T6.4.13 · `feat: harden the Recibos why string against hostile user-agents` [security] ✅ done (`c8d6c70`)
`why` is built from raw user-agent fragments, so it is attacker-controlled. React escapes text nodes by default, so this task is mostly a **regression guard on that default** — assert `dangerouslySetInnerHTML` is never reachable here — plus genuinely new work: strip control characters and zero-width joiners that would corrupt the terminal layout without being visible in review.
→ **files** `apps/web/src/components/honesty/recibos.tsx` · **verify** `pnpm test recibos.test.tsx` asserts a receipt with `why: "<img src=x onerror=alert(1)>"` renders as visible text with no `img` element in the DOM · **after** T6.4.11

#### T6.4.14 · `feat: add the Recibos empty state in terminal voice` ✅ done (`cf44667`)
With no receipts, render `~/posta $ todavía no hay clicks` and a steady cursor instead of an empty box — rioplatense, direct, in the island's own voice.
→ **files** `apps/web/src/components/honesty/recibos.tsx` · **verify** `pnpm test recibos.test.tsx` asserts the empty state copy renders for `[]` and disappears on the first receipt · **after** T6.4.11

#### T6.4.15 · `test: a11y pass over the four honesty primitives` [a11y] ✅ done (`2c1a482`)
Run axe over HumanoBar, BadgeHumano, SourceChip and Recibos in both themes, and assert every colour-encoded meaning has a text or `aria-label` equivalent — the verdict in a receipt reads as `[bot]`, not as red alone.
→ **files** `apps/web/e2e/honesty-a11y.spec.ts` · **verify** `pnpm test:e2e honesty-a11y.spec.ts` — zero axe violations and every classification colour has a matching text label · **after** T6.4.6, T6.4.7, T6.4.9, T6.4.14

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

#### T6.5.1 · `feat: add the /gallery route with a section layout` ✅ done (`3b665c3`)
Add a `/gallery` App Router page with a sectioned layout and anchor nav. It is a client-only page with no `fetch`, no server action and no API call, so it renders while E1–E4 are still being built.
→ **files** `apps/web/src/app/gallery/page.tsx` · **verify** `pnpm test:e2e gallery.spec.ts` asserts `/gallery` returns 200 and issues zero network requests to the API origin · **after** T6.3.6

#### T6.5.2 · `feat: add the gallery fixtures module` ✅ done (`86f9a4d`)
Add a fixtures module exporting typed sample `Link`, `Recibo` and split data conforming to the `contracts` schemas — the single place gallery data comes from, so no entry ever reaches for a live endpoint.
→ **files** `apps/web/src/app/gallery/fixtures.ts` · **verify** `pnpm test fixtures.test.ts` asserts every fixture parses against its `contracts` Zod schema · **after** T6.4.1

#### T6.5.3 · `feat: add gallery entries for the shadcn primitives` ✅ done (`f965c45`)
Render all twelve primitives with their variants and states — the five button variants, input focus and error, the overlays open, skeleton and badge.
→ **files** `apps/web/src/app/gallery/page.tsx` · **verify** `pnpm test:e2e gallery.spec.ts` asserts a section heading exists for each of the twelve primitives · **after** T6.5.1, T6.2.10

#### T6.5.4 · `feat: add gallery entries for the four honesty primitives` ✅ done (`39069bc`)
Render HumanoBar, BadgeHumano, SourceChip and Recibos from fixtures in their normal state, with Recibos shown as a live island.
→ **files** `apps/web/src/app/gallery/page.tsx` · **verify** `pnpm test:e2e gallery.spec.ts` asserts all four primitives render with fixture data · **after** T6.5.2, T6.4.15

#### T6.5.5 · `feat: add gallery entries for the shell at both breakpoints` ✅ done (`5b150fc`)
Render Sidebar, Topbar and BottomTabs in framed viewports so the 800px swap is inspectable on one page without resizing the browser.
→ **files** `apps/web/src/app/gallery/page.tsx` · **verify** `pnpm test:e2e gallery.spec.ts` asserts both the desktop and mobile shell frames render simultaneously · **after** T6.5.1, T6.3.6

#### T6.5.6 · `feat: add honesty edge-case fixtures to the gallery` ✅ done (`9b4f4d9`)
Add the cases the primitives are most likely to break on: 0 clicks, 100% human, 0% human, a 1-in-10000 segment, and a `why` string long enough to wrap plus one carrying an HTML payload.
→ **files** `apps/web/src/app/gallery/fixtures.ts` · `apps/web/src/app/gallery/page.tsx` · **verify** `pnpm test:e2e gallery.spec.ts` asserts all six edge cases render and the page has no horizontal overflow · **after** T6.5.4

#### T6.5.7 · `feat: add the theme toggle to the gallery` ✅ done (`29f4496`)
Add a persistent toggle wired to `useTheme()` so every entry can be flipped between dark and light in place — this is how "verified in both themes" actually gets checked by a human.
→ **files** `apps/web/src/app/gallery/page.tsx` · **verify** `pnpm test:e2e gallery.spec.ts` asserts the toggle adds and removes `.light` on the root and that the Recibos island background is unchanged by it · **after** T6.5.4, T6.1.11

#### T6.5.8 · `test: add gallery visual regression snapshots` ✅ done (`7d158c8`)
Add a Playwright spec capturing the full gallery in both themes at 1280px and 390px, with committed baselines — four snapshots that catch any unintended token or component change across the whole system.
→ **files** `apps/web/e2e/gallery-visual.spec.ts` · **verify** `pnpm test:e2e gallery-visual.spec.ts` — snapshots `gallery-dark-desktop`, `gallery-light-desktop`, `gallery-dark-mobile`, `gallery-light-mobile` match baseline · **after** T6.5.6, T6.5.7

#### T6.5.9 · `ci: run the visual regression suite and upload diffs` ✅ done (`eea93ac`)
Add the Playwright job to the E0 workflow with the browser cache, running the gallery and primitive specs and uploading the diff artifacts on failure so a snapshot break is reviewable from the PR.
→ **files** `.github/workflows/ci.yml` · `apps/web/playwright.config.ts` · **verify** the CI run publishes a `playwright-report` artifact and fails the job on a deliberate baseline mismatch · **after** T6.5.8
