import { isIP } from 'node:net';
import type { AsnResponse, CountryResponse, Reader } from 'maxmind';
import type { GeoDatabases } from './loader';

// T2.3.5 — per-request ASN + country lookup (S2.3), against the reader
// pair T2.3.4's loader resolves ONCE at boot. This file never calls
// openGeoDatabases() itself — createNetworkLookup below takes the reader
// pair as a parameter and is meant to be called exactly ONCE, wherever
// the redirect hot path is assembled (T2.3.7), the same shape
// createRedirectMiddleware (apps/api/src/redirect/middleware.ts) already
// established for the hot path's other per-request closures: build the
// dependency-closing function at boot, call the thin closure it returns
// on every request [INV-2]. Taking `databases` as a constructor argument
// rather than a per-call argument is what makes "resolved once, reused
// every request" the only shape the code can express — there is no
// `lookupNetwork(databases, ip, cfCountry)` call site available to
// accidentally re-resolve `databases` (or worse, call openGeoDatabases()
// again) inside a request handler.
//
// Fallback ordering (spec §5.2, story S2.3):
//   country = CF-IPCountry (present, not a placeholder) | mmdb country | null
//   asn     = mmdb ASN lookup, always — Cloudflare's free headers carry no
//             ASN at all (that needs Workers, which this design avoids).
//
// A geoip failure must never cost a redirect [INV-1] — lookupNetwork must
// never throw. Two independent mechanisms make that hold, deliberately
// layered rather than folded into one blanket try/catch (which would
// hide a genuinely broken reader exactly as easily as it hides a
// genuinely unlookupable address — the silent degradation T2.3.4 exists
// to rule out at BOOT time; this file is the PER-REQUEST half of that
// same discipline):
//
//   1. isLookupableAddress() filters out anything the mmdb reader was
//      never going to usefully answer — malformed input (net.isIP
//      returns 0) and private/loopback/link-local ranges (RFC 1918,
//      RFC 4193, loopback, link-local) — BEFORE the reader is ever
//      called. This is not just belt-and-braces around the reader's own
//      behavior: it is what makes 127.0.0.1 dev traffic, RFC 1918
//      internal traffic and a malformed proxy header behave identically
//      and predictably (null, no reader call, nothing logged), rather
//      than however this particular version of maxmind/mmdb-lib happens
//      to treat them today.
//   2. A narrow try/catch around each individual `reader.get(ip)` call
//      (only that one call, nothing else in either helper) is the last
//      line of defense against a reader that is broken despite (1) —
//      corrupted in memory, a future library regression, anything
//      genuinely unexpected. It logs via logLookupFailure (below) and
//      returns null for that one field; it does NOT swallow errors from
//      anywhere else in this file, so a bug in THIS file's own logic
//      (as opposed to the reader's) still surfaces normally instead of
//      silently becoming another "geoip returned null".
//
// This split is also what makes "the reader is broken" observable at
// all: filtering a private/malformed address logs nothing (expected
// traffic, not a fault), while an actual reader.get() throw logs once,
// distinctly, per field.
//
// Invariant 6 — the IP must never reach a log line or an error message.
// logLookupFailure() below logs ONLY the failing error's constructor
// name, never `error.message` and never `ip` itself: a third-party
// error's message is not this file's to trust — nothing guarantees it
// never echoes back the value that caused it. lookup.test.ts's
// invariant-6 cases drive this with a distinctive IP AND an injected
// error whose own message contains that IP, and assert the address
// appears in no logged call — proving this isn't just "we don't pass
// `ip` explicitly" but "not even a leak riding inside `error.message`
// gets through".

const CF_COUNTRY_PLACEHOLDERS: ReadonlySet<string> = new Set(['XX', 'T1']);

// RFC 1918 private ranges, loopback and link-local — IPv4.
const IPV4_LOOPBACK_OCTET = 127;
const IPV4_PRIVATE_10_OCTET = 10;
const IPV4_PRIVATE_172_OCTET = 172;
const IPV4_PRIVATE_172_SECOND_MIN = 16;
const IPV4_PRIVATE_172_SECOND_MAX = 31;
const IPV4_PRIVATE_192_FIRST = 192;
const IPV4_PRIVATE_192_SECOND = 168;
const IPV4_LINK_LOCAL_FIRST = 169;
const IPV4_LINK_LOCAL_SECOND = 254;

// fc00::/7 (unique local, RFC 4193) and fe80::/10 (link-local) both
// collapse to a range check on the leading 16-bit group (hextet), since
// neither prefix is wider than 16 bits — see firstHextetValue() below.
const IPV6_LOOPBACK = '::1';
const IPV6_UNIQUE_LOCAL_MIN = 0xfc00;
const IPV6_UNIQUE_LOCAL_MAX = 0xfdff;
const IPV6_LINK_LOCAL_MIN = 0xfe80;
const IPV6_LINK_LOCAL_MAX = 0xfebf;

export interface NetworkLookup {
  readonly asn: number | null;
  readonly country: string | null;
}

export type LookupNetwork = (ip: string, cfCountry?: string | null) => NetworkLookup;

/** Minimal logger shape lookupNetwork needs — mirrors
 * RedirectMiddlewareLogger (apps/api/src/redirect/middleware.ts) and its
 * siblings: just enough to log one error line, so tests can pass a plain
 * spy instead of a real pino instance (none is wired up anywhere in this
 * codebase yet). */
