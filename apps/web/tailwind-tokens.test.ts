import path from 'node:path';
import * as sass from 'sass';
import resolveConfig from 'tailwindcss/resolveConfig';
import { describe, expect, it } from 'vitest';
import tailwindConfig from './tailwind.config';

const TOKENS_PATH = path.resolve(__dirname, 'src/styles/_tokens.scss');

// Non-color scales (radius/spacing) also live under :root in _tokens.scss
// but are never Tailwind "colors" — excluded so the drift comparison below
// only ever looks at the color vocabulary the two systems actually share.
const NON_COLOR_PREFIXES = ['radius', 'space-'];

function isColorName(name: string): boolean {
  return !NON_COLOR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Every distinct `--name` custom property _tokens.scss emits, color-only. */
function tokenColorNames(): Set<string> {
  const css = sass.compile(TOKENS_PATH).css;
  const names = new Set<string>();
  for (const match of css.matchAll(/--([a-z0-9-]+):/g)) {
    const name = match[1]!;
    if (isColorName(name)) {
      names.add(name);
    }
  }
  return names;
}

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

  // T6.1.7 — the test that catches a token added in one place only. Neither
  // side may have a name the other lacks: a color added to _tokens.scss
  // but never wired into tailwind.config.ts is unusable as a Tailwind
  // class; a Tailwind color pointing at a var() _tokens.scss never emits
  // resolves to nothing at runtime. Deleting one entry from
  // tailwind.config.ts is exactly what should make this fail.
  it('never drifts from _tokens.scss — same color names on both sides', () => {
    const scssNames = tokenColorNames();
    const tailwindNames = new Set(Object.keys(resolved.theme.colors as Record<string, unknown>));

    const missingFromTailwind = [...scssNames].filter((name) => !tailwindNames.has(name));
    const missingFromScss = [...tailwindNames].filter((name) => !scssNames.has(name));

    expect(missingFromTailwind, 'emitted by _tokens.scss but absent from tailwind.config.ts').toEqual([]);
    expect(missingFromScss, 'in tailwind.config.ts but never emitted by _tokens.scss').toEqual([]);
  });
});
