import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// T4.2.1 [E4, S4.2][INV-5] — "advice, not enforcement": the classification
// verdict is a read-time SQL view (events_classified, T4.1.1's own
// packages/core/migrations/sql/006_events_classified.sql), never a column on
// `events` itself. This test is the grep-style CI gate that fails a PR the
// moment new code reaches past that view to query or write the raw
// partitioned `events` table directly — the actual DB-level wall (revoking
// SELECT on `events` from the application role) is a SEPARATE, later task
// (T4.2.2); this one is a static scan over source text, same tier as
// tests/conventions/no-literal-domain.test.ts and
// packages/core/src/db/tenant-scope.test.ts (T1.1.10), whose shape this
// file borrows directly: walk the real tree looking for a small set of
// literal patterns, exclude a short, explicit allowlist, and prove the
// detector itself fires against a synthetic fixture rather than just
// asserting the easy already-passing case.
//
// THREE PATTERNS, per the task text:
//   - `from(events)`  — Drizzle's query-builder `.from(events)` call
//     (case-sensitive: Drizzle's own method name is always lowercase
//     `from`, never `From`/`FROM`).
//   - `FROM events`   — a raw SQL SELECT reading the table directly.
//   - `INTO events`   — a raw SQL INSERT writing the table directly.
// The latter two are matched case-INSENSITIVELY: checked directly against
// this repo before writing the regexes (`grep -rniE "from\s+events|into\s+
// events" --include="*.ts" apps packages/core/src`) — every real SQL
// occurrence today spells the keyword uppercase (`FROM events` /
// `INSERT INTO events`, e.g. packages/core/migrations/sql/001_events.down
// .sql, 006_events_classified.sql), so a case-sensitive check would pass
// today by accident; case-insensitive is what actually holds if someone
// later writes lower-cased raw SQL, which is legal Postgres and
// indistinguishable from a bypass either way.
//
// WORD-BOUNDARY MATTERS: `\bevents\b` deliberately does NOT match
// `events_classified` — Postgres/JS both treat `_` as a word character, so
// "FROM events_classified" has no boundary between `events` and
// `_classified`; they're one token. Confirmed this is load-bearing:
// events-classified.test.ts (T4.1.1) itself reads the view by name
// (`SELECT ... FROM events_classified ...`), and a boundary-less scan would
// wrongly flag that legitimate read as a raw-`events` violation.
//
// THE THREE ALLOWED PATHS — found by grep, not guessed (the task's own
// example paths, `apps/worker/src/batch/batch-insert.ts` and
// `packages/core/src/replay/`, do not exist in this tree):
//   1. packages/core/migrations/sql/ — the hand-written SQL migrations
//      (001_events.sql defines the table, 006_events_classified.sql
//      defines the view). These are .sql files, not .ts, so — as the task
//      text itself anticipates — this exclusion is structurally moot for a
//      .ts-only scan rooted at packages/core/src and apps: that directory
//      sits at packages/core/migrations/, a SIBLING of packages/core/src,
//      never inside either scanned root. Kept anyway, defensively, exactly
//      as instructed, so a future widening of SCAN_ROOTS doesn't silently
//      start flagging the migrations themselves.
//   2. packages/core/src/db/events.ts — T3.3.2's insertEventsBatch /
//      insertEventsBatchWithCounts, the ONE call site anywhere in the
//      codebase that ever builds `.insert(events)...onConflictDoNothing(
//      ...)` (that file's own header says so directly). This is the
//      function apps/worker/src/batch/flush.ts's flushBatch calls for
//      every live batch flush — i.e. "the worker's batch insert path" the
//      task asks for, found by grepping for T3.3.2 and confirming flush.ts
//      imports insertEventsBatch from here rather than querying `events`
//      itself.
//   3. apps/worker/src/cli/replay-driver.ts — T3.6.2's replay insert path:
//      replayEventLog reads the R2 NDJSON log back out and calls this same
//      insertEventsBatch (never a second, drifting INSERT implementation —
//      that file's own header says so too) to re-insert historical events.
//      Found the same way: grepping for T3.6.2 and for callers of
//      insertEventsBatch outside events.ts itself.
//
// *.test.ts FILES ARE ALSO EXCLUDED, on top of those three — same
// precedent tenant-scope.test.ts (T1.1.10) already set for the sibling
// tenant-scope guard: dozens of files across apps/worker/src/{test,cli,
// batch,consumer}/**/*.test.ts and packages/core/src/db/*.test.ts
// legitimately query `SELECT ... FROM events ...` / `INSERT INTO events
// (...)` directly — that IS the seeding/assertion mechanism proving
// partitioning, idempotency (INV-8), and the classification view (INV-5)
// itself actually work; T4.1.1's own events-classified.test.ts is one of
// them. Flagging that would not strengthen this invariant, it would just
// break the test suite that proves it holds. Confirmed via a real grep
// before writing this file: every `FROM events`/`INTO events` match in the
// current tree outside the three allowed paths above sits inside a
// `*.test.ts` file.
//
// KNOWN BLIND SPOTS (same honesty tenant-scope.test.ts's own header
// insists on) — this is a plain-text regex scan, not an AST/type-aware
// check:
//   - An aliased import (`import { events as rawEvents } from '../schema/
//     events'; db.select().from(rawEvents)`) is invisible to a literal
//     `from(events)` match.
//   - Drizzle's relational query API (`db.query.events.findMany(...)`)
//     never produces the `.from(events)` shape this scan looks for.
//   - `db.execute(sql\`...\`)` built from a template whose literal text
//     doesn't spell "FROM events"/"INTO events" verbatim (e.g. an
//     interpolated table name) would slip past.
// This is still a genuinely useful, cheap CI gate for the by-far-most-
// common shape a bypass would actually take, and is explicitly "advice,
// not enforcement" per the task text — the DB-level wall in T4.2.2 is what
// closes these gaps for real.

