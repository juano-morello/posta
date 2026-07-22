import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T6.2.1 — shadcn/ui's CLI normally generates its own `:root { --background:
// ...; ... }` colour block in globals.css. That would be a SECOND
// definition of tokens _tokens.scss already emits (T6.1.1-T6.1.4) — the
// exact drift T6.1.7's test exists to prevent. components.json is
// hand-configured (not run through the interactive CLI) so it points at
// our existing token pipeline instead of writing a new one.
const WEB_ROOT = path.resolve(__dirname, '.');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(WEB_ROOT, relativePath), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('components.json', () => {
  it('points its aliases at the canonical apps/web/src paths', () => {
    const config = readJson('components.json');
    const aliases = config.aliases as Record<string, string>;
    expect(aliases.components).toBe('@/components');
    expect(aliases.ui).toBe('@/components/ui');
    expect(aliases.utils).toBe('@/lib/utils');
    expect(aliases.lib).toBe('@/lib');
    expect(aliases.hooks).toBe('@/hooks');

    // Cross-checked against tsconfig.json's own "@/*" -> "./src/*" path
    // mapping, so this test fails if the two ever disagree.
    const tsconfig = readJson('tsconfig.json');
    const paths = (tsconfig.compilerOptions as Record<string, unknown>).paths as Record<
      string,
      string[]
    >;
    expect(paths['@/*']).toEqual(['./src/*']);
  });

  it('points at the existing Tailwind config and globals.css, not a fresh pair', () => {
    const config = readJson('components.json');
    const tailwind = config.tailwind as Record<string, unknown>;
    expect(tailwind.config).toBe('tailwind.config.ts');
    expect(tailwind.css).toBe('src/styles/globals.css');
    expect(tailwind.cssVariables).toBe(true);
    // baseColor is required by the schema but is only consulted the
    // moment a component generator writes its OWN palette — since
    // globals.css already defines every CSS variable shadcn expects
    // (T6.1.4's aliases), it never actually gets consulted here.
    expect(typeof tailwind.baseColor).toBe('string');
  });

  it('never let init add a second :root colour block to globals.css', () => {
    const globalsCss = readFileSync(path.join(WEB_ROOT, 'src/styles/globals.css'), 'utf-8');
    const rootBlockCount = (globalsCss.match(/:root\s*{/g) ?? []).length;
    expect(rootBlockCount).toBe(0);
  });
});
