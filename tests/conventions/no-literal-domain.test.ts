import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// T0.3.9 — CLAUDE.md: "No literal domain may appear in code — a grep
// test enforces it, which is what keeps a fallback domain a config
// change." T0.3.3's makeUrlBuilders() (packages/contracts/src/domain.ts)
// is the only place meant to assemble a host from POSTA_LINK_DOMAIN;
// this test is what makes that true rather than aspirational.
//
// A prior story in this epic shipped a "guard" test that only exercised
// the easy, already-passing case and never proved the guard actually
// fires on a real violation. Both halves are made real and automated
// here:
//   1. "passes clean" — scans the repo's real apps/ and packages/ tree
//      and asserts zero hits.
//   2. "fails when a literal is planted" — plants a real file
//      containing a forbidden domain in a throwaway OS temp directory
//      (never inside the repo, never committed) and asserts
//      scanForLiteralDomains finds it. This is a permanent, repeatable
//      proof the detector works, not a one-off manual demonstration —
//      though the manual demonstration (plant inside the real repo tree,
//      observe `pnpm test tests/conventions` go red, remove the plant)
//      was also performed once; see the batch report for the pasted
//      failing output.

const FORBIDDEN_DOMAINS = ['posta.lat', 'lbt.works'] as const;

// Directory roots to walk recursively. Started as apps/ and packages/ per
// the plan text (T0.3.9); widened (final-review fixup, S0.5 batch) to also
// cover CI/infra config — a future posta.lat literal in a workflow or
// compose file would otherwise slip straight past this guard, and CI is
// exactly where the "swap the fallback domain" scenario CLAUDE.md
// describes would actually need to work. Neither addition currently
// contains anything to catch (CI uses posta.test, service names, and env
// vars) — confirmed clean before and after this widening.
//
// This also structurally excludes this very file, README.md, and any
// other repo-root file not listed here (it necessarily contains the
// forbidden strings above) — no special-case exclusion needed for any of
// them.
const SCAN_ROOTS = ['apps', 'packages', '.github/workflows', 'scripts', 'docker'] as const;

// Individual repo-root FILES to scan directly (not directories — see
// scanFile below). docker-compose.yml is the one config file that lives
// at the repo root rather than under a directory already covered above.
const SCAN_FILES = ['docker-compose.yml'] as const;

const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'coverage',
]);

// Extensions/suffixes allowed to mention a domain literally even inside
// apps/packages (defense in depth — none of these currently exist under
// apps/packages, but a future per-app README.md or .env.example should
// not trip this test).
function isExcludedFile(relativePath: string): boolean {
  if (relativePath.endsWith('.env.example')) return true;
  if (relativePath.endsWith('.md')) return true;
  if (relativePath.endsWith('.tsbuildinfo')) return true;
  const segments = relativePath.split(path.sep);
  return segments.includes('docs');
}

interface DomainLiteralHit {
  readonly file: string;
  readonly line: number;
  readonly domain: string;
}

/**
 * Walks `scanRoots` (directories, relative to `rootDir`) and separately
 * scans each of `scanFiles` (individual files, relative to `rootDir`),
 * reporting every line containing one of FORBIDDEN_DOMAINS and skipping
 * excluded directories and files. Pure and side-effect-free beyond reading
 * the filesystem, so it can be pointed at either the real repo tree or a
 * synthetic temp directory built just for a test.
 *
 * `scanFiles` defaults to an empty array deliberately: every existing
 * synthetic-fixture test below calls this with only two arguments (a
 * directory-only scan), so adding file-root support here must never change
 * their behavior — including the ENOTDIR fixture, which relies on `apps`
 * being read as a directory that turns out to be a file being a genuine
 * error, not a legitimate file-scan-root case.
 */
function scanForLiteralDomains(
  rootDir: string,
  scanRoots: readonly string[],
  scanFiles: readonly string[] = [],
): DomainLiteralHit[] {
  const hits: DomainLiteralHit[] = [];

  /** Scans one FILE's content directly — shared by `walk`'s per-entry file
   * case and the top-level `scanFiles` loop below, so both paths report
   * hits identically. */
  function scanFile(fullPath: string): void {
    const relativePath = path.relative(rootDir, fullPath);
    if (isExcludedFile(relativePath)) return;

    const content = readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      for (const domain of FORBIDDEN_DOMAINS) {
        if (line.includes(domain)) {
          hits.push({ file: relativePath, line: index + 1, domain });
        }
      }
    });
  }

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      // Only a missing directory (ENOENT — e.g. a fresh checkout with
      // no apps/ yet) is a benign "nothing to scan here". Anything else
      // (permissions, I/O, a path that isn't a directory) must fail
      // loudly: silently treating every readdirSync error as "empty"
      // would let an unreadable apps/ or packages/ subtree report as a
      // clean scan instead of the false negative it actually is.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;

      throw new Error(
        `Failed to read directory "${dir}" while scanning for literal ` +
          `domains: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      scanFile(fullPath);
    }
  }

  for (const root of scanRoots) {
    walk(path.join(rootDir, root));
  }

  for (const file of scanFiles) {
    const fullPath = path.join(rootDir, file);
    try {
      scanFile(fullPath);
    } catch (error: unknown) {
      // Mirrors walk()'s own ENOENT tolerance: a listed file-scan-root
      // that doesn't exist (e.g. a future rename of docker-compose.yml)
      // is benign, anything else fails loudly rather than reporting a
      // false-clean scan.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;

      throw new Error(
        `Failed to read file "${fullPath}" while scanning for literal ` +
          `domains: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return hits;
}

