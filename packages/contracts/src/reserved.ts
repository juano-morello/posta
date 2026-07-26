// Reserved handles and paths (S0.3, T0.3.4). Shared by the redirect hot
// path (S2.1) and slug/handle validation (S5.3) — one list, never a
// copy, because a drift here lets a user claim a handle or slug that
// then 404s against real infrastructure.
//
// RESERVED_HANDLES is parsed from POSTA_RESERVED_HANDLES per the plan,
// but this module cannot read process.env (contracts is isomorphic —
// zero server deps). The reconciliation: RESERVED_HANDLES below is the
// frozen DEFAULT (the eleven fixed handles from CLAUDE.md, always
// available even with no env at all — e.g. for web's client-side handle
// validation). resolveReservedHandles() is a pure function that merges
// an already-parsed override list (the app's env schema parses
// POSTA_RESERVED_HANDLES with zCsvList from T0.3.2, then hands the
// resulting string[] in here) on top of the default. Nothing here reads
// env directly.

/**
 * Handles that can never be claimed by a tenant, because they collide
 * with a host this codebase itself constructs (app./api., see
 * domain.ts) or with likely future infrastructure (www, static, cdn,
 * mail, blog, docs, status). Fixed order matches CLAUDE.md.
 */
export const RESERVED_HANDLES: readonly string[] = Object.freeze([
  'app',
  'api',
  'www',
  'admin',
  'static',
  'assets',
  'cdn',
  'mail',
  'blog',
  'docs',
  'status',
]);

/**
 * Paths that can never be assigned to a link's slug, matched exactly.
 * The routing rule is `/` → bio page, `/:slug` → redirect (a Cloudflare
 * Origin Rule on the handle host), so `/` is the path a slug could
 * collide with — an empty slug would otherwise shadow the bio page.
 *
 * `/favicon.ico` and `/robots.txt` joined it in T2.1.1: browsers and
 * crawlers request both unprompted on every handle host, and without
 * this list each request would cost a Redis GET plus a Postgres query
 * to discover it was never a slug. They are unreachable as slugs anyway
 * (SLUG_PATTERN in links.ts forbids a dot), so adding them costs no
 * tenant any name they could otherwise have claimed.
 */
export const RESERVED_PATHS: readonly string[] = Object.freeze([
  '/',
  '/favicon.ico',
  '/robots.txt',
]);

/**
 * Reserved path *prefixes*, matched on a path-segment boundary rather
 * than exactly. This list exists because RESERVED_PATHS above cannot
 * express `/.well-known/*`: an ACME challenge path ends in an
 * unpredictable token, so there is no finite set of exact strings to
 * enumerate. Each entry keeps its trailing slash deliberately — that is
 * what makes `isReservedPath` match on a segment boundary instead of a
 * bare substring, so `/.well-knownx` is a perfectly ordinary slug.
 */
export const RESERVED_PATH_PREFIXES: readonly string[] = Object.freeze(['/.well-known/']);

function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

/**
 * Normalizes a request path for reserved-path matching: lowercased,
 * trimmed, with at most one trailing slash removed. An empty path
 * normalizes to `/` — Express reports `""` for a request to a bare
 * origin with no path, and that is the bio-page root, not a slug.
 */
function normalizePath(path: string): string {
  const trimmed = path.trim().toLowerCase();
  if (trimmed.length === 0) return '/';
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1);
  return trimmed;
}

/**
 * Merges the frozen RESERVED_HANDLES default with additional handles —
 * e.g. an operator's POSTA_RESERVED_HANDLES override, already parsed
 * into a string array by zCsvList. Case- and whitespace-normalizes each
 * override, drops empties, and dedupes against the default. Returns a
 * new frozen array; RESERVED_HANDLES itself is never mutated.
 */
export function resolveReservedHandles(
  overrides: readonly string[] = [],
): readonly string[] {
  const merged = new Set(RESERVED_HANDLES);

  for (const override of overrides) {
    const normalized = normalizeHandle(override);
    if (normalized.length > 0) {
      merged.add(normalized);
    }
  }

  return Object.freeze([...merged]);
}

/**
 * True when `handle` can never be claimed by a tenant. Case- and
 * whitespace-insensitive, so `" APP "` is rejected exactly as `app` is.
 *
 * `reserved` defaults to the frozen eleven, but the redirect hot path
 * passes `resolveReservedHandles(env.POSTA_RESERVED_HANDLES)` so an
 * operator's extra reserved words are enforced by THIS function rather
 * than by a second membership check somewhere else — the drift this
 * module exists to prevent is exactly a second copy of the list.
 */
export function isReservedHandle(
  handle: string,
  reserved: readonly string[] = RESERVED_HANDLES,
): boolean {
  const normalized = normalizeHandle(handle);
  if (normalized.length === 0) return false;
  return reserved.includes(normalized);
}

/**
 * True when `path` must bypass slug lookup entirely — answered directly
 * by the hot path with a 404, no Redis GET and no Postgres query (S2.1).
 *
 * Matches RESERVED_PATHS exactly, and RESERVED_PATH_PREFIXES on a path-
 * segment boundary: a prefix entry matches either the base path itself
 * (`/.well-known`) or anything genuinely beneath it
 * (`/.well-known/acme-challenge/abc`), but never a longer sibling
 * segment (`/.well-knownx`). That distinction is the whole point of
 * keeping the trailing slash in the prefix — a plain
 * `startsWith('/.well-known')` would let anyone make the slug
 * `.well-knownx` permanently unreachable.
 */
export function isReservedPath(path: string): boolean {
  const normalized = normalizePath(path);

  if (RESERVED_PATHS.includes(normalized)) return true;

  return RESERVED_PATH_PREFIXES.some((prefix) => {
    // The prefix carries a trailing slash; `normalized` has had at most
    // one stripped. Compare against both forms so `/.well-known`,
    // `/.well-known/` and `/.well-known/x` all match while
    // `/.well-knownx` does not.
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return normalized === base || normalized.startsWith(prefix);
  });
}
