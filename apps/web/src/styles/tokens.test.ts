import path from 'node:path';
import * as sass from 'sass';
import { describe, expect, it } from 'vitest';

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
});
