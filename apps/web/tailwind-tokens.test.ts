import resolveConfig from 'tailwindcss/resolveConfig';
import { describe, expect, it } from 'vitest';
import tailwindConfig from './tailwind.config';

// T6.1.6 — `bg-primary` and `var(--primary)` must resolve to one value, so
// tailwind.config.ts's `theme.colors` is a CLOSED palette (not `extend`,
// which would merge alongside Tailwind's own stock reds/blues/grays) where
// every entry is a var() reference to a CSS custom property _tokens.scss
// actually emits — never a literal hex. `resolveConfig` is Tailwind's own
// API for producing the fully-merged theme object; using it here (rather
// than reading the raw config module) is what proves the *effective*
// theme Tailwind will build classes from, not just what the file says.
const resolved = resolveConfig(tailwindConfig);

describe('tailwind.config.ts', () => {
  it('resolves every color to a var(--token) reference, never a hex literal', () => {
    const colors = resolved.theme.colors as Record<string, unknown>;
    const entries = Object.entries(colors);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, value] of entries) {
      expect(typeof value, `color "${name}" should be a string`).toBe('string');
      expect(value as string, `color "${name}" = "${value}"`).toMatch(/^var\(--/);
    }
  });
});
