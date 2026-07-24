import {
  isReservedHandle,
  isReservedPath,
  isValidSlug,
  SLUG_MAX_LENGTH,
  type UrlBuilders,
} from '@posta/contracts';

// T2.1.2 — the redirect hot path's first step: decide what a request's
// Host and path actually address, before any I/O happens.
//
// Deliberately PURE — no request object, no Redis, no Postgres, no
// process.env read of its own. Three consequences, all of them the point:
// it is trivially table-testable (host.test.ts), it costs no allocation
// beyond its own return value on the hot path, and every branch that can
// answer without touching a datastore is discovered HERE rather than
// after a wasted round trip. T2.6.5 and T2.6.8 assert exactly that: a
// reserved handle, a reserved path and a 4 KB hostile path must each cost
// zero Redis GETs and zero Postgres queries.
//
// The domain config arrives through a factory, mirroring makeUrlBuilders'
// own curried shape (contracts/domain.ts) — the config is fixed for the
// life of the process, so it is resolved once at boot and closed over,
// never threaded through a per-request argument. That is also what keeps
// T0.3.9's grep test passable: no literal domain appears here, only the
// builders built from POSTA_LINK_DOMAIN.

/**
 * What a request's `Host` + path addresses. A discriminated union rather
 * than a nullable handle/slug pair, because the six outcomes get six
 * genuinely different responses — a 404 alarm, a silent 404, a redirect
 * and a fall-through to Nest are not interchangeable.
 */
export type RequestTarget =
  /** A slug lookup on a tenant's handle host — the only kind that does I/O. */
  | { readonly kind: 'link'; readonly handle: string; readonly slug: string }
  /**
   * `/` on a tenant handle host. Cloudflare's Origin Rule is supposed to
   * send this to Next (the bio page), so the API seeing it means that
   * rule is misconfigured — T2.1.5 makes this branch an alarm, which is
   * why it is not folded into `reserved-path` even though `/` is itself
   * in RESERVED_PATHS. Root is therefore checked FIRST.
   */
  | { readonly kind: 'handle-root'; readonly handle: string }
  /** `/favicon.ico`, `/robots.txt`, `/.well-known/*` — answered directly, no lookup. */
  | { readonly kind: 'reserved-path' }
  /**
   * A handle no tenant can ever claim (`www`, `admin`, … plus any
   * POSTA_RESERVED_HANDLES override). It can never resolve to a link, so
   * short-circuiting it here is what makes "a reserved handle costs zero
   * lookups" true rather than merely likely.
   *
   * Note `app` and `api` never reach this branch: parseHandleFromHost
   * refuses them as handles because they are this deployment's own
   * dashboard and API hosts, so they arrive as `not-ours` and fall
   * through to Nest — which is required, or api.<domain>/v1/* would stop
   * being served.
   */
  | { readonly kind: 'reserved-handle'; readonly handle: string }
  /**
   * A path on a tenant handle host that could not be a slug under any
   * circumstances: more than one segment, an encoded traversal, a null
   * byte, an uppercase form, or simply too long. Distinct from "a valid
   * slug that does not exist" (which is a lookup miss, discovered in
   * S2.2) because this one is decidable without touching a datastore.
   */
  | { readonly kind: 'invalid-path' }
  /** Not a tenant link host at all — the apex, app./api., or a foreign domain. Falls through to Nest. */
  | { readonly kind: 'not-ours' };

export interface RequestTargetParserConfig {
  /** Built once at boot from validated env — see makeUrlBuilders. */
  readonly urls: UrlBuilders;
  /** `resolveReservedHandles(env.POSTA_RESERVED_HANDLES)`, resolved once at boot. */
  readonly reservedHandles: readonly string[];
}

export type ParseRequestTarget = (host: string, path: string) => RequestTarget;

