// Derives every host Posta constructs from POSTA_LINK_DOMAIN (S0.3,
// T0.3.3). This module is isomorphic — no process.env access — so the
// domain/protocol/subdomain labels are passed in as a config object,
// never read from env directly. The app that owns a validated env
// (api, worker, web) reads POSTA_LINK_DOMAIN etc. once at startup and
// hands them to makeUrlBuilders(); everything downstream calls the
// returned builders instead of ever assembling a host by hand. That is
// what keeps T0.3.9's grep test passable: if a host were assembled
// anywhere else, a literal domain would have to appear there too.
//
// Design choice: a curried factory (makeUrlBuilders(config) => { ... })
// rather than a config-per-call signature. The config is fixed for the
// lifetime of a process (it comes from validated env, which does not
// change at runtime), so building the closures once and calling the
// returned functions repeatedly keeps call sites clean — no domain
// object threaded through every buildLinkUrl() call on the redirect hot
// path — and keeps the config's shape centralized in one place.

/** `POSTA_PROTOCOL` — "http" locally, "https" everywhere else. */
export type Protocol = 'http' | 'https';

/**
 * The small, typed slice of validated env that every host-construction
 * helper needs. Each app builds this from its own env schema (next
 * batch); nothing in this module reads process.env itself.
 */
export interface DomainConfig {
  /** `POSTA_LINK_DOMAIN` — see .env.example (never hardcoded here). */
  readonly domain: string;
  /** `POSTA_PROTOCOL`. */
  readonly protocol: Protocol;
  /** `POSTA_APP_SUBDOMAIN` — the dashboard's subdomain label. */
  readonly appSubdomain: string;
  /** `POSTA_API_SUBDOMAIN` — the API's subdomain label. */
  readonly apiSubdomain: string;
}

export interface UrlBuilders {
  /** `<handle>.<domain>/<slug>` — the redirect a visitor's browser hits. */
  buildLinkUrl(handle: string, slug: string): string;
  /** `<handle>.<domain>/` — the bio page. */
  buildBioUrl(handle: string): string;
  /** `<protocol>://<appSubdomain>.<domain><path>` — the dashboard. */
  buildAppUrl(path?: string): string;
  /** `<protocol>://<apiSubdomain>.<domain><path>` — the API. */
  buildApiUrl(path?: string): string;
  /**
   * The inverse of buildLinkUrl/buildBioUrl and the redirect hot path's
   * first step: extract `<handle>` from a request's `Host` header.
   * Returns undefined (typed-absent, never throws) for the apex domain,
   * for the reserved app/api subdomains, for a host outside `domain`,
   * and for anything that is not a single valid label — the hot path
   * treats "no handle" as "404", not as an exception to catch.
   */
  parseHandleFromHost(host: string): string | undefined;
}

// A handle is a single DNS label: lowercase alphanumeric, optionally
// hyphen-separated, no leading/trailing hyphen. This mirrors the shape a
// real subdomain label can take; the fuller "is this handle actually
// claimable" check (charset + reserved-word policy) belongs to slug/
// handle validation (S5.3), which layers RESERVED_HANDLES (T0.3.4) on
// top of this.
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function isReservedSubdomain(label: string, config: DomainConfig): boolean {
  return (
    label === normalizeLabel(config.appSubdomain) ||
    label === normalizeLabel(config.apiSubdomain)
  );
}

/**
 * Validates and normalizes a handle for use in a constructed URL.
 * Throws on anything that could never be a real tenant handle: empty,
 * multi-label, invalid characters, or one of this config's own reserved
 * subdomains (app/api) — a link can never be built for a handle that
 * would collide with the dashboard or the API host.
 */
function assertClaimableHandle(handle: string, config: DomainConfig): string {
  const normalized = normalizeLabel(handle);

  if (!HANDLE_PATTERN.test(normalized)) {
    throw new Error(`Invalid handle: "${handle}"`);
  }

  if (isReservedSubdomain(normalized, config)) {
    throw new Error(`Handle "${handle}" is reserved and cannot be used`);
  }

  return normalized;
}

function hostFor(label: string, config: DomainConfig): string {
  return `${label}.${config.domain}`;
}

function originFor(hostname: string, config: DomainConfig): string {
  return `${config.protocol}://${hostname}`;
}

function normalizePath(path: string): string {
  if (path.length === 0) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Strips a `:port` suffix from a Host header value, e.g.
 * `juano.example.test:3000` (the dev case, since local dev serves every
 * host off one port) → `juano.example.test`. Only strips when the
 * suffix is actually numeric, so a bare colon-free host passes through
 * untouched.
 */
function stripPort(host: string): string {
  const colonIndex = host.lastIndexOf(':');
  if (colonIndex === -1) return host;

  const maybePort = host.slice(colonIndex + 1);
  return /^\d+$/.test(maybePort) ? host.slice(0, colonIndex) : host;
}

function parseHandleFromHostImpl(rawHost: string, config: DomainConfig): string | undefined {
  const host = stripPort(normalizeLabel(rawHost));
  const domain = normalizeLabel(config.domain);

  if (host.length === 0) return undefined;
  if (host === domain) return undefined; // apex domain — no handle

  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return undefined; // not our domain at all

  const label = host.slice(0, -suffix.length);
  if (label.length === 0 || label.includes('.')) return undefined; // empty or multi-level
  if (isReservedSubdomain(label, config)) return undefined; // app./api.

  return label;
}

/**
 * Builds the five host-construction helpers from a single, small,
 * typed config. This is the ONLY place in the codebase a host string is
 * assembled from a domain — see T0.3.9's grep test.
 */
export function makeUrlBuilders(config: DomainConfig): UrlBuilders {
  return {
    buildLinkUrl(handle: string, slug: string): string {
      const normalizedHandle = assertClaimableHandle(handle, config);
      const normalizedSlug = slug.trim();

      if (normalizedSlug.length === 0) {
        throw new Error('slug must not be empty');
      }

      return `${originFor(hostFor(normalizedHandle, config), config)}/${normalizedSlug}`;
    },

    buildBioUrl(handle: string): string {
      const normalizedHandle = assertClaimableHandle(handle, config);
      return `${originFor(hostFor(normalizedHandle, config), config)}/`;
    },

    buildAppUrl(path = ''): string {
      const appHost = hostFor(normalizeLabel(config.appSubdomain), config);
      return `${originFor(appHost, config)}${normalizePath(path)}`;
    },

    buildApiUrl(path = ''): string {
      const apiHost = hostFor(normalizeLabel(config.apiSubdomain), config);
      return `${originFor(apiHost, config)}${normalizePath(path)}`;
    },

    parseHandleFromHost(host: string): string | undefined {
      return parseHandleFromHostImpl(host, config);
    },
  };
}
