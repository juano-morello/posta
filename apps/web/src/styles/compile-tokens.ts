import path from 'node:path';
import * as sass from 'sass';

// Shared by every test that needs to inspect the compiled _tokens.scss
// output (tokens.test.ts, tailwind-tokens.test.ts, contrast.test.ts) —
// extracted once the third consumer needed the same parsing so the four
// of them stop hand-rolling their own regexes.
const TOKENS_PATH = path.resolve(__dirname, '_tokens.scss');

export function compileTokensCss(): string {
  return sass.compile(TOKENS_PATH).css;
}

export function extractBlock(css: string, selector: string): string {
  const pattern = new RegExp(`${selector.replace('.', '\\.')}\\s*{([^}]*)}`);
  const match = pattern.exec(css)?.[1];
  if (match === undefined) {
    // Silently falling back to '' here would surface, three layers away,
    // as a confusing "--primary not found in block" from extractValue —
    // hiding the real problem (the selector itself never emitted) behind
    // an error about the wrong thing.
    throw new Error(`compile-tokens.ts: selector "${selector}" not found in compiled CSS`);
  }
  return match;
}

export function extractValue(block: string, property: string): string {
  const match = new RegExp(`--${property}:\\s*(#[0-9A-Fa-f]{6})`).exec(block);
  if (!match) {
    throw new Error(`compile-tokens.ts: --${property} not found in block`);
  }
  return match[1]!;
}
