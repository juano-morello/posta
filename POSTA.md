# Posta — Product & Build Spec

Spec for building **Posta**, a link-in-bio + short-link tool with an honesty-first analytics UI. Posta lives **inside the JuanoDev design system** — this file is the product layer; the visual system is defined in:

- **[`BRAND.md`](./BRAND.md)** — identity, voice, logo, color as identity.
- **[`DESIGN.md`](./DESIGN.md)** — tokens, components, layouts (React + Tailwind + shadcn/ui, dark-first).

> Read those two first. Everything here assumes their tokens, type (Space Grotesk + JetBrains Mono), 8px radius, borders-over-shadows, and the "one lime focus per view" rule.

---

## 0. What Posta is (and isn't of JuanoDev)

Posta reuses JuanoDev's *visual system* but is its **own product**:

- The wordmark is **Posta**, not JuanoDev. Render it with a trailing blinking lime block cursor.
- The terminal prompt motif becomes **`~/posta $`**.
- Handles shown are the **user's own** (`@juano`), not the brand's platform handles.
- It stays **lime** (`#B4FF39` dark / `#3F9142` light). Never LBT's orange.
- UI language is **Spanish (rioplatense, direct)** — "Nuevo link", "clicks reales", "todavía no hay links". Never corporate.

Short-link domain: **`posta.lat/<slug>`**. Public bio subdomain (read-only in v1): **`juano.lbt.works`**.

---

## 1. The honesty-UI principle (the soul — treat as first-class)

Every metric surface obeys **one rule**: the hero number is **real humans, always**. Bots / unfurlers / prefetch appear as an honest **secondary** split — never folded into the headline.

This produces a small set of **signature components** to build as real, reusable primitives (not decoration):

1. **Real-vs-no-humano segmented bar** — humans in lime; the rest in a graded gray ramp (bots → unfurlers → prefetch). Thin (14–16px), 6px radius, 2px gaps.
2. **`% humano` badge** — mono, lime, tinted background (`color-mix(in srgb, var(--primary) 16%, transparent)`).
3. **Source-platform chips** — Instagram / WhatsApp / TikTok / directo, mono, each with a colored dot.
4. **`recibos` log island** — a terminal-styled live stream of recent **raw clicks** with their classification and *why* each was flagged. This transparency **is the product** — design it like the point.

**Gray ramp tokens** (added on top of DESIGN.md; the "no humano" grays must adapt to theme so they never go near-black on white):

```css
:root { --n1:#5a6069; --n2:#3f444c; --n3:#2b3038; } /* dark */
.light { --n1:#8B94A0; --n2:#B7BFC9; --n3:#D6DCE3; }
```

Use `--n1/2/3` for the bar's non-human segments, the chart's "no humano" line, and legend swatches. Lime is always humans.

**Classification colors** (used in recibos + splits):
`humano` = `--primary` · `bot` = `--error` · `unfurler` = `--info` · `prefetch` = `--warning`.

---

## 2. Screen map (v1)

**Authed (app shell):** login · links overview · create/edit link · link analytics · bio editor · settings.
**Public:** bio page · 404.

### 1 · Login (`/login`)
Single **terminal card** (always-dark island): chrome 3-dots, title `~/posta $ login`, Posta wordmark + blinking lime cursor, tagline `links honestos. clicks reales.` Email + password (or magic link — Better Auth). Lime **Entrar**. One seeded account, no signup in v1.

### 2 · Links overview (`/`) — home & workhorse
- Top: slim band of **bordered stat cards** — clicks reales · % no humano (global) · mejor link · top fuente. Border, no shadow.
- **Links list**, each row = mono slug (`posta.lat/promo`), destination (favicon + host), **real clicks (bold)**, bot % (muted), 7-day **sparkline**, copy button.
- Toolbar: client-side **search filter** + lime **Nuevo link**.
- **Empty state** is terminal: `~/posta $ todavía no hay links` (dark island block).
- Interactions: search-filter, copy-to-clipboard with a **mono toast**, hover lifts the row's left border to lime. Row click → analytics.

### 3 · Create / edit link — shadcn **sheet** over the list
Fields: destination URL; slug toggle **Aleatorio / Personalizado**; when personalizado, a vanity input showing the live domain prefix (`posta.lat/____`) with a reroll for random; optional title. **Inline validation** (slug taken → lime-error border + halo + mono message). Sheet header shows `~/posta $ new` / `~/posta $ edit <slug>`. On save: row appears highlighted with the short link + copy button surfaced.

