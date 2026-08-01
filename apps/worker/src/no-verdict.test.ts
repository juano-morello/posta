import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// T3.2.7 [E3, S3.2, INV-4] — "the worker enriches; it does not judge": no
// bot/human verdict is ever COMPUTED, anywhere between capture and the
// events_classified SQL view (invariant 4/5). T1.2.5 already proved there
// is nowhere in the schema to STORE one; this proves nobody assigned one
// on the way there either — scanning packages/core/src/enrichment/** and
// apps/worker/src/** (the only two trees that ever see a raw UA/referer
// before enrichment lands in Postgres) for is_bot, isBot, is_human,
// isHuman, classification, verdict, humano, unfurler, and prefetch used
// as an ASSIGNED VALUE: a variable/const/let name, an object/class
// property key, a named function/method, an accessor, or an enum member.
//
// WHY THIS IS AN AST SCAN, NOT A GREP: every file this scan actually
// covers is already full of legitimate PROSE using these exact words —
// source-platform.ts's own header says "never a bot/human verdict" nine
// times over, is-in-app.test.ts's own describe/it blocks and
// corpus.test.ts's own regex-that-happens-to-spell-the-word-list
// (`/"[^"]*(verdict|classification|is_bot|is_human)[^"]*"\s*:/i`) all
// contain these words in COMMENTS, TEST NAMES, and STRING/REGEX LITERAL
// CONTENT, none of which is an assignment. A substring or even a
// word-boundary line grep would self-detect on the very files written to
// EXPLAIN why no verdict exists, making the guard unmaintainable — every
// future comment reinforcing invariant 4 would break it. Confirmed by
// hand before writing this file: `grep -rnoE
// '\b(is_bot|isBot|is_human|isHuman|classification|verdict|humano|
// unfurler|prefetch)\b' packages/core/src/enrichment apps/worker/src`
// returns ~45 hits across the current tree, and every single one sits
// inside a `//` or `/** */` comment, a test-name string, or (corpus.test
// .ts) a regex literal's alternation — never a declaration.
//
// scanSourceForVerdictVocabulary() therefore parses each file with the
// TypeScript compiler API (the same `typescript` package already a repo
// devDependency for tsc itself) and walks the real AST, checking only the
// NAME position of genuine declaration/assignment node kinds:
// VariableDeclaration, BindingElement (destructuring), PropertyAssignment
// and ShorthandPropertyAssignment (object literals — this also catches a
// function RETURNING one of these as a literal key, since the object
// literal's own properties are visited regardless of what expression
// contains them), PropertyDeclaration/PropertySignature (class fields and
// interface/type members), FunctionDeclaration/MethodDeclaration/
// MethodSignature (a function or method literally named one of these),
// GetAccessorDeclaration/SetAccessorDeclaration, and EnumMember. Comments
// are trivia the parser never turns into visitable nodes, and a plain
// string/regex literal that merely CONTAINS one of these words as prose
// is just an expression this scan never inspects — only a name node in
// one of the above declaration shapes ever gets checked. This structurally
// cannot flag a JSDoc explanation, no matter how many times it repeats
// the word "verdict".
//
// WORD-BOUNDARY, NOT SUBSTRING: matching is exact-identifier equality
// against BANNED_IDENTIFIERS below, not `.includes()`. A longer identifier
// that merely CONTAINS one of these words (e.g. a hypothetical
// `EventsClassificationSchema`, or `isBotDetectorEnabled`) is legitimate
// and must not trip this — see the negative-case tests below, which prove
// exactly that distinction. Checked: nothing under either scanned tree
// currently declares such a name (grep confirms every real "classification"
// occurrence today is prose), so this stays a documented design decision
// rather than a currently-load-bearing exemption.
//
// TWO HALVES, BOTH REAL (same lesson tests/conventions/no-literal-domain
// .test.ts's own header states for an earlier guard: prove the detector
// actually fires, don't just assert the easy already-passing case):
//   1. scanTreeForVerdictVocabulary() walks the REAL repo tree and must
//      report zero hits.
//   2. scanSourceForVerdictVocabulary() is called directly against
//      in-memory fixture strings (never written to the repo, never
//      touching the filesystem) proving it genuinely detects every
//      declaration shape above and correctly ignores comments, string
//      literals, and longer identifiers. This is the "importable function
//      unit-tested against a string" approach the task explicitly allows,
//      in preference to committing a real violating file.
//
// [fix-forward, review round 1] REFUSING A BROKEN PARSE: ts.createSourceFile()
// parses LENIENTLY — a file with a genuine syntax error still returns a
// best-effort AST (the errors land in the source file's own diagnostics,
// never thrown), and a corrupted region of that tree can hide a banned
// identifier from visit()'s walk while this scan silently reports zero
// violations for the file. getParseDiagnostics() below reads those
// diagnostics and scanSourceForVerdictVocabulary() throws, naming the file
// and the parser's own message, rather than trusting a parse tree it never
// verified was complete. Every file this scan actually encounters already
// has to pass this repo's own tsc/build gate to exist validly under
// packages/core/src/enrichment/** or apps/worker/src/**, so this is not a
// live production gap — but an invariant-ENFORCING test silently trusting
// unverified input is exactly the "fail loud, don't assume" discipline
// this epic applies everywhere else (T3.4.3's eventBatchKey throwing on a
// NaN-producing input rather than emitting a corrupt key is the most
// recent precedent), so it is closed here too.

