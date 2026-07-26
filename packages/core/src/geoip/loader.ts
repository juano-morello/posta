import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reader } from 'maxmind';
import type { AsnResponse, CountryResponse } from 'maxmind';

// T2.3.4 — boot-time GeoIP loader (S2.3). Two DB-IP "lite" mmdb files
// (scripts/fetch-geoip.sh, T2.3.3) live on disk at GEOIP_DB_DIR; this
// module reads BOTH into memory once and hands back a frozen reader pair
// that T2.3.5's lookupNetwork() (and every request after it) closes over
// — zero per-request file I/O on the hot path (invariant 2).
//
// `maxmind` is the npm package name — MaxMind, the format's originator,
// gave it that name — but its `Reader` class reads any spec-compliant
// .mmdb file, DB-IP's included (same on-disk format; scripts/fetch-geoip.sh
// already uses this exact class to validate a fresh download). The
// PUBLISHER (DB-IP vs MaxMind) is a download-script choice made once in
// T2.3.3, not a code dependency — do not "fix" this import by hunting for
// a `dbip`-branded package; none exists, and none is needed.
//
// Silent degradation is the failure mode this file exists to rule out. An
// API that boots with no ASN reader does not crash — it just produces
// `asn: null` on every event, forever, and classification rule 6
// (datacenter-origin traffic is one of the strongest bot signals) never
// fires again. Nothing pages anyone; the product just quietly starts
// reporting bots as humans. So a missing, unreadable, or corrupt file
// THROWS here, synchronously — before the API entrypoint's `listen()` is
// ever reached — and this module never returns a partially-working pair.
//
// Memoization shape mirrors redis/client.ts's getRedis()/closeRedis() (see
// that file's header for the fuller rationale): createGeoDatabases() is
// the fresh/unmemoized builder every test uses directly; openGeoDatabases()
// is the process-wide singleton the API entrypoint calls once at boot and
// every request closes over; resetGeoDatabases() clears the memo for test
// teardown. Named "reset", not "close" like closeRedis(): there is no
// socket or file handle held open here to close — Reader holds the whole
// file as an in-memory Buffer (readFileSync, not a stream), so clearing
// the memo variable IS the entire teardown story.

const ASN_FILENAME = 'dbip-asn-lite.mmdb';
const COUNTRY_FILENAME = 'dbip-country-lite.mmdb';
const ENV_VAR = 'GEOIP_DB_DIR';

export interface GeoDatabaseOptions {
  /** Defaults to `process.env.GEOIP_DB_DIR` when omitted. */
  readonly dbDir?: string;
}

export interface GeoDatabases {
  readonly asn: Reader<AsnResponse>;
  readonly country: Reader<CountryResponse>;
}

function resolveDbDir(options: GeoDatabaseOptions): string {
  const dbDir = options.dbDir ?? process.env[ENV_VAR];

  if (!dbDir) {
    throw new Error(`${ENV_VAR} must be set (or pass dbDir explicitly to createGeoDatabases).`);
  }

  return dbDir;
}

/**
 * Reads one .mmdb file into memory and parses it. On any failure — file
 * missing, unreadable, or not a valid MMDB (truncated download, wrong
 * file entirely) — throws an error naming the resolved path, the env var
 * that points at it ({@link ENV_VAR}), and the `pnpm geo:fetch` command
 * that fixes the common case. Nothing beyond that reaches the message: no
 * directory listing, no other env vars, no raw OS error text — just
 * enough for an operator to know which file, and which setting, to check.
 */
function readDatabase<T extends AsnResponse | CountryResponse>(
  dbDir: string,
  filename: string,
  label: string,
): Reader<T> {
  const dbPath = join(dbDir, filename);
  let buffer: Buffer;

  try {
    buffer = readFileSync(dbPath);
  } catch (cause) {
    throw new Error(
      `GeoIP ${label} database not found or unreadable at "${dbPath}" (from ${ENV_VAR}). ` +
        `Run \`pnpm geo:fetch\` to download it, or check that ${ENV_VAR} points at the right directory.`,
      { cause },
    );
  }

  try {
    return new Reader<T>(buffer);
  } catch (cause) {
    throw new Error(
      `GeoIP ${label} database at "${dbPath}" (from ${ENV_VAR}) is not a valid MMDB file — it may be ` +
        `truncated or corrupt. Run \`pnpm geo:fetch\` to re-download it.`,
      { cause },
    );
  }
}

/**
 * Reads both mmdb files fresh from `options.dbDir` (or `GEOIP_DB_DIR`) and
 * returns a frozen `{ asn, country }` pair. NEVER memoized — every call
 * re-reads both files from disk. Tests use this directly; production code
 * should call {@link openGeoDatabases} instead.
 *
 * Never returns a partially-working pair: the ASN file is read first, so a
 * country-file failure still fails the whole call before either reader
 * reaches the caller — there is no code path on which one reader works
 * and the other is silently absent.
 */
export function createGeoDatabases(options: GeoDatabaseOptions = {}): GeoDatabases {
  const dbDir = resolveDbDir(options);
  const asn = readDatabase<AsnResponse>(dbDir, ASN_FILENAME, 'ASN');
  const country = readDatabase<CountryResponse>(dbDir, COUNTRY_FILENAME, 'country');

  return Object.freeze({ asn, country });
}

let memoized: GeoDatabases | undefined;

/**
 * The process-wide singleton the API entrypoint calls once, before
 * `listen()` — T2.3.4's whole point is that a bad file fails STARTUP, not
 * a running process. Builds via {@link createGeoDatabases} on the first
 * call and returns that SAME object on every call after; `options` is
 * only consulted the first time, exactly like {@link getRedis}.
 */
export function openGeoDatabases(options?: GeoDatabaseOptions): GeoDatabases {
  if (!memoized) {
    memoized = createGeoDatabases(options);
  }

  return memoized;
}

/**
 * Clears the memoized singleton so the next {@link openGeoDatabases} call
 * reads both files again. Test teardown's job — see this file's header
 * for why this is a plain memo reset rather than a "close".
 */
export function resetGeoDatabases(): void {
  memoized = undefined;
}