### 4 · Link analytics (`/l/:id`) — the honesty screen
This is where the thesis is felt or missed.
- **Header:** short link big in mono + copy + destination + **Editar link**.
- **Hero row:** "clicks reales" as a large **lime** number, the **`% humano` badge**, the **segmented real-vs-no-humano bar** with a legend (humanos / bots / unfurlers / prefetch counts). A default toggle **solo humanos (on) / todo**.
- **Time-series area chart**, two series (humanos vs no-humano), range toggle **7d / 30d / todo**.
- **Breakdown cards:** top países · fuentes (platform chips + bars) · dispositivos · an **in-app browser** flag card.
- **Bottom:** the **`recibos`** terminal island — `~/posta $ tail -f recibos --link=<slug>`, live dot, rows of `time · source · [classification] · why`.

### 5 · Bio editor (`/bio`) — split view
- **Left form:** avatar upload, nombre, bio, theme picker (2–3 terminal themes), and the ordered link list — links are **picked from existing short links** (so every bio link is already tracked), with add/remove and up/down reordering (arrow buttons, no drag lib).
- **Right:** a **live mobile preview** of the public page, updating as you edit. Lime **Guardar**.

### 6 · Settings (`/settings`)
Handle/subdomain read-only (`juano.lbt.works`), account (email + **Free** plan badge), appearance (theme toggle), and **dimmed "próximamente"** placeholders for *Dominio propio* (v1.5) and *API keys* (v2) — present so the layout anticipates them, not built.

### 7 · Bio page (public, SSR) — mobile-first, visitor-facing
Dark terminal theme (always): avatar with lime ring, `@handle` in mono, display name, bio, a vertical stack of **terminal-styled link buttons** (lime `→` cursor, hover lifts border to lime + translateY), subtle background grid, mono footer `hecho con Posta`. This is what the world opens from Instagram — design **mobile-first** and unfurl cleanly (OG tags). One of the 2–3 themes.

### 8 · 404 / link no encontrado — on-brand system page
Terminal shell: `~/posta $ cd /<slug>` → `error: no existe ese link`, blinking cursor, a quiet link back to Posta.

---

## 3. App shell & responsive rules

- **Desktop (≥800px):** sidebar `220px` (active item lime: left indicator + lime tint + lime text) + topbar with `⌘K` search, avatar, lime **Nuevo link**.
- **Mobile (<800px):** hide the sidebar → compact **top bar** (wordmark + theme toggle + Nuevo) and a fixed **bottom tab bar** (Links / Bio / Ajustes / Pública), active tab in lime. Respect `env(safe-area-inset-bottom)`.
- Stat / breakdown cards: `grid-template-columns: repeat(auto-fit, minmax(...))` so they wrap 4→2→1 with no media queries.
- Links list: flex rows; drop the sparkline on narrow screens.
- Bio editor: two columns on desktop, **stacked** (form over preview) on mobile.
- Use `clamp()` for page padding and large numerals (e.g. hero `clamp(40px, 9vw, 52px)`).

---

## 4. Islands are always dark (from DESIGN.md §1)

`login card`, `public bio`, `404`, `recibos`, and any code/log/terminal surface stay on graphite (`#0D1117` bg, `#161B22` chrome, `#E6EDF3` text, `#8B949E` muted, lime `#B4FF39`) **in both themes**. Do not theme them.

---

## 5. Data model (mock shape used in the prototype)

```ts
type Link = {
  id: number; slug: string;          // posta.lat/<slug>
  dest: string; host: string;        // destination + display host
  favLetter: string; favColor: string;
  realClicks: number;                // HUMANS only — the hero number
  botPct: number;                    // % of ALL clicks that were non-human
  spark: number[];                   // 7-day series for the sparkline
};

// Derived for analytics:
// nohuman = round(realClicks / (1 - botPct/100)) - realClicks
// split → bots ~50%, unfurlers ~32%, prefetch ~remainder of nohuman
// humanPct = round(realClicks / (realClicks + nohuman) * 100)

type Recibo = {
  t: string; src: 'Instagram'|'WhatsApp'|'TikTok'|'directo';
  cls: 'humano'|'bot'|'unfurler'|'prefetch';
  why: string;                       // e.g. "user-agent 'python-requests'", "preview de link · dwell 0 ms"
};
```

---

## 6. Voice & microcopy

Rioplatense, direct, no corporate tone (BRAND.md §7). Examples in use:
- `Nuevo link` · `clicks reales` · `% no humano` · `solo humanos` / `todo` · `no hum.`
- Validation: `✕ ese slug ya existe — probá otro`
- Toasts: `copiado: posta.lat/promo` · `link creado: …` · `bio guardada`
- Empty/system: `~/posta $ todavía no hay links` · `error: no existe ese link`
- Login tagline: `links honestos. clicks reales.` · Footer: `hecho con Posta`

