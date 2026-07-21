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
 * Paths that can never be assigned to a link's slug. The routing rule is
 * `/` → bio page, `/:slug` → redirect (a Cloudflare Origin Rule on the
 * handle host); `/` is therefore the one path a slug could collide
 * with — an empty slug would otherwise shadow the bio page. Kept
 * deliberately minimal: nothing else lives under a handle host's path
 * space (the dashboard and API are separate hosts, not sibling paths),
 * so there is no second reserved path to add here yet.
 */
export const RESERVED_PATHS: readonly string[] = Object.freeze(['/']);

function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
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
