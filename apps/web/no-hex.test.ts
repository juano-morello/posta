import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T6.1.13 — POSTA.md §8: "do not hardcode hex in components; read var(--*)."
// _tokens.scss is the ONLY place a hex literal may live (plus the vendored
// font files, which aren't text this scans anyway). A component hardcoding
// e.g. dark lime (#B4FF39) breaks AA silently the moment light mode drops
// primary to #3F9142 — this is a gate, not a style-tidiness lint.
const SCAN_DIRS = ['src/components', 'src/app'];
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.css', '.scss'];
const HEX_PATTERN = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

function collectFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    // Only "directory doesn't exist yet" (e.g. src/components before
    // S6.2) is a non-failure. Anything else — permission denied, a
    // broken symlink, a genuine filesystem error — must NOT be silently
    // treated the same way: that would let a real infrastructure problem
    // masquerade as "nothing to scan yet" and pass the gate for the
    // wrong reason.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (SCAN_EXTENSIONS.includes(path.extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('no hex literals in component files', () => {
  it('never hardcodes a hex color under src/components/** or src/app/**', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      const rootPath = path.resolve(__dirname, dir);
      for (const file of collectFiles(rootPath)) {
        if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
          continue;
        }
        const content = readFileSync(file, 'utf-8');
        const matches = content.match(HEX_PATTERN);
        if (matches) {
          offenders.push(`${file}: ${matches.join(', ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