const BANNED_IDENTIFIERS = [
  'is_bot',
  'isBot',
  'is_human',
  'isHuman',
  'classification',
  'verdict',
  'humano',
  'unfurler',
  'prefetch',
] as const;

const BANNED_IDENTIFIER_SET: ReadonlySet<string> = new Set(BANNED_IDENTIFIERS);

// The two trees T3.2.7's own task text names — the only places a raw
// UA/referer is ever seen before enrichment lands in Postgres.
const SCAN_ROOTS = ['packages/core/src/enrichment', 'apps/worker/src'] as const;

const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', '.next', '.turbo', '.git', 'coverage']);

interface VerdictVocabularyHit {
  readonly file: string;
  readonly line: number;
  readonly identifier: string;
}

/** Extracts the statically-known text of a declaration NAME node, or
 * `undefined` for a shape with no single known name (an
 * ObjectBindingPattern/ArrayBindingPattern destructuring pattern — its own
 * elements are visited separately as BindingElement nodes by `visit()`
 * below — or a ComputedPropertyName, whose actual key is a runtime
 * expression this scan does not attempt to statically evaluate). */
function extractStaticNameText(nameNode: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
    return nameNode.text;
  }
  if (ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  return undefined;
}

/**
 * `ts.SourceFile.parseDiagnostics` is not part of the compiler API's
 * documented public `.d.ts` surface, but it is populated by every
 * `ts.createSourceFile()` call at runtime — confirmed directly against the
 * installed typescript@5.9.3 package before relying on it here:
 * `ts.createSourceFile('bad.ts', 'const x = { incomplete', ...)
 * .parseDiagnostics` returns a genuine one-element array whose flattened
 * message is `"'}' expected."`. Read defensively (`Array.isArray`, not a
 * direct property assertion or cast-and-trust) so a future TypeScript
 * release renaming or dropping this internal field degrades to "no
 * diagnostics found" here rather than crashing this accessor — the
 * "throws on a deliberately broken fixture" regression test below is what
 * actually guards against that drift going unnoticed, the same way this
 * whole file already relies on tests, not types, to prove runtime
 * behavior matches an unofficial/undocumented API surface.
 */
interface SourceFileWithParseDiagnostics {
  readonly parseDiagnostics?: unknown;
}

function getParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  const diagnostics = (sourceFile as unknown as SourceFileWithParseDiagnostics).parseDiagnostics;
  return Array.isArray(diagnostics) ? (diagnostics as readonly ts.Diagnostic[]) : [];
}

/**
 * Parses `sourceText` (as `fileName`, purely for reporting — never read
 * from disk here) with the TypeScript compiler API and reports every
 * genuine declaration/assignment whose name is exactly one of
 * BANNED_IDENTIFIERS. Pure: no filesystem access, so this is directly
 * unit-testable against an in-memory fixture string.
 *
 * Throws, naming `fileName` and the parser's own diagnostic message(s),
 * if `sourceText` has a genuine syntax error — see this file's own header
 * ("REFUSING A BROKEN PARSE") for why a lenient AST is not trustworthy
 * input for this scan.
 */
