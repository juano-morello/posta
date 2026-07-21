# JuanoDev — Design System (DESIGN.md)

Capa **técnica** para construir las webs y webapps de JuanoDev con Claude Code. La capa de identidad (voz, logo, redes) vive en **[`BRAND.md`](./BRAND.md)**.

> Fuente de verdad para asistentes. UI Kit visual e interactivo: `JuanoDev UI Kit.dc.html`.
> Stack: **React + Tailwind CSS + shadcn/ui.** Iconos: set lineal sobrio (ej. Lucide). Cada componente mapea 1:1 a shadcn.

---

## 1. Temas (dark-first)

- **Dark es el default; light es soporte.**
- **Terminales y code blocks son SIEMPRE oscuros** (grafito `#0D1117`), incluso en light mode. Son "islas" que preservan la identidad terminal en cualquier tema — como los bloques de código de una doc real. **No los tematices.** Aplica a: terminal, code block, code diff, log stream, code snippet.
- En **light mode** la profundidad se invierte: página en tono sutil (`#F6F8FA`), cards en **blanco puro** (`#FFFFFF`) para que resalten. Nunca cards más grises que el fondo.

---

## 2. Design tokens

CSS variables con el **mismo esquema que shadcn/ui**. El nombre semántico no cambia entre temas; solo cambia el valor.

### 2.1 Paleta — HEX (referencia rápida)

| Token semántico    | Dark      | Light     | Uso |
|--------------------|-----------|-----------|-----|
| `background`       | `#0D1117` | `#F6F8FA` | Fondo de página |
| `surface` / card   | `#161B22` | `#FFFFFF` | Cards, paneles, inputs elevados |
| `surface-2`        | `#21262D` | `#EDF1F5` | Hover de superficies, secondary |
| `foreground`       | `#E6EDF3` | `#0D1117` | Texto principal |
| `muted-foreground` | `#8B949E` | `#57606A` | Texto secundario, captions |
| `border`           | `#30363D` | `#D8DEE4` | Bordes de componentes |
| `border-subtle`    | `#21262D` | `#E7EBEF` | Divisores, bordes internos |
| `primary` (lime)   | `#B4FF39` | `#3F9142` | Acento de marca, CTA |
| `primary-foreground`| `#0D1117`| `#FFFFFF` | Texto sobre `primary` |
| `ring`             | `#B4FF39` | `#3F9142` | Focus ring |
| `success`          | `#3FB950` | `#2DA44E` | Estado OK |
| `warning`          | `#E3B341` | `#BF8700` | Advertencia |
| `error` / destructive | `#F85149` | `#CF222E` | Error, destructivo |
| `info`             | `#58A6FF` | `#0969DA` | Info, links |

> **Sobre el lime:** el color de identidad es `#B4FF39`. En light el `primary` baja a `#3F9142` para contraste AA (lime puro sobre blanco no pasa). En dark siempre `#B4FF39`. Las **islas oscuras** usan `#B4FF39` siempre (viven sobre grafito).

### 2.2 shadcn `globals.css` (HSL, copiar tal cual)

```css
:root {
  --background: 213 27% 7%;
  --foreground: 213 31% 91%;
  --card: 215 21% 11%;
  --card-foreground: 213 31% 91%;
  --popover: 213 27% 7%;
  --popover-foreground: 213 31% 91%;
  --primary: 82 100% 61%;          /* lime #B4FF39 */
  --primary-foreground: 213 27% 7%;
  --secondary: 214 16% 16%;
  --secondary-foreground: 213 31% 91%;
  --muted: 215 21% 11%;
  --muted-foreground: 212 10% 58%;
  --accent: 214 16% 16%;
  --accent-foreground: 213 31% 91%;
  --destructive: 4 92% 63%;
  --destructive-foreground: 0 0% 100%;
  --border: 215 14% 22%;
  --input: 215 14% 22%;
  --ring: 82 100% 61%;
  --radius: 0.5rem;
}

.light {
  --background: 0 0% 100%;
  --foreground: 213 27% 7%;
  --card: 210 29% 97%;
  --card-foreground: 213 27% 7%;
  --popover: 0 0% 100%;
  --popover-foreground: 213 27% 7%;
  --primary: 123 39% 41%;          /* green #3F9142 */
  --primary-foreground: 0 0% 100%;
  --secondary: 210 20% 92%;
  --secondary-foreground: 213 27% 7%;
  --muted: 210 29% 97%;
  --muted-foreground: 213 8% 39%;
  --accent: 210 20% 92%;
  --accent-foreground: 213 27% 7%;
  --destructive: 356 71% 47%;
  --destructive-foreground: 0 0% 100%;
  --border: 210 18% 84%;
  --input: 210 18% 84%;
  --ring: 123 39% 41%;
}
```

