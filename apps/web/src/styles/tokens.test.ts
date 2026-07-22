import path from 'node:path';
import * as sass from 'sass';
import { describe, expect, it } from 'vitest';
import { relativeLuminance } from './color';

// T6.1.1 — _tokens.scss (POSTA.md §8.1) is the single token source: it
// compiles to plain CSS custom properties, which is what Tailwind and
// runtime theme switching both read. Compiling with the real `sass`
// package (not hand-parsing SCSS) is the point of the test — it proves
// the sheet actually compiles, not just that the source text looks right.
const TOKENS_PATH = path.resolve(__dirname, '_tokens.scss');

function compileTokens(): string {
  return sass.compile(TOKENS_PATH).css;
}

function extractBlock(css: string, selector: string): string {
  const pattern = new RegExp(`${selector.replace('.', '\\.')}\\s*{([^}]*)}`);
  return pattern.exec(css)?.[1] ?? '';
}

function extractValue(block: string, property: string): string {
  const match = new RegExp(`--${property}:\\s*(#[0-9A-Fa-f]{6})`).exec(block);
  if (!match) {
    throw new Error(`tokens.test.ts: --${property} not found in block`);
  }
  return match[1]!;
}

describe('_tokens.scss', () => {
  it('compiles with sass', () => {
    expect(() => compileTokens()).not.toThrow();
  });

  it('emits the dark theme under :root', () => {
    const root = extractBlock(compileTokens(), ':root');
    expect(root).toMatch(/--primary:\s*#B4FF39/);
    expect(root).toMatch(/--bg:\s*#0D1117/);
    expect(root).toMatch(/--surface:\s*#161B22/);
  });

  it('emits the light theme under .light, dropping primary to #3F9142 for AA', () => {
    const light = extractBlock(compileTokens(), '.light');
    expect(light).toMatch(/--primary:\s*#3F9142/);
    expect(light).toMatch(/--ring:\s*#3F9142/);
  });

  it('never renders light-mode cards grayer than the light-mode page (DESIGN.md §1)', () => {
    const light = extractBlock(compileTokens(), '.light');
    const bg = extractValue(light, 'bg');
    const surface = extractValue(light, 'surface');
    expect(relativeLuminance(surface)).toBeGreaterThan(relativeLuminance(bg));
  });

  it('gives the no-humano gray ramp (n1/n2/n3) a different value per theme', () => {
    const css = compileTokens();
    const root = extractBlock(css, ':root');
    const light = extractBlock(css, '.light');
    for (const level of ['n1', 'n2', 'n3']) {
      expect(extractValue(light, level)).not.toBe(extractValue(root, level));
    }
  });

  it('keeps every light-mode gray-ramp swatch off near-black (luminance > 0.35)', () => {
    const light = extractBlock(compileTokens(), '.light');
    for (const level of ['n1', 'n2', 'n3']) {
      expect(relativeLuminance(extractValue(light, level))).toBeGreaterThan(0.35);
    }
  });

  // T6.1.4 — shadcn primitives read --background/--card/--muted-foreground/
  // --destructive/--input; _tokens.scss's canonical names are --bg/--surface/
  // --muted/--error/--border. `sass.compile` only produces static CSS text
  // (no browser, no live var() resolution — jsdom's getComputedStyle can't
  // resolve custom-property var() chains either), so "resolves to the same
  // computed colour in both themes" is asserted at the source level: the
  // shadcn name's declared value must be a var() reference to the Posta
  // name, never a second literal hex. A var() reference is *structurally*
  // guaranteed to track whatever the canonical token resolves to per
  // theme — that's what makes it undriftable, unlike a copied literal.
  it('aliases shadcn token names onto the Posta token set with no second literal', () => {
    const root = extractBlock(compileTokens(), ':root');
    const aliasPairs: Array<[string, string]> = [
      ['background', 'bg'],
      ['card', 'surface'],
      ['muted-foreground', 'muted'],
      ['destructive', 'error'],
      ['input', 'border'],
    ];
    for (const [alias, canonical] of aliasPairs) {
      expect(root).toMatch(new RegExp(`--${alias}:\\s*var\\(--${canonical}\\)`));
    }
  });

  it('never redeclares the shadcn aliases in .light (one definition, no drift)', () => {
    const light = extractBlock(compileTokens(), '.light');
    for (const alias of ['background', 'card', 'muted-foreground', 'destructive', 'input']) {
      expect(light).not.toMatch(new RegExp(`--${alias}:`));
    }
  });
});