export interface GeoLookupLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export const consoleErrorLogger: GeoLookupLogger = {
  error(message, meta) {
    console.error(message, meta);
  },
};

function isPrivateOrReservedIPv4(ip: string): boolean {
  const [first = -1, second = -1] = ip.split('.').map(Number);

  if (first === IPV4_LOOPBACK_OCTET) return true;
  if (first === IPV4_PRIVATE_10_OCTET) return true;
  if (first === IPV4_PRIVATE_172_OCTET && second >= IPV4_PRIVATE_172_SECOND_MIN && second <= IPV4_PRIVATE_172_SECOND_MAX) {
    return true;
  }
  if (first === IPV4_PRIVATE_192_FIRST && second === IPV4_PRIVATE_192_SECOND) return true;
  if (first === IPV4_LINK_LOCAL_FIRST && second === IPV4_LINK_LOCAL_SECOND) return true;

  return false;
}

/**
 * The numeric value of an IPv6 address's leading 16-bit group (hextet) —
 * enough to test both ranges this file cares about, since neither
 * fc00::/7 nor fe80::/10 crosses the first hextet's boundary. Handles
 * the `::` compression form only when it starts the address (e.g.
 * `::1`), which is the only way a net.isIP-validated address can have a
 * zero leading hextet.
 */
function firstHextetValue(ip: string): number {
  if (ip.startsWith('::')) return 0;
  const [firstGroup = ''] = ip.split(':', 1);
  return Number.parseInt(firstGroup, 16);
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === IPV6_LOOPBACK) return true;

  const value = firstHextetValue(normalized);
  if (value >= IPV6_UNIQUE_LOCAL_MIN && value <= IPV6_UNIQUE_LOCAL_MAX) return true;
  if (value >= IPV6_LINK_LOCAL_MIN && value <= IPV6_LINK_LOCAL_MAX) return true;

  return false;
}

/**
 * True when `ip` is a syntactically valid, PUBLIC (non-private, non-
 * loopback, non-link-local) address the mmdb readers are worth calling
 * for. False for malformed input — net.isIP returns 0 for anything that
 * is not a valid IPv4/IPv6 literal, including `""` — and for RFC
 * 1918/4193/loopback/link-local ranges. Neither case is an error: both
 * are addresses no public geoip database has (or should have) a useful
 * answer for.
 */
function isLookupableAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return false;

  return version === 4 ? !isPrivateOrReservedIPv4(ip) : !isPrivateOrReservedIPv6(ip);
}

/**
 * `CF-IPCountry` normalized to either a real, usable country code or
 * `null` — absent, empty/whitespace-only, and both known placeholders
 * (`XX` = Cloudflare's "unknown", `T1` = its Tor marker) all collapse to
 * `null`, so the caller's `??` falls through to the mmdb lookup. The
 * placeholder comparison is case-INsensitive on purpose: Cloudflare
 * always sends uppercase in practice, but nothing about this function
 * should silently depend on that being true forever.
 */
function normalizeCfCountry(cfCountry: string | null | undefined): string | null {
  if (cfCountry == null) return null;

  const trimmed = cfCountry.trim();
  if (trimmed.length === 0) return null;
  if (CF_COUNTRY_PLACEHOLDERS.has(trimmed.toUpperCase())) return null;

  return trimmed;
}

/**
 * Logs that a `reader.get(ip)` call itself threw — the "reader is
 * broken" case, distinct from isLookupableAddress() returning false
 * (which logs nothing: a private IP or a malformed header is expected
 * traffic, not a fault). Deliberately logs ONLY `error`'s constructor
 * name, never `error.message` and never `ip` — see this file's header
 * for why a third-party error's own message cannot be trusted not to
 * echo back the address that caused it.
 */
function logLookupFailure(logger: GeoLookupLogger, field: 'asn' | 'country', error: unknown): void {
  const errorType = error instanceof Error ? error.constructor.name : typeof error;
  logger.error(`GeoIP ${field} lookup threw unexpectedly; returning null for this request`, { errorType });
}

function lookupMmdbAsn(reader: Reader<AsnResponse>, ip: string, logger: GeoLookupLogger): number | null {
  try {
    return reader.get(ip)?.autonomous_system_number ?? null;
  } catch (error) {
    logLookupFailure(logger, 'asn', error);
    return null;
  }
}

function lookupMmdbCountry(reader: Reader<CountryResponse>, ip: string, logger: GeoLookupLogger): string | null {
  try {
    return reader.get(ip)?.country?.iso_code ?? null;
  } catch (error) {
    logLookupFailure(logger, 'country', error);
    return null;
  }
}

/**
 * Builds `lookupNetwork(ip, cfCountry)`, closing over `databases`
 * (T2.3.4's frozen reader pair) and `logger`. Call ONCE, at boot,
 * wherever the redirect hot path is assembled — never per request; see
 * this file's header for why the shape itself enforces that.
 */
export function createNetworkLookup(databases: GeoDatabases, logger: GeoLookupLogger = consoleErrorLogger): LookupNetwork {
  return function lookupNetwork(ip, cfCountry) {
    const cf = normalizeCfCountry(cfCountry);
    const lookupable = isLookupableAddress(ip);

    return {
      asn: lookupable ? lookupMmdbAsn(databases.asn, ip, logger) : null,
      country: cf ?? (lookupable ? lookupMmdbCountry(databases.country, ip, logger) : null),
    };
  };
}