> Nota: los HEX se convirtieron a HSL aproximado para shadcn. Para exactitud absoluta, usá un plugin que acepte HEX o `oklch`.

### 2.3 Radius, spacing, sombras

- **Radius:** base `8px` (`--radius: 0.5rem`). Escala: `sm 4px · md 8px · lg 12px · full`. Terminal-look = esquinas ajustadas, nunca pill salvo badges/avatars.
- **Spacing:** escala de 4 → `4 8 12 16 24 32 48 64`. Densidad **media**.
- **Sombras:** mínimas. Elevación real solo en overlays (dropdown, modal, drawer, toast): `0 8px 28px rgba(0,0,0,.35)` en dark. En superficies planas, preferir borde a sombra.

---

## 3. Tipografía (escalas)

| Rol | Familia | Peso | Tamaño (web) |
|-----|---------|------|--------------|
| H1 | Space Grotesk | 700 | 48–56px, tracking -0.035em |
| H2 | Space Grotesk | 700 | 32px, tracking -0.025em |
| H3 | Space Grotesk | 600 | 19–24px |
| Body | Space Grotesk | 400 | 15–16px, line-height 1.6 |
| Caption | Space Grotesk | 400 | 12–13px |
| Code / mono | JetBrains Mono | 400–600 | 12–14px |

Import:
```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```

**Video vertical (1080×1920):** hook 96–120px/700 · subtítulo 52–64px/600 · lower third 40px · handle 32px · captions 44–52px/600.
**Thumbnail (1280×720):** título 90–130px/700 (máx 5 palabras) · prompt 26–32px mono · handle 24px mono.

---

## 4. Componentes (specs de estados)

Ver `JuanoDev UI Kit.dc.html` para el render exacto. Reglas transversales:

- **Botones:** `primary` (lime, texto grafito) · `secondary` (surface-2) · `outline` · `ghost` · `destructive`. Estados: hover (`brightness 1.08` en filled, `border-color: primary` en outline), disabled (`opacity .5`, `cursor:not-allowed`), loading (spinner). Tamaños sm/md/lg.
- **Inputs:** borde `--border`, focus = `--ring` + halo `0 0 0 3px ring/25%`. Error = borde `--error` + halo. Disabled = surface-2 + opacity.
- **Cards:** `surface` + `border`. Hover opcional: `translateY(-3px)` + `border-color: primary`.
- **Badges:** mono, `6px` radius. Variantes: primary, default, outline, success/warning/error (con `color-mix` al ~15% de fondo), con dot, removibles.
- **Tabs:** underline lime en el activo (`border-bottom: 2px primary`). Vertical: `border-left` lime.
- **Dropdown / modal / drawer / toast:** overlays con sombra real; modal con backdrop `rgba(0,0,0,.6)` + blur. Drawer: backdrop separado del panel.
- **Terminal/code block:** signature. **Siempre oscuro** (fondo `#0D1117`, chrome `#161B22`, texto `#E6EDF3`, muted `#8B949E`). Sintaxis: keywords violeta `#8B5CF6`, tags/componentes `#58A6FF`, atributos `#E3B341`, strings lime `#B4FF39`, comentarios muted. Cursor lime parpadeante, typing effect.
- **Avatares:** círculo `surface-2` con iniciales o `>J`; dot de estado (`success`) con borde del color de fondo; grupos apilados overlap `-12px` + contador `+N` en lime.
- **Progress:** track `surface-2`, fill `primary`/`info`, `8px` alto, radius full. Spinner: borde `surface-2` con `border-top-color: primary`, `spin .8s`.
- **Skeleton:** bloques `surface-2` con `@keyframes pulse` (opacity 1↔.45, 1.6s). Respetá la forma del contenido real.
- **Breadcrumbs:** mono, separador `/`, último ítem en `--fg`, resto `--fg-muted`.
- **Pagination:** botones `32px`, activo en lime, resto con `border`; flechas `‹ ›` en muted.
- **Tooltip:** fondo `--fg` / texto `--bg` (invertido), mono `11px`, con flechita.
- **Tabla:** header `surface-2` mono uppercase muted; filas con `border-subtle` y hover `surface-2`; columna de estado con badges.

### 4.1 Inventario v1 (todos en dark + light)

**Navegación:** sidebar, topbar (⌘K), tabs horizontales, **tabs verticales**, breadcrumbs, pagination, dropdown, **navbar público** (+ menú mobile), **stepper** (done=lime check, activo=ring lime, todo=muted).