const WORKER_BATCH_INSERT_PATH = path.join('packages', 'core', 'src', 'db', 'events.ts');
const REPLAY_INSERT_PATH = path.join('apps', 'worker', 'src', 'cli', 'replay-driver.ts');
const MIGRATIONS_SQL_DIR = path.join('packages', 'core', 'migrations', 'sql');

const SCAN_ROOTS = ['apps', 'packages/core/src'] as const;

const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.next', '.turbo', '.git', 'coverage']);

interface RawEventsAccessPattern {
  readonly label: string;
  readonly regex: RegExp;
}

// `g` flag on every pattern: scanFile below reuses each RegExp across many
// files via a `while (regex.exec(content))` loop and resets `lastIndex` to 0
// before each file, exactly like tenant-scope.test.ts's own buildPatterns().
const PATTERNS: readonly RawEventsAccessPattern[] = [
  {
    label: 'from(events)',
    // Drizzle query-builder syntax: `.from(events)`. `\s` inside the parens
    // matches newlines too, so a chain split across lines
    // (`db\n.select()\n.from(events)`) is still caught. Case-sensitive —
    // Drizzle's own method name is always lowercase.
    regex: /\bfrom\s*\(\s*events\s*\)/g,
  },
  {
    label: 'FROM events',
    // Raw SQL SELECT ... FROM events — case-insensitive (see header).
    // `\bevents\b` does not match `events_classified` (see header).
    regex: /\bfrom\s+events\b/gi,
  },
  {
    label: 'INTO events',
    // Raw SQL INSERT INTO events — case-insensitive, same reasoning.
    regex: /\binto\s+events\b/gi,
  },
];

interface RawEventsAccessHit {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
}

/**
 * `relativePath` is already POSIX-joined via `path.relative`/`path.join`
 * against `rootDir`, matching the OS path separator — the three constants
 * above are built with `path.join` for exactly this reason, mirroring
 * tenant-scope.test.ts's own `TENANT_HELPER_PATH`.
 */
function isExcludedFile(relativePath: string): boolean {
  if (relativePath.endsWith('.test.ts')) return true;
  if (relativePath === WORKER_BATCH_INSERT_PATH) return true;
  if (relativePath === REPLAY_INSERT_PATH) return true;
  if (relativePath.startsWith(MIGRATIONS_SQL_DIR + path.sep)) return true;
  return false;
}

