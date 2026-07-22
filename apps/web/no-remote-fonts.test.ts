import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T6.1.10 — DESIGN.md §3: fonts are self-hosted, never fetched from Google
// at runtime. A `<link>` to fonts.googleapis.com in the head blocks render,
// leaks the visitor's IP to Google on every load, and contradicts the
// public bio page's "no cookies, no third parties" stance. This scans the
// whole of apps/web/src and apps/web/public — source only, not
// node_modules/.next build output — for either Google Fonts host.
const FORBIDDEN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const SCAN_ROOTS = ['src', 'public'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo']);

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

describe('no remote Google Fonts requests', () => {
  it('never references fonts.googleapis.com or fonts.gstatic.com under src/ or public/', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const rootPath = path.resolve(__dirname, root);
      for (const file of collectFiles(rootPath)) {
        // Font binaries themselves aren't text — skip, nothing to grep.
        if (file.endsWith('.woff2') || file.endsWith('.woff') || file.endsWith('.ttf')) {
          continue;
        }
        let content: string;
        try {
          content = readFileSync(file, 'utf-8');
        } catch (error) {
          // A raw ENOENT/EACCES/broken-symlink error from readFileSync
          // doesn't say which of the scan's many files it came from once
          // it surfaces at the top of a CI log — rethrow with that
          // context rather than letting the test crash cryptically.
          throw new Error(`no-remote-fonts.test.ts: could not read ${file}: ${(error as Error).message}`);
        }
        for (const host of FORBIDDEN_HOSTS) {
          if (content.includes(host)) {
            offenders.push(`${file}: references ${host}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
