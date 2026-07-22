import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T6.1.8 — DESIGN.md §3: fonts are self-hosted, never fetched from Google
// at runtime. Space Grotesk (UI) + JetBrains Mono (code/slugs/metrics) —
// no third family. This checks the raw stylesheet text directly (not a
// compiled artifact) since @font-face declarations belong in plain CSS.
const GLOBALS_CSS_PATH = path.resolve(__dirname, 'globals.css');

function readGlobalsCss(): string {
  return readFileSync(GLOBALS_CSS_PATH, 'utf-8');
}

function fontFaceBlocks(css: string): string[] {
  return css.match(/@font-face\s*{[^}]*}/g) ?? [];
}

describe('globals.css @font-face declarations', () => {
  it('declares at least one @font-face rule', () => {
    expect(fontFaceBlocks(readGlobalsCss()).length).toBeGreaterThan(0);
  });

  it('points every src: url(...) at a local /fonts/ path, never a remote host', () => {
    const blocks = fontFaceBlocks(readGlobalsCss());
    for (const block of blocks) {
      const urls = [...block.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]!);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url).toMatch(/^\/fonts\//);
      }
    }
  });

  it('declares exactly two font families — Space Grotesk and JetBrains Mono', () => {
    const blocks = fontFaceBlocks(readGlobalsCss());
    const familyNames = blocks.map((block, index) => {
      const match = /font-family:\s*['"]([^'"]+)['"]/.exec(block)?.[1];
      if (!match) {
        // A `.filter(Boolean)` here would silently drop a malformed
        // @font-face rule (missing font-family entirely) from the count
        // instead of failing — exactly the kind of broken declaration
        // this test exists to catch.
        throw new Error(`fonts.test.ts: @font-face block #${index} has no font-family: ${block}`);
      }
      return match;
    });
    expect(new Set(familyNames)).toEqual(new Set(['Space Grotesk', 'JetBrains Mono']));
  });

  it('sets font-display: swap on every declared face', () => {
    const blocks = fontFaceBlocks(readGlobalsCss());
    for (const block of blocks) {
      expect(block).toMatch(/font-display:\s*swap/);
    }
  });
});