/**
 * Walks `scanRoots` (relative to `rootDir`) looking for any of PATTERNS
 * outside the allowlist in `isExcludedFile`. Pure and side-effect-free
 * beyond reading the filesystem, so it can be pointed at either the real
 * repo tree or a synthetic temp directory built just for a test — same
 * shape as tenant-scope.test.ts's findTenantScopeViolations and
 * no-literal-domain.test.ts's scanForLiteralDomains.
 */
function findRawEventsAccess(rootDir: string, scanRoots: readonly string[]): RawEventsAccessHit[] {
  const hits: RawEventsAccessHit[] = [];

  function scanFile(fullPath: string): void {
    const relativePath = path.relative(rootDir, fullPath);
    if (!relativePath.endsWith('.ts')) return;
    if (isExcludedFile(relativePath)) return;

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch (error: unknown) {
      // An unreadable file (permissions, I/O) must fail loudly, naming the
      // file — silently skipping it would report a false-clean scan over a
      // subtree that was never actually checked.
      throw new Error(
        `Failed to read file "${relativePath}" while scanning for raw \`events\` table ` +
          `access: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const { label, regex } of PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length;
        hits.push({ file: relativePath, line, pattern: label });
      }
    }
  }

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      // Only a missing directory (ENOENT — e.g. apps/ not created yet in a
      // synthetic fixture) is a benign "nothing to scan here". Anything
      // else must fail loudly: silently treating every readdirSync error
      // as empty would let an unreadable subtree report as a clean scan
      // instead of the false negative it actually is.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;

      throw new Error(
        `Failed to read directory "${dir}" while scanning for raw \`events\` table access: ` +
          `${error instanceof Error ? error.message : String(error)}`,
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

  return hits;
}

function formatHits(hits: readonly RawEventsAccessHit[]): string {
  return hits.map((hit) => `${hit.file}:${hit.line} — matched "${hit.pattern}"`).join('\n');
}

describe('no raw `events` table access outside the classification view, the worker batch insert, and the replay insert (T4.2.1, INV-5)', () => {
  it('finds no from(events)/FROM events/INTO events outside the three allowed paths, scanning the real tree', () => {
    const hits = findRawEventsAccess(process.cwd(), SCAN_ROOTS);

    if (hits.length > 0) {
      expect.fail(
        'Found raw `events` table access outside the classification view (invariant 5 — ' +
          `query events_classified instead), the worker's batch insert (${WORKER_BATCH_INSERT_PATH}), ` +
          `and the replay insert (${REPLAY_INSERT_PATH}):\n${formatHits(hits)}`,
      );
    }

    expect(hits).toEqual([]);
  });
});

describe('findRawEventsAccess detection (synthetic fixtures, never committed)', () => {
  function withTempScanRoot(run: (tmpRoot: string) => void): void {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'posta-no-raw-events-'));
    try {
      run(tmpRoot);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  it('fails, naming the exact file and line, for a Drizzle db.select().from(events) outside the allowed paths', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src', 'analytics');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'leaky-query.service.ts'),
        'export function bad() {\n  return db.select().from(events);\n}\n',
      );

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        file: path.join('apps', 'api', 'src', 'analytics', 'leaky-query.service.ts'),
        line: 2,
        pattern: 'from(events)',
      });

      const message = formatHits(hits);
      expect(message).toContain(path.join('apps', 'api', 'src', 'analytics', 'leaky-query.service.ts') + ':2');
    });
  });

  it('also catches a from(events) chain split across multiple lines, reporting the line the "from(" token itself sits on', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'worker', 'src', 'somewhere');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'bad.ts'), 'db\n  .select()\n  .from(events);\n');

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ pattern: 'from(events)', line: 3 });
    });
  });

  it('flags a raw SQL SELECT ... FROM events outside the allowed paths', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'packages', 'core', 'src', 'analytics');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'leaky-report.ts'),
        "export const q = 'SELECT event_id FROM events WHERE tenant_id = $1';\n",
      );

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ pattern: 'FROM events', line: 1 });
    });
  });

  it('flags a raw SQL FROM events even lower-cased', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'packages', 'core', 'src', 'analytics');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'leaky-report.ts'), "export const q = 'select 1 from events';\n");

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ pattern: 'FROM events', line: 1 });
    });
  });

  it('flags a raw SQL INSERT INTO events outside the allowed paths', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src', 'somewhere');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'leaky-write.ts'),
        "export const q = 'INSERT INTO events (event_id) VALUES ($1)';\n",
      );

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ pattern: 'INTO events', line: 1 });
    });
  });

  it('flags a raw SQL into events even lower-cased', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src', 'somewhere');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'leaky-write.ts'), "export const q = 'insert into events (event_id) values ($1)';\n");

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ pattern: 'INTO events', line: 1 });
    });
  });

  it('does NOT match FROM events_classified — word boundary keeps the classification view legitimate', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'packages', 'core', 'src', 'analytics');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'good-report.ts'),
        "export const q = 'SELECT classification FROM events_classified WHERE event_id = $1';\n",
      );

      expect(findRawEventsAccess(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag the worker batch insert file itself (packages/core/src/db/events.ts)', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'packages', 'core', 'src', 'db');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'events.ts'),
        'db.insert(events).values(rows).onConflictDoNothing();\n// INSERT INTO events (...) VALUES (...)\n',
      );

      expect(findRawEventsAccess(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag the replay insert path itself (apps/worker/src/cli/replay-driver.ts)', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'worker', 'src', 'cli');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'replay-driver.ts'),
        'await insertEventsBatch(db, buffer); // db.select().from(events) style comment, still allowed here\n',
      );

      expect(findRawEventsAccess(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a .ts file under packages/core/migrations/sql/, even if that root is ever scanned (defensive)', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'packages', 'core', 'migrations', 'sql');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'run-migration.ts'), "sql`INSERT INTO events (...) VALUES (...)`;\n");

      const widenedRoots = [...SCAN_ROOTS, 'packages/core/migrations/sql'];

      expect(findRawEventsAccess(tmpRoot, widenedRoots)).toEqual([]);
    });
  });

  it('does not flag a *.test.ts file — the integration suite legitimately seeds/asserts against events directly', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'worker', 'src', 'batch');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'flush.test.ts'),
        "await pg.pool.query('SELECT event_id FROM events WHERE tenant_id = $1', [tenantId]);\n",
      );

      expect(findRawEventsAccess(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('does not flag a clean fixture with no events table access at all', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'ok.ts'), "export const q = db.select().from(links);\n");

      expect(findRawEventsAccess(tmpRoot, SCAN_ROOTS)).toEqual([]);
    });
  });

  it('reports every violation in a file, not just the first', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'bad.ts'),
        "db.select().from(events);\nconst x = 1;\ndb.execute(sql`SELECT * FROM events`);\n",
      );

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);

      expect(hits.map((hit) => hit.line)).toEqual([1, 3]);
      expect(hits.map((hit) => hit.pattern)).toEqual(['from(events)', 'FROM events']);
    });
  });

  it('does not silently swallow a non-ENOENT directory read error', () => {
    withTempScanRoot((tmpRoot) => {
      // "apps" exists but is a plain file, not a directory — readdirSync
      // throws ENOTDIR, not ENOENT. A catch-all here would make an
      // unreadable real apps/ or packages/core/src subtree (permissions,
      // I/O) report as a false-clean scan instead of failing loudly.
      writeFileSync(path.join(tmpRoot, 'apps'), 'not a directory\n');

      expect(() => findRawEventsAccess(tmpRoot, SCAN_ROOTS)).toThrow();
    });
  });

  it('a failure report built from detected hits reads as "file:line — matched pattern" (what the real-tree test above would show)', () => {
    withTempScanRoot((tmpRoot) => {
      const dir = path.join(tmpRoot, 'apps', 'api', 'src');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'bad.ts'), 'db.select().from(events);\n');

      const hits = findRawEventsAccess(tmpRoot, SCAN_ROOTS);
      const message = formatHits(hits);

      expect(message).toBe(`${path.join('apps', 'api', 'src', 'bad.ts')}:1 — matched "from(events)"`);
    });
  });
});