function scanSourceForVerdictVocabulary(sourceText: string, fileName: string): VerdictVocabularyHit[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const parseDiagnostics = getParseDiagnostics(sourceFile);
  if (parseDiagnostics.length > 0) {
    const messages = parseDiagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('; ');
    throw new Error(
      `${fileName} has a syntax error and cannot be reliably scanned for verdict ` +
        `vocabulary (invariant 4): ${messages}. ts.createSourceFile() parses leniently — ` +
        `a corrupted region of a syntactically broken file could hide a banned identifier ` +
        `from this scan's AST walk while it silently reported zero violations for the ` +
        `file. Fix the syntax error before this scan's "clean" result can be trusted.`,
    );
  }

  const hits: VerdictVocabularyHit[] = [];

  function recordIfBanned(nameNode: ts.PropertyName | ts.BindingName | undefined): void {
    if (nameNode === undefined) return;
    const text = extractStaticNameText(nameNode);
    if (text === undefined || !BANNED_IDENTIFIER_SET.has(text)) return;

    const { line } = sourceFile.getLineAndCharacterOfPosition(nameNode.getStart(sourceFile));
    hits.push({ file: fileName, line: line + 1, identifier: text });
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
      recordIfBanned(node.name);
    } else if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isEnumMember(node)
    ) {
      recordIfBanned(node.name);
    } else if (ts.isFunctionDeclaration(node)) {
      recordIfBanned(node.name);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

function isScannableFile(fileName: string): boolean {
  return (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) && !fileName.endsWith('.d.ts');
}

/**
 * Walks `scanRoots` (directories, relative to `rootDir`) and scans every
 * `.ts`/`.tsx` file found (excluding `.d.ts` and EXCLUDED_DIR_NAMES) with
 * `scanSourceForVerdictVocabulary()`, reporting hits with a path relative
 * to `rootDir` — so it can be pointed at either the real repo tree or a
 * synthetic temp directory, mirroring
 * tests/conventions/no-literal-domain.test.ts's own scanForLiteralDomains
 * shape.
 */
function scanTreeForVerdictVocabulary(rootDir: string, scanRoots: readonly string[]): VerdictVocabularyHit[] {
  const hits: VerdictVocabularyHit[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error: unknown) {
      // Only a missing directory (ENOENT) is a benign "nothing to scan
      // here". Anything else must fail loudly — silently treating every
      // readdirSync error as empty would let an unreadable subtree report
      // as a clean scan instead of the false negative it actually is.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;

      throw new Error(
        `Failed to read directory "${dir}" while scanning for verdict vocabulary: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !isScannableFile(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      const sourceText = readFileSync(fullPath, 'utf8');
      hits.push(...scanSourceForVerdictVocabulary(sourceText, relativePath));
    }
  }

  for (const root of scanRoots) {
    walk(path.join(rootDir, root));
  }

  return hits;
}

describe('no verdict vocabulary assigned in enrichment/worker source (T3.2.7, INV-4)', () => {
  it(
    `finds zero declarations named ${BANNED_IDENTIFIERS.join('/')} in ` +
      `${SCAN_ROOTS.join(' or ')} (the worker enriches; it does not judge)`,
    () => {
      const hits = scanTreeForVerdictVocabulary(process.cwd(), SCAN_ROOTS);

      if (hits.length > 0) {
        const message = hits
          .map((hit) => `${hit.file}:${hit.line} — banned identifier "${hit.identifier}"`)
          .join('\n');
        expect.fail(
          `Found verdict vocabulary assigned as a real declaration (invariant 4 violation):\n${message}`,
        );
      }

      expect(hits).toEqual([]);
    },
  );
});

describe('scanSourceForVerdictVocabulary detection (in-memory fixtures, never written to the repo)', () => {
  it('flags a const declaration assigning isBot, naming the exact file and line', () => {
    const hits = scanSourceForVerdictVocabulary(
      "const isBot = ua.includes('bot');\n",
      'apps/worker/src/example-violation.ts',
    );

    expect(hits).toEqual([{ file: 'apps/worker/src/example-violation.ts', line: 1, identifier: 'isBot' }]);
  });

  it('a failure report built from a detected hit reads as "file:line — banned identifier" (what the real-tree test above would show)', () => {
    const hits = scanSourceForVerdictVocabulary(
      "const isBot = ua.includes('bot');\n",
      'apps/worker/src/example-violation.ts',
    );
    const message = hits
      .map((hit) => `${hit.file}:${hit.line} — banned identifier "${hit.identifier}"`)
      .join('\n');

    expect(message).toBe('apps/worker/src/example-violation.ts:1 — banned identifier "isBot"');
  });

  it('flags a snake_case is_bot const on a later line, with the correct line number', () => {
    const hits = scanSourceForVerdictVocabulary(
      "import { z } from 'zod';\n\nconst is_bot = true;\n",
      'fixture.ts',
    );

    expect(hits).toEqual([{ file: 'fixture.ts', line: 3, identifier: 'is_bot' }]);
  });

  it('flags is_human, isHuman, classification, verdict, humano, unfurler, and prefetch each individually', () => {
    for (const identifier of ['is_human', 'isHuman', 'classification', 'verdict', 'humano', 'unfurler', 'prefetch'] as const) {
      const hits = scanSourceForVerdictVocabulary(`const ${identifier} = true;\n`, 'fixture.ts');
      expect(hits).toEqual([{ file: 'fixture.ts', line: 1, identifier }]);
    }
  });

  it('flags an object literal property key assigning a verdict (also covers a function returning it)', () => {
    const hits = scanSourceForVerdictVocabulary(
      "function classify(ua) {\n  return { verdict: ua.includes('bot') ? 'bot' : 'human' };\n}\n",
      'fixture.ts',
    );

    expect(hits).toEqual([{ file: 'fixture.ts', line: 2, identifier: 'verdict' }]);
  });

  it('flags a quoted object literal property key', () => {
    const hits = scanSourceForVerdictVocabulary('const result = { "isBot": true };\n', 'fixture.ts');

    expect(hits).toEqual([{ file: 'fixture.ts', line: 1, identifier: 'isBot' }]);
  });

  it('flags a shorthand object literal property', () => {
    const hits = scanSourceForVerdictVocabulary(
      "const isBot = detectBot(ua);\nconst event = { isBot };\n",
      'fixture.ts',
    );

    expect(hits).toEqual([
      { file: 'fixture.ts', line: 1, identifier: 'isBot' },
      { file: 'fixture.ts', line: 2, identifier: 'isBot' },
    ]);
  });

  it('flags a class field named verdict', () => {
    const hits = scanSourceForVerdictVocabulary('class Enricher {\n  verdict = false;\n}\n', 'fixture.ts');

    expect(hits).toEqual([{ file: 'fixture.ts', line: 2, identifier: 'verdict' }]);
  });

  it('flags an interface/type member named isBot', () => {
    const hits = scanSourceForVerdictVocabulary(
      'interface EnrichedEvent {\n  isBot: boolean;\n}\n',
      'fixture.ts',
    );

    expect(hits).toEqual([{ file: 'fixture.ts', line: 2, identifier: 'isBot' }]);
  });

  it('flags a function literally named isBot', () => {
    const hits = scanSourceForVerdictVocabulary('function isBot(ua) {\n  return true;\n}\n', 'fixture.ts');

    expect(hits).toEqual([{ file: 'fixture.ts', line: 1, identifier: 'isBot' }]);
  });

  it('flags a destructured rename that binds a local isBot', () => {
    const hits = scanSourceForVerdictVocabulary('const { flag: isBot } = detect(ua);\n', 'fixture.ts');

    expect(hits).toEqual([{ file: 'fixture.ts', line: 1, identifier: 'isBot' }]);
  });

  it('reports every violation in a file, not just the first', () => {
    const hits = scanSourceForVerdictVocabulary(
      "const isBot = false;\nconst prefetch = false;\nconst safe = true;\n",
      'fixture.ts',
    );

    expect(hits).toEqual([
      { file: 'fixture.ts', line: 1, identifier: 'isBot' },
      { file: 'fixture.ts', line: 2, identifier: 'prefetch' },
    ]);
  });

  it('does NOT flag these words inside a // comment', () => {
    const hits = scanSourceForVerdictVocabulary(
      '// never a bot/human verdict here — invariant 4\nconst safe = true;\n',
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });

  it('does NOT flag these words inside a JSDoc /** */ block', () => {
    const hits = scanSourceForVerdictVocabulary(
      '/**\n * There is no isBot field here and there must never be one.\n */\nexport function safe(): boolean {\n  return true;\n}\n',
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });

  it('does NOT flag these words appearing only as a string literal VALUE (not a property key)', () => {
    const hits = scanSourceForVerdictVocabulary(
      "const message = 'never returns an isBot or verdict field';\n",
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });

  it('does NOT flag these words inside a regex literal (corpus.test.ts\'s own real-world shape)', () => {
    const hits = scanSourceForVerdictVocabulary(
      'const pattern = /"[^"]*(verdict|classification|is_bot|is_human)[^"]*"\\s*:/i;\n',
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });

  it('does NOT flag these words inside a describe/it test-name string', () => {
    const hits = scanSourceForVerdictVocabulary(
      "describe('never a classification fixture (invariant 4)', () => {});\n",
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });

  it('does NOT flag a longer identifier that merely CONTAINS classification as a substring', () => {
    const hits = scanSourceForVerdictVocabulary(
      'const EventsClassificationSchema = defineSchema();\n',
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });

  it('does NOT flag a longer identifier that merely CONTAINS isBot as a substring', () => {
    const hits = scanSourceForVerdictVocabulary('const isBotDetectorEnabled = true;\n', 'fixture.ts');

    expect(hits).toEqual([]);
  });

  it('does NOT flag humano/unfurler/prefetch used as ordinary English/Spanish prose in a comment', () => {
    const hits = scanSourceForVerdictVocabulary(
      '// un clic humano real, sin unfurler ni prefetch en el camino\nconst safe = true;\n',
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });

  it('does NOT flag a clean fixture with no banned identifier at all', () => {
    const hits = scanSourceForVerdictVocabulary(
      "export function isInApp(ua) {\n  return IN_APP_MARKERS.some((m) => ua.includes(m));\n}\n",
      'fixture.ts',
    );

    expect(hits).toEqual([]);
  });
});

describe('scanSourceForVerdictVocabulary refuses to trust a syntactically broken parse', () => {
  it('throws instead of silently reporting zero violations for a file with an unclosed brace', () => {
    expect(() => scanSourceForVerdictVocabulary('const x = { incomplete', 'broken.ts')).toThrow();
  });

  it('the thrown message names the file', () => {
    expect(() => scanSourceForVerdictVocabulary('const x = { incomplete', 'broken.ts')).toThrow(/broken\.ts/);
  });

  it("the thrown message includes the parser's own diagnostic text, not a generic placeholder", () => {
    expect(() => scanSourceForVerdictVocabulary('const x = { incomplete', 'broken.ts')).toThrow(
      /'}' expected/,
    );
  });

  it('a syntactically VALID fixture with zero parse diagnostics never throws (no false positive from this guard)', () => {
    expect(() => scanSourceForVerdictVocabulary('const safe = true;\n', 'fixture.ts')).not.toThrow();
  });

  it('a syntactically valid fixture that also happens to violate the ban both throws never and still detects the violation', () => {
    const hits = scanSourceForVerdictVocabulary("const isBot = ua.includes('bot');\n", 'fixture.ts');

    expect(hits).toEqual([{ file: 'fixture.ts', line: 1, identifier: 'isBot' }]);
  });
});

describe('scanTreeForVerdictVocabulary tree-walk plumbing (in-memory paths, using process.cwd())', () => {
  it('SCAN_ROOTS names exactly the two trees the task scopes: enrichment and worker src', () => {
    expect(SCAN_ROOTS).toEqual(['packages/core/src/enrichment', 'apps/worker/src']);
  });

  it('BANNED_IDENTIFIERS names exactly the 9 words the task specifies, in order', () => {
    expect(BANNED_IDENTIFIERS).toEqual([
      'is_bot',
      'isBot',
      'is_human',
      'isHuman',
      'classification',
      'verdict',
      'humano',
      'unfurler',
      'prefetch',
    ]);
  });

  it('a missing scan root is treated as benign (ENOENT), not an error', () => {
    const hits = scanTreeForVerdictVocabulary(process.cwd(), ['this/root/does/not/exist']);

    expect(hits).toEqual([]);
  });
});