// Frozen singletons for the payload-free variants: these are returned on
// every reserved-path and every not-ours request, and there is no reason
// to allocate a fresh object per request for a value with no fields.
const NOT_OURS: RequestTarget = Object.freeze({ kind: 'not-ours' as const });
const RESERVED_PATH: RequestTarget = Object.freeze({ kind: 'reserved-path' as const });
const INVALID_PATH: RequestTarget = Object.freeze({ kind: 'invalid-path' as const });

// Percent-encoding expands a character to at most three bytes ("%41"),
// so a slug that could survive validation cannot exceed this once
// encoded. Checked BEFORE decodeURIComponent so a multi-kilobyte hostile
// path is rejected without doing the decode work at all (T2.6.8).
const MAX_ENCODED_SLUG_LENGTH = SLUG_MAX_LENGTH * 3;

/** A path consisting only of slashes: '/', '//', '///', … */
const ONLY_SLASHES = /^\/+$/;

/**
 * Extracts the single path segment a slug lookup would use, or undefined
 * when the path cannot be one.
 *
 * The `/` check runs twice on purpose — once on the raw remainder and
 * again after decoding. The second is the load-bearing one: `%2f` decodes
 * to a slash, so a single-segment path can become multi-segment only
 * after decoding, and skipping that re-check is how an encoded traversal
 * slips through a matcher that looked correct.
 */
function extractSlug(path: string): string | undefined {
  if (!path.startsWith('/')) return undefined;

  const encoded = path.slice(1);
  if (encoded.length === 0) return undefined;
  if (encoded.length > MAX_ENCODED_SLUG_LENGTH) return undefined;
  if (encoded.includes('/')) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // A malformed percent-encoding ("/%", "/%zz") throws URIError. That
    // is a 404, never a 500 — the hot path must not throw on input an
    // attacker fully controls.
    return undefined;
  }

  if (decoded.includes('/')) return undefined;

  return decoded;
}

/**
 * Builds the request-target parser from config resolved once at boot.
 * The returned function is what runs per request.
 */
export function makeRequestTargetParser(config: RequestTargetParserConfig): ParseRequestTarget {
  const { urls, reservedHandles } = config;

  return function parseRequestTarget(host: string, path: string): RequestTarget {
    // parseHandleFromHost already lowercases, strips a :port suffix and a
    // single trailing DNS root dot, and returns undefined for the apex,
    // for app./api., for a multi-label subdomain and for a foreign
    // domain — so every "not a tenant handle host" case collapses here.
    const handle = urls.parseHandleFromHost(host ?? '');
    if (handle === undefined) return NOT_OURS;

    // Before any path work: a handle nobody can claim can never own a
    // link, whatever the path is. This also means the root of a reserved
    // handle is NOT an Origin-Rule alarm — there is no bio page for a
    // handle no tenant owns.
    if (isReservedHandle(handle, reservedHandles)) return { kind: 'reserved-handle', handle };

    // Root before reserved-path: '/' is itself in RESERVED_PATHS, and
    // this branch is an alarm rather than a silent 404.
    if (path === '' || path === '/') return { kind: 'handle-root', handle };

    // A path of nothing but slashes is neither the root nor a slug.
    // Handled explicitly, ahead of isReservedPath, because that function
    // strips ONE trailing slash for matching — which would fold '//' into
    // '/' and report it as a reserved path while '///' fell through to
    // invalid-path. Same 404 either way, but two spellings of the same
    // nonsense taking two different branches is the kind of inconsistency
    // that later grows a real bug. It must NOT become handle-root: the
    // Cloudflare Origin Rule matches path == "/" exactly, so '//' reaching
    // the API is ordinary traffic, not evidence of a misroute.
    if (ONLY_SLASHES.test(path)) return INVALID_PATH;

    if (isReservedPath(path)) return RESERVED_PATH;

    const slug = extractSlug(path);
    if (slug === undefined || !isValidSlug(slug)) return INVALID_PATH;

    return { kind: 'link', handle, slug };
  };
}
