import type { Config } from 'tailwindcss';

// T6.1.6 — `theme.colors` is a CLOSED palette, not `theme.extend.colors`:
// `extend` merges alongside Tailwind's own stock reds/blues/grays, which
// would let `bg-red-500` sneak a hex value into a component despite the
// no-hex-in-components gate (T6.1.13) never seeing it (Tailwind's own
// palette lives inside the tailwindcss package, not in this file). Setting
// `theme.colors` outright replaces the default palette, so every color
// utility Tailwind can generate resolves through one of _tokens.scss's own
// CSS custom properties — `bg-primary` and `var(--primary)` are the same
// value because there is only one definition of "primary" anywhere.
//
// Every key here is a CSS custom property _tokens.scss (T6.1.1-T6.1.4)
// actually emits: the 14 canonical Posta names + the gray ramp + the 5
// shadcn aliases. tailwind-tokens.test.ts (T6.1.7) is what fails the
// build the moment either side gains or loses a name the other lacks.
const colors = {
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  'surface-2': 'var(--surface-2)',
  fg: 'var(--fg)',
  muted: 'var(--muted)',
  border: 'var(--border)',
  'border-subtle': 'var(--border-subtle)',
  primary: 'var(--primary)',
  'primary-fg': 'var(--primary-fg)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--error)',
  'error-fg': 'var(--error-fg)',
  info: 'var(--info)',
  ring: 'var(--ring)',
  n1: 'var(--n1)',
  n2: 'var(--n2)',
  n3: 'var(--n3)',
  // shadcn's own expected slot names (T6.1.4's aliases)
  background: 'var(--background)',
  card: 'var(--card)',
  'muted-foreground': 'var(--muted-foreground)',
  destructive: 'var(--destructive)',
  'destructive-foreground': 'var(--destructive-foreground)',
  input: 'var(--input)',
} as const;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    colors,
    borderRadius: {
      none: '0',
      sm: 'var(--radius-sm)',
      badge: 'var(--radius-badge)',
      DEFAULT: 'var(--radius)',
      lg: 'var(--radius-lg)',
      full: '9999px',
    },
    extend: {
      // T6.1.9 — the only two families in the system (DESIGN.md §3): UI
      // text reads Space Grotesk, anything code-shaped (slugs, handles,
      // metrics, terminal prompts) reads JetBrains Mono. System-font
      // fallbacks keep text visible during the font-display: swap window.
      fontFamily: {
        sans: ['Space Grotesk', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      spacing: {
        '1': 'var(--space-1)',
        '2': 'var(--space-2)',
        '3': 'var(--space-3)',
        '4': 'var(--space-4)',
        '6': 'var(--space-6)',
        '8': 'var(--space-8)',
        '12': 'var(--space-12)',
        '16': 'var(--space-16)',
      },
      screens: {
        // Mirrors $bp-mobile in _tokens.scss. Duplicated deliberately: a
        // JS/TS config cannot import a SCSS variable, and a media-query
        // breakpoint cannot be a runtime CSS custom property either way.
        mobile: '800px',
      },
      // T6.2.8 — DESIGN.md §2.3: elevation is reserved for real overlays
      // (dropdown, dialog, sheet, toast) only — everything else stays on
      // borders (Card, T6.2.7). One named shadow, not a scale, so a
      // component reaching for `shadow-md`/`shadow-lg` reads as an
      // obvious off-spec diff in review.
      boxShadow: {
        overlay: 'var(--shadow-overlay)',
      },
    },
  },
  plugins: [],
};

export default config;
