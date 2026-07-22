import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T1.1.10 — replaces "a query without tenant_id fails review" (which no
// CI can run) with a check that does. `forTenant()` (T1.1.9) is the ONE
// legitimate place a tenant-owned table is queried directly; every other
// `db.select|db.update|db.delete` referencing `links`, `bioPages`,
// `bioLinks`, or `domains` anywhere else in apps/ or packages/core/src/ is
// a bypass of the tenant scope, and this test fails naming the offending
// file and line.
//
// *.test.ts files are excluded from the scan on top of tenant.ts itself:
// every schema test in T1.1.4-T1.1.9 legitimately seeds and asserts
// against these tables directly (e.g. auth.test.ts, links.test.ts,
// bio-pages.test.ts) — that is schema verification, not the "all CRUD in
// E2 and E5 goes through forTenant()" claim this check exists to enforce.
// Flagging E1's own test fixtures would defeat the point of the check,
// not strengthen it.
//
// [security review, batch 1] Known blind spots — this is a plain-text
// regex scan, not an AST/type-aware check, so "this test passes" means
// "no violation in the LITERAL shape it looks for", not "no bypass
// exists". Concretely, none of the following are caught today:
//   - An aliased `db` import or destructured method:
//     `import { db as pgDb } from '...'; pgDb.select().from(links)`, or
//     `const { select } = db; select().from(links)`.
//   - An aliased table import: `import { links as tenantLinks } from
//     '../schema/links'; db.select().from(tenantLinks)`.
//   - A table reference stored in an intermediate variable:
//     `const table = links; db.select().from(table)`.
//   - Drizzle's relational query API: `db.query.links.findMany(...)` /
//     `.findFirst(...)` never take the `db.select().from(<table>)` /
//     `db.update(<table>)` / `db.delete(<table>)` shape these patterns
//     look for.
//   - Raw SQL execution: `db.execute(sql\`SELECT * FROM links ...\`)`.
// This is still a genuinely useful defense-in-depth CI gate for the
// straightforward, by-far-most-common bypass shape (someone forgets
// forTenant() exists and writes the obvious `db.select().from(links)`),
// and its own synthetic-fixture suite below proves it fires for that
// shape. Migrating to an AST-based check (ts-morph, or a custom ESLint
// rule with type information, which could resolve imports/aliases and
// also reach db.query.*/db.execute) would close these gaps; out of scope
// for T1.1.10's own acceptance criterion, recorded here so "the scanner
// passed" is never misread as "no bypass exists".

const TENANT_TABLE_IDENTIFIERS = ['links', 'bioPages', 'bioLinks', 'domains'] as const;

type TenantQueryMethod = 'select' | 'update' | 'delete';

interface TenantScopeViolation {
  readonly file: string;
  readonly line: number;
  readonly table: string;
  readonly method: TenantQueryMethod;
}

const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.next', '.turbo', '.git', 'coverage']);

const TENANT_HELPER_PATH = path.join('packages', 'core', 'src', 'db', 'tenant.ts');

function isExcludedFile(relativePath: string): boolean {
  if (relativePath === TENANT_HELPER_PATH) return true;
  if (relativePath.endsWith('.test.ts')) return true;
  return false;
}

/**
 * Builds the three query-method patterns (select/update/delete) against
 * the tenant-owned table identifiers. `\s` matches newlines too, so a
 * chain written across several lines (`db\n.select()\n.from(links)`) is
 * still caught, not just a single-line form — the parenthesized table
 * argument must be EXACTLY one of TENANT_TABLE_IDENTIFIERS (nothing else
 * between the parens), so an unrelated identifier like `linksRepo` never
 * false-positives.
 */
function buildPatterns(): ReadonlyArray<{ method: TenantQueryMethod; regex: RegExp }> {
  const tableAlternation = TENANT_TABLE_IDENTIFIERS.join('|');

  return [
    {
      method: 'select',
      regex: new RegExp(
        `db\\s*\\.\\s*select\\s*\\([^)]*\\)\\s*\\.\\s*from\\s*\\(\\s*(${tableAlternation})\\s*\\)`,
        'g',
      ),
    },
    {
      method: 'update',
      regex: new RegExp(`db\\s*\\.\\s*update\\s*\\(\\s*(${tableAlternation})\\s*\\)`, 'g'),
    },
    {
      method: 'delete',
      regex: new RegExp(`db\\s*\\.\\s*delete\\s*\\(\\s*(${tableAlternation})\\s*\\)`, 'g'),
    },
  ];
}

/**
 * Walks `scanRoots` (relative to `rootDir`) looking for a direct
 * `db.select|update|delete` referencing a tenant-owned table outside
 * tenant.ts. Pure and side-effect-free beyond reading the filesystem, so
 * it can be pointed at either the real repo tree or a synthetic temp
 * directory built just for a test — same shape as
 * tests/conventions/no-literal-domain.test.ts's scanForLiteralDomains.
 */
function findTenantScopeViolations(
  rootDir: string,
  scanRoots: readonly string[],
): TenantScopeViolation[] {
  const violations: TenantScopeViolation[] = [];
  const patterns = buildPatterns();

  function scanFile(fullPath: string): void {
    const relativePath = path.relative(rootDir, fullPath);
    if (!relativePath.endsWith('.ts')) return;
    if (isExcludedFile(relativePath)) return;

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch (error: unknown) {
      // An unreadable file (permissions, I/O) must fail loudly, naming
      // the file — silently skipping it would report a false-clean scan
      // over a subtree that was never actually checked.
      throw new Error(
        `Failed to read file "${relativePath}" while scanning for tenant-scope ` +
          `violations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const { method, regex } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length;
        violations.push({ file: relativePath, line, table: match[1] ?? '', method });
      }
    }
  }

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      // Only a missing directory (ENOENT — e.g. apps/ not created yet) is
      // benign. Anything else must fail loudly: silently treating every
      // readdirSync error as "empty" would let an unreadable subtree
      // report as a clean scan instead of the false negative it is.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;

      throw new Error(
        `Failed to read directory "${dir}" while scanning for tenant-scope ` +
          `violations: ${error instanceof Error ? error.message : String(error)}`,
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

  return violations;
}

const SCAN_ROOTS = ['apps', 'packages/core/src'] as const;

describe('no direct tenant-table access outside the tenant helper (T1.1.10)', () => {
  it('passes on the current tree', () => {
    const violations = findTenantScopeViolations(process.cwd(), SCAN_ROOTS);

    expect(violations).toEqual([]);
  });
});

describe('findTenantScopeViolations detection (synthetic fixtures, never committed)', () => {
  function withTempScanRoot(run: (tmpRoot: string) => void): void {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'posta-tenant-scope-'));
    try {
      run(tmpRoot);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it('fails, naming the file and line, for a direct db.select().from(links)', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'links.service.ts'),
        'export function bad() {\n  return db.select().from(links);\n}\n',
      );

      const violations = findTenantScopeViolations(tmpRoot, SCAN_ROOTS);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: path.join('apps', 'api', 'src', 'links.service.ts'),
        line: 2,
        table: 'links',
        method: 'select',
      });
    });
  });

  it('also catches a chain split across multiple lines', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'worker', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'bad.ts'),
        'db\n  .select()\n  .from(bioPages);\n',
      );

      const violations = findTenantScopeViolations(tmpRoot, SCAN_ROOTS);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ table: 'bioPages', method: 'select', line: 1 });
    });
  });

  it('flags db.update(bioLinks) and db.delete(domains) too', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'bad.ts'),
        'db.update(bioLinks).set({ position: 1 });\ndb.delete(domains);\n',
      );

      const violations = findTenantScopeViolations(tmpRoot, SCAN_ROOTS);

      expect(violations.map((violation) => violation.method)).toEqual(['update', 'delete']);
      expect(violations.map((violation) => violation.table)).toEqual(['bioLinks', 'domains']);
    });
  });

  it('does not flag packages/core/src/db/tenant.ts itself', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'packages', 'core', 'src', 'db');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'tenant.ts'), 'db.select().from(links);\n');

      expect(findTenantScopeViolations(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a *.test.ts file — schema tests legitimately seed/assert directly', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'packages', 'core', 'src', 'schema');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'links.test.ts'), 'db.select().from(links);\n');

      expect(findTenantScopeViolations(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag db.select().from(user) — auth-owned, not tenant-owned', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'auth.service.ts'), 'db.select().from(user);\n');

      expect(findTenantScopeViolations(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a similarly-named identifier like linksRepo', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'ok.ts'), 'db.update(linksRepo);\n');

      expect(findTenantScopeViolations(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('reports every violation, not just the first', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'bad.ts'),
        'db.select().from(links);\nconst x = 1;\ndb.select().from(domains);\n',
      );

      const violations = findTenantScopeViolations(tmpRoot, SCAN_ROOTS);

      expect(violations.map((violation) => violation.line)).toEqual([1, 3]);
    });
  });

  it('does not silently swallow a non-ENOENT directory read error', () => {
    withTempScanRoot((tmpRoot) => {
      // "apps" exists but is a plain file, not a directory — readdirSync
      // throws ENOTDIR, not ENOENT. A catch-all here would make an
      // unreadable real apps/ or packages/core/src subtree (permissions,
      // I/O) report as a false-clean scan instead of failing loudly.
      writeFileSync(path.join(tmpRoot, 'apps'), 'not a directory\n');

      expect(() => findTenantScopeViolations(tmpRoot, SCAN_ROOTS)).toThrow();
    });
  });
});