**Formularios:** input, select, textarea, checkbox, switch, **radio group**, **slider**, **input con prefijo/sufijo**, **tags input** (chips mono removibles), **combobox**, **file upload** (dropzone dashed), **date picker** (calendario en popover), **form login/signup** (OAuth + divider + email).

**Feedback:** toast, alert, progress (barra + spinner), skeleton, **empty state** (prompt terminal), **banner de anuncio** (barra lime dismissible), **undo snackbar** (barra grafito fija, siempre oscura), **notification badge** (dot / contador).

**Overlays:** modal/dialog, tooltip, **accordion** (single-open, icono +/−), **drawer/sheet** lateral, **popover** rich, **confirmación destructiva** (borde `error`, input de confirmación por nombre).

**Datos & viz:** stat cards, tabla, **tabla avanzada** (checkbox, sort, chip de filtro, barra de acciones), **bar chart**, **line/area chart** (SVG polyline + gradient), **KPI con sparkline**, **timeline/activity feed**, **calendar view**, **code diff** (island oscura), **log stream** (island oscura, niveles por color + cursor).

**Contenido/marketing:** hero, feature bento, pricing cards, testimonial, FAQ, CTA section, footer completo, blog/doc article (TOC + cuerpo), **code snippet con language tabs** (island oscura).

**Páginas de sistema:** 404/error (prompt `cd` + mensaje shell), loading/splash.

> **Regla:** charts (SVG polyline/area/sparkline) son data-viz permitida. `code diff`, `log stream`, `code snippet` y toda terminal = **islas siempre oscuras** (ver §1).

---

## 5. Layouts de página

- **Landing:** topbar (wordmark + nav + CTA lime) → hero centrado con prompt + H1 + subtítulo + 2 CTAs → secciones con aire.
- **Dashboard / app shell:** sidebar `220px` (item activo en lime) + topbar con búsqueda (`⌘K`) y avatar → grid de stat cards.
- **Pricing:** 3 planes, el destacado con borde lime + badge "popular".
- **Settings:** nav vertical de secciones + formulario a la derecha, botón guardar lime.

---

## 6. Cómo pedirle componentes a Claude Code

Incluí este archivo en el contexto (ver §7) y pedí las cosas así:

**Buenos prompts:**
- "Creá un `<Button>` shadcn con las variantes de DESIGN.md (primary lime, secondary, outline, ghost, destructive) usando los tokens CSS. Dark-first."
- "Armá una landing siguiendo el layout de §5: topbar con wordmark JuanoDev + CTA lime, hero con prompt `~/juanodev $`, H1 en Space Grotesk. Solo tokens semánticos, nada de HEX hardcodeado."
- "Dashboard con el app shell de §5: sidebar 220px con item activo en `--primary`, topbar ⌘K. Stat cards con borde, sin sombra."
- "Terminal/code block signature: chrome con 3 dots, typing effect, cursor lime parpadeante — island siempre oscura."

**Reglas que el asistente debe respetar siempre:**
- Usar **tokens semánticos** (`bg-primary`, `text-muted-foreground`, `border-border`), nunca HEX suelto.
- Un solo foco de lime por vista.
- Space Grotesk + JetBrains Mono, nada más.
- Terminales/diffs/logs/snippets = **siempre oscuros**, incluso en light.
- Nada de naranja, gradientes de agencia, ni emojis decorativos.
- Motion sutil salvo terminales (typing/cursor).

**Checklist antes de dar por bueno un componente:**
- [ ] Funciona en dark y light (probar toggle).
- [ ] Las islas de código quedaron oscuras en ambos temas.
- [ ] Focus ring visible y con contraste (accesibilidad).
- [ ] El lime no está sobreusado.
- [ ] Handles correctos si aparece alguno (`BRAND.md §5`).
- [ ] Tipografías y radius del sistema.

---

## 7. Setup en el repo

1. Copiá `BRAND.md` y `DESIGN.md` a la raíz del proyecto (o a `docs/`).
2. **Claude Code:** referencialos desde `CLAUDE.md`:
   ```md
   # Proyecto JuanoDev
   Identidad de marca → ./BRAND.md
   Sistema de diseño (tokens, componentes) → ./DESIGN.md
   Stack: React + Tailwind + shadcn/ui. Dark-first.
   ```
   Claude Code lee `CLAUDE.md` automáticamente en cada sesión.
3. **Claude chat / Projects:** subí ambos a *Project Knowledge*.
4. Pegá el bloque de §2.2 en tu `globals.css` de shadcn: los tokens quedan cableados.

---

_v1.0 · modern terminal · identidad en [`BRAND.md`](./BRAND.md) · UI Kit visual en `JuanoDev UI Kit.dc.html`._