describe('no literal domain in apps/, packages/, or CI/infra config', () => {
  it(`finds no ${FORBIDDEN_DOMAINS.join(' or ')} literal in the real source tree`, () => {
    const hits = scanForLiteralDomains(process.cwd(), SCAN_ROOTS, SCAN_FILES);

    expect(hits).toEqual([]);
  });
});

describe('scanForLiteralDomains detection (synthetic fixtures, never committed)', () => {
  function withTempScanRoot(
    run: (tmpRoot: string) => void,
  ): void {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'posta-literal-domain-'));
    try {
      run(tmpRoot);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it('detects a planted posta.lat literal inside packages/', () => {
    withTempScanRoot((tmpRoot) => {
      const pkgSrc = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
      mkdirSync(pkgSrc, { recursive: true });
      writeFileSync(path.join(pkgSrc, 'bad.ts'), "export const domain = 'posta.lat';\n");

      const hits = scanForLiteralDomains(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        domain: 'posta.lat',
        line: 1,
        file: path.join('packages', 'fixture-pkg', 'src', 'bad.ts'),
      });
    });
  });

  it('detects a planted lbt.works literal inside apps/', () => {
    withTempScanRoot((tmpRoot) => {
      const appSrc = path.join(tmpRoot, 'apps', 'fixture-app', 'src');
      mkdirSync(appSrc, { recursive: true });
      writeFileSync(path.join(appSrc, 'bad.ts'), "// old brand host: lbt.works\n");

      const hits = scanForLiteralDomains(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]?.domain).toBe('lbt.works');
    });
  });

  it('reports every offending line, not just the first', () => {
    withTempScanRoot((tmpRoot) => {
      const pkgSrc = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
      mkdirSync(pkgSrc, { recursive: true });
      writeFileSync(
        path.join(pkgSrc, 'bad.ts'),
        "const a = 'posta.lat';\nconst b = 1;\nconst c = 'lbt.works';\n",
      );

      const hits = scanForLiteralDomains(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(2);
      expect(hits.map((hit) => hit.line)).toEqual([1, 3]);
    });
  });

  it('does not flag a planted literal inside .env.example', () => {
    withTempScanRoot((tmpRoot) => {
      const pkgDir = path.join(tmpRoot, 'packages', 'fixture-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(path.join(pkgDir, '.env.example'), 'POSTA_LINK_DOMAIN=posta.lat\n');

      expect(scanForLiteralDomains(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a planted literal inside a docs/ directory', () => {
    withTempScanRoot((tmpRoot) => {
      const docsDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(path.join(docsDir, 'notes.ts'), "// posta.lat\n");

      expect(scanForLiteralDomains(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a planted literal inside a *.md file', () => {
    withTempScanRoot((tmpRoot) => {
      const pkgDir = path.join(tmpRoot, 'packages', 'fixture-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(path.join(pkgDir, 'README.md'), 'See posta.lat for details.\n');

      expect(scanForLiteralDomains(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a planted literal inside node_modules or dist', () => {
    withTempScanRoot((tmpRoot) => {
      const nodeModulesDir = path.join(
        tmpRoot,
        'packages',
        'fixture-pkg',
        'node_modules',
        'some-dep',
      );
      const distDir = path.join(tmpRoot, 'packages', 'fixture-pkg', 'dist');
      mkdirSync(nodeModulesDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });
      writeFileSync(path.join(nodeModulesDir, 'index.js'), "'posta.lat'\n");
      writeFileSync(path.join(distDir, 'index.js'), "'posta.lat'\n");

      expect(scanForLiteralDomains(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a clean fixture with no forbidden domain', () => {
    withTempScanRoot((tmpRoot) => {
      const pkgSrc = path.join(tmpRoot, 'packages', 'fixture-pkg', 'src');
      mkdirSync(pkgSrc, { recursive: true });
      writeFileSync(
        path.join(pkgSrc, 'good.ts'),
        "export const domain = 'example.test'; // not posta dot lat\n",
      );

      expect(scanForLiteralDomains(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not silently swallow a non-ENOENT directory read error', () => {
    withTempScanRoot((tmpRoot) => {
      // "apps" exists but is a plain file, not a directory —
      // readdirSync on it throws ENOTDIR, not ENOENT. A catch-all here
      // would make an unreadable real apps/ or packages/ subtree
      // (permissions, I/O) report as a false-clean scan instead of
      // failing loudly. ENOTDIR is used (rather than a chmod'd
      // permission error) because it is deterministic and portable —
      // permission bits are ignored when tests run as root, which a
      // permission-based fixture would silently pass under.
      writeFileSync(path.join(tmpRoot, 'apps'), 'not a directory\n');

      expect(() => scanForLiteralDomains(tmpRoot, SCAN_ROOTS)).toThrow();
    });
  });
});