---

## 7. Checklist before shipping a screen

- [ ] The **hero number is humans**; non-human is a visible secondary split, never in the headline.
- [ ] Works in **dark and light**; the `--n1/2/3` grays adapt (never near-black on white).
- [ ] Terminal/log islands stayed **dark** in both themes.
- [ ] Only **one lime focus** per view.
- [ ] Space Grotesk (UI) + JetBrains Mono (slugs, handles, metrics, prompts) — nothing else.
- [ ] Responsive: sidebar → bottom tabs under 800px; cards wrap; no horizontal scroll.
- [ ] Copy is rioplatense and direct.
- [ ] Focus ring visible (`--ring`); hit targets ≥44px on mobile.

---

## 8. SCSS setup

Stack uses **SCSS**. Keep tokens as CSS custom properties (so runtime theme switching works via a `.light` class), and use **SCSS only for authoring ergonomics** — maps, mixins, the breakpoint, and the honesty components. Do **not** hardcode hex in components; read `var(--*)`.

### 8.1 Tokens → CSS custom properties

```scss
// _tokens.scss — single source of truth, emitted as CSS vars
$themes: (
  dark: (
    bg:#0D1117, surface:#161B22, surface-2:#21262D, fg:#E6EDF3,
    muted:#8B949E, border:#30363D, border-subtle:#21262D,
    primary:#B4FF39, primary-fg:#0D1117,
    success:#3FB950, warning:#E3B341, error:#F85149, info:#58A6FF, ring:#B4FF39,
    n1:#5a6069, n2:#3f444c, n3:#2b3038,           // no-humano gray ramp
  ),
  light: (
    bg:#F6F8FA, surface:#FFFFFF, surface-2:#EDF1F5, fg:#0D1117,
    muted:#57606A, border:#D8DEE4, border-subtle:#E7EBEF,
    primary:#3F9142, primary-fg:#FFFFFF,
    success:#2DA44E, warning:#BF8700, error:#CF222E, info:#0969DA, ring:#3F9142,
    n1:#8B94A0, n2:#B7BFC9, n3:#D6DCE3,
  ),
);

@mixin emit-vars($map) { @each $k, $v in $map { --#{$k}: #{$v}; } }

:root       { @include emit-vars(map-get($themes, dark)); }   // dark-first default
.light      { @include emit-vars(map-get($themes, light)); }

// helper so component SCSS reads tokens, never hex
@function t($name) { @return var(--#{$name}); }
```

### 8.2 Radius / spacing / breakpoint

```scss
$radius-sm: 4px; $radius: 8px; $radius-lg: 12px;   // terminal look = tight corners
$space: (1:4px, 2:8px, 3:12px, 4:16px, 6:24px, 8:32px, 12:48px, 16:64px);
$bp-mobile: 800px;                                  // sidebar → bottom tabs below this
@mixin mobile { @media (max-width: #{$bp-mobile - 1px}) { @content; } }
```

### 8.3 Type + islands mixins

```scss
@mixin ui   { font-family:'Space Grotesk', system-ui, sans-serif; }
@mixin mono { font-family:'JetBrains Mono', monospace; }

// terminal/log/code surfaces — ALWAYS dark, both themes (do not theme these)
@mixin island {
  background:#0D1117; color:#E6EDF3; border:1px solid #30363D; border-radius:$radius-lg;
  @include mono;
  .lime { color:#B4FF39; } .muted { color:#8B949E; }
}
```

### 8.4 Honesty components

```scss
.humano-bar {                        // real-vs-no-humano segmented bar
  display:flex; height:16px; gap:2px; border-radius:$radius-sm; overflow:hidden; background:t(bg);
  > i { height:100%; display:block; }
  .is-human   { background:t(primary); }
  .is-bot     { background:t(n1); }
  .is-unfurl  { background:t(n2); }
  .is-prefetch{ background:t(n3); }
}
.badge-humano {                      // "% humano"
  @include mono; font-weight:600; padding:6px 11px; border-radius:$radius-sm;
  color:t(primary);
  background:color-mix(in srgb, #{t(primary)} 16%, transparent);
  border:1px solid color-mix(in srgb, #{t(primary)} 40%, transparent);
}
$cls-colors: (humano:primary, bot:error, unfurler:info, prefetch:warning);  // classification → token
.recibos { @include island; }        // + $cls-colors for the [class] tags
```

Keep `color-mix()` in the emitted CSS (don't let SCSS try to evaluate it — interpolate the token: `#{t(primary)}`).

---

_Posta v1 · honesty-first analytics · visual system in [`DESIGN.md`](./DESIGN.md) · identity in [`BRAND.md`](./BRAND.md)._
