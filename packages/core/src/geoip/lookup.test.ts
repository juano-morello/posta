import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AsnResponse, CountryResponse, Reader } from 'maxmind';
import { assertRealGeoDataAvailable, REAL_GEOIP_DIR } from './geo-test-support';
import { createGeoDatabases, type GeoDatabases } from './loader';
import { consoleErrorLogger, createNetworkLookup, type GeoLookupLogger, type NetworkLookup } from './lookup';

// T2.3.5 — lookupNetwork's fallback ordering (spec §5.2, story S2.3):
//   country = CF-IPCountry (present, not a placeholder) | mmdb country | null
//   asn     = mmdb ASN lookup, always
// and its INV-1/INV-6 obligations: a geoip failure must never throw (so it
// never costs a redirect), and the raw IP must never reach a log line or a
// thrown message.
//
// KNOWN_ASN/KNOWN_COUNTRY are asserted against the REAL DB-IP databases
// (data/geoip, fetched via `pnpm geo:fetch`) — a real regression in field
// extraction (wrong key, wrong response shape) would slip past an assertion
// like "some number" or "not null"; asserting the actual value 8.8.8.8 has
// carried for years (Google's own permanently-assigned ASN) does not. If a
// future `pnpm geo:fetch` re-download ever changes DB-IP's country
// attribution for this address, update KNOWN_COUNTRY — it is asserting real
// third-party data, not an invariant this codebase controls.
const KNOWN_PUBLIC_IP = '8.8.8.8'; // Google Public DNS
const KNOWN_ASN = 15169; // Google LLC
const KNOWN_COUNTRY = 'US';

// A second, IPv6 public address — proves the IPv6 branch of the
// lookupable/private-range check and the IPv6 read path both work, not
// just IPv4. Same ASN as the v4 case (same operator), different country
// attribution (DB-IP geolocates the v6 anycast address differently) —
// asserted as its own real value for the same "don't weaken the
// assertion" reason as above.
const KNOWN_PUBLIC_IPV6 = '2001:4860:4860::8888'; // Google Public DNS, IPv6
const KNOWN_IPV6_COUNTRY = 'CA';

// RFC 5737 TEST-NET-3 — syntactically a normal public IPv4 address (not
// private/loopback/link-local, so isLookupableAddress lets it through to
// the reader), but reserved for documentation and never routed, so no
// commercial geoip database has an entry for it. This is what proves the
// "reader.get() returns null" branch (a genuine, non-exceptional "not
// found") separately from BOTH the pre-filtered-private-address branch
// (reader never called at all) and the reader-throws branch (invariant-6
// suite below, using a neighbouring address in this same reserved block).
const RESERVED_NO_ENTRY_IP = '203.0.113.1';

// The distinctive address the invariant-6 suite drives a THROWING lookup
// with — the brief's own suggested literal, kept distinct from
// RESERVED_NO_ENTRY_IP above so the two tests can't be confused for one
// another (one proves "found nothing", the other proves "nothing leaked
// on failure").
const INVARIANT_6_IP = '203.0.113.77';

const CF_PRESENT = 'AR'; // deliberately different from KNOWN_COUNTRY/KNOWN_IPV6_COUNTRY, to prove precedence

/**
 * The exact shape of GeoLookupLogger#error, spelled out so
 * `vi.fn<LoggerErrorFn>()` produces a Mock whose call signature is
 * structurally assignable to GeoLookupLogger — an untyped `vi.fn()`
 * infers `(...args: any[]) => any`, which typechecks fine at the call
 * site but fails `tsc --noEmit -p tsconfig.test.json` when assigned to
 * the interface (mirrors middleware.test.ts's identical LoggerErrorFn).
 */
type LoggerErrorFn = (message: string, meta?: Record<string, unknown>) => void;

function fakeLogger(): GeoLookupLogger & { readonly error: ReturnType<typeof vi.fn<LoggerErrorFn>> } {
  return { error: vi.fn<LoggerErrorFn>() };
}

function stubCountryResponse(isoCode: string): CountryResponse {
  return { country: { geoname_id: 1, iso_code: isoCode, names: { en: 'stub' } } };
}

function stubAsnResponse(asn: number): AsnResponse {
  return { autonomous_system_number: asn, autonomous_system_organization: 'stub' };
}

/** A GeoDatabases pair whose readers return canned, non-throwing
 * responses — used wherever a test cares about lookupNetwork's OWN logic
 * (normalization, fallback ordering) rather than the real mmdb data. */
function stubDatabases(asn: number, countryIsoCode: string): GeoDatabases {
  return {
    asn: { get: () => stubAsnResponse(asn) } as unknown as Reader<AsnResponse>,
    country: { get: () => stubCountryResponse(countryIsoCode) } as unknown as Reader<CountryResponse>,
  };
}

interface IpCase {
  readonly ip: string;
  readonly ipLabel: string;
  readonly mmdbAsn: number | null;
  readonly mmdbCountry: string | null;
}

// The six cases the brief's verify line names, in the order it names
// them, plus KNOWN_PUBLIC_IP's expected real values spelled out so the
// table below can derive every (ip, cfCountry) combination's expectation
// mechanically rather than by hand.
const IP_CASES: readonly IpCase[] = [
  { ip: KNOWN_PUBLIC_IP, ipLabel: 'a known public IP (Google Public DNS)', mmdbAsn: KNOWN_ASN, mmdbCountry: KNOWN_COUNTRY },
  { ip: '127.0.0.1', ipLabel: 'IPv4 loopback', mmdbAsn: null, mmdbCountry: null },
  { ip: '::1', ipLabel: 'IPv6 loopback', mmdbAsn: null, mmdbCountry: null },
  { ip: '10.0.0.1', ipLabel: 'RFC 1918 private (10.0.0.0/8)', mmdbAsn: null, mmdbCountry: null },
  { ip: 'not-an-ip', ipLabel: 'malformed (not an IP at all)', mmdbAsn: null, mmdbCountry: null },
  { ip: '', ipLabel: 'malformed (empty string)', mmdbAsn: null, mmdbCountry: null },
];

interface CfVariant {
  readonly cf: string | undefined;
  readonly cfLabel: string;
}

const CF_VARIANTS: readonly CfVariant[] = [
  { cf: CF_PRESENT, cfLabel: 'CF-IPCountry present' },
  { cf: undefined, cfLabel: 'CF-IPCountry absent' },
  { cf: 'XX', cfLabel: 'CF-IPCountry is the XX placeholder' },
];

interface TableRow {
  readonly ipLabel: string;
  readonly cfLabel: string;
  readonly ip: string;
  readonly cf: string | undefined;
  readonly expected: NetworkLookup;
}

const TABLE: readonly TableRow[] = IP_CASES.flatMap((ipCase) =>
  CF_VARIANTS.map((cfVariant) => ({
    ipLabel: ipCase.ipLabel,
    cfLabel: cfVariant.cfLabel,
    ip: ipCase.ip,
    cf: cfVariant.cf,
    expected: {
      // asn never depends on cfCountry — always the mmdb lookup (or null).
      asn: ipCase.mmdbAsn,
      // CF-IPCountry (when present and not a placeholder) always wins;
      // "absent" and "XX" both collapse to the same fallback.
      country: cfVariant.cf === CF_PRESENT ? CF_PRESENT : ipCase.mmdbCountry,
    },
  })),
);

describe('createNetworkLookup (T2.3.5) — with the real DB-IP databases', () => {
  let databases: GeoDatabases;

  beforeAll(() => {
    assertRealGeoDataAvailable();
    databases = createGeoDatabases({ dbDir: REAL_GEOIP_DIR });
  });

  it.each(TABLE.map((row) => [row.ipLabel, row.cfLabel, row] as const))('%s, %s', (_ipLabel, _cfLabel, row) => {
    const lookupNetwork = createNetworkLookup(databases);

    const result = lookupNetwork(row.ip, row.cf);

    expect(result).toEqual(row.expected);
  });

  it('resolves a public IPv6 address through the same path as IPv4', () => {
    const lookupNetwork = createNetworkLookup(databases);

    const result = lookupNetwork(KNOWN_PUBLIC_IPV6, undefined);

    expect(result).toEqual({ asn: KNOWN_ASN, country: KNOWN_IPV6_COUNTRY });
  });

  it('honours a present CF-IPCountry over the mmdb country for IPv6 too', () => {
    const lookupNetwork = createNetworkLookup(databases);

    const result = lookupNetwork(KNOWN_PUBLIC_IPV6, CF_PRESENT);

    expect(result).toEqual({ asn: KNOWN_ASN, country: CF_PRESENT });
  });

  it('returns null (not a throw) for a routable-looking address the mmdb genuinely has no entry for', () => {
    // RESERVED_NO_ENTRY_IP is NOT private/loopback/link-local, so this
    // exercises reader.get() actually being called and returning null —
    // distinct from every case in TABLE above, which are all filtered
    // before the reader is ever reached.
    const lookupNetwork = createNetworkLookup(databases);

    const result = lookupNetwork(RESERVED_NO_ENTRY_IP, undefined);

    expect(result).toEqual({ asn: null, country: null });
  });

  it('treats the unspecified IPv6 address "::" as lookupable (not loopback, not link-local/ULA) and gets a genuine null back', () => {
    // "::" is NOT "::1" — it fails the exact loopback match, and its
    // leading hextet is 0, outside both the fc00::/7 and fe80::/10
    // ranges, so isPrivateOrReservedIPv6 lets it through. Also the only
    // way this suite exercises firstHextetValue's "::"-prefixed branch,
    // since KNOWN_PUBLIC_IPV6 does not start with "::".
    const lookupNetwork = createNetworkLookup(databases);

    const result = lookupNetwork('::', undefined);

    expect(result).toEqual({ asn: null, country: null });
  });
});

describe('CF-IPCountry normalization', () => {
  // A lookupable-format IP against a stub reader pair, so these cases
  // test ONLY normalizeCfCountry's own behavior — not whether the real
  // mmdb files happen to agree with them. Stub country is 'ZZ', a value
  // no real ISO code or placeholder collides with.
  it.each([
    ['XX', 'ZZ', 'uppercase XX (Cloudflare unknown) falls through to mmdb'],
    ['xx', 'ZZ', 'lowercase xx — case-insensitive placeholder match'],
    ['T1', 'ZZ', 'uppercase T1 (Cloudflare Tor marker) falls through to mmdb'],
    ['t1', 'ZZ', 'lowercase t1 — case-insensitive placeholder match'],
    ['', 'ZZ', 'empty string treated as absent'],
    ['   ', 'ZZ', 'whitespace-only treated as absent'],
    ['  AR  ', 'AR', 'surrounding whitespace trimmed off a real value'],
    ['AR', 'AR', 'a real, non-placeholder value passes through unchanged'],
  ])('cfCountry %j resolves to country %j (%s)', (cf, expectedCountry) => {
    const lookupNetwork = createNetworkLookup(stubDatabases(64512, 'ZZ'));

    const result = lookupNetwork(KNOWN_PUBLIC_IP, cf);

    expect(result.country).toBe(expectedCountry);
  });
});

describe('private/loopback/link-local/malformed addresses never reach the reader', () => {
  // Proves the pre-filtering itself, independent of the real database's
  // incidental behavior: a reader.get() that would throw for ANY input is
  // never even called for these addresses.
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['::1', 'IPv6 loopback'],
    ['10.0.0.1', 'RFC 1918 private (10.0.0.0/8)'],
    ['172.20.0.1', 'RFC 1918 private (172.16.0.0/12)'],
    ['192.168.1.1', 'RFC 1918 private (192.168.0.0/16)'],
    ['169.254.1.1', 'IPv4 link-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd12:3456::1', 'IPv6 unique local (fc00::/7)'],
    ['not-an-ip', 'malformed'],
    ['', 'empty string'],
  ])('%s (%s)', (ip) => {
    const asnGet = vi.fn(() => {
      throw new Error('reader.get() must never be called for this address');
    });
    const countryGet = vi.fn(() => {
      throw new Error('reader.get() must never be called for this address');
    });
    const databases: GeoDatabases = {
      asn: { get: asnGet } as unknown as Reader<AsnResponse>,
      country: { get: countryGet } as unknown as Reader<CountryResponse>,
    };
    const logger = fakeLogger();
    const lookupNetwork = createNetworkLookup(databases, logger);

    expect(() => lookupNetwork(ip, undefined)).not.toThrow();
    expect(asnGet).not.toHaveBeenCalled();
    expect(countryGet).not.toHaveBeenCalled();
    // Filtering a private/malformed address is expected traffic, not a
    // fault — it must log nothing. Only an actual reader failure (the
    // suites below) is loggable.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still honours a present CF-IPCountry for a private address, per decision 3', () => {
    const databases: GeoDatabases = {
      asn: { get: vi.fn() } as unknown as Reader<AsnResponse>,
      country: { get: vi.fn() } as unknown as Reader<CountryResponse>,
    };
    const lookupNetwork = createNetworkLookup(databases);

    const result = lookupNetwork('127.0.0.1', 'AR');

    expect(result).toEqual({ asn: null, country: 'AR' });
  });
});

describe('a broken reader is distinguishable from a not-lookupable address', () => {
  it('never rethrows when the ASN reader throws, returns null for asn, and does not affect a successful country lookup', () => {
    const logger = fakeLogger();
    const databases: GeoDatabases = {
      asn: {
        get: () => {
          throw new Error('reader is broken');
        },
      } as unknown as Reader<AsnResponse>,
      country: { get: () => stubCountryResponse('ZZ') } as unknown as Reader<CountryResponse>,
    };
    const lookupNetwork = createNetworkLookup(databases, logger);

    let result: NetworkLookup | undefined;
    expect(() => {
      result = lookupNetwork(KNOWN_PUBLIC_IP, undefined);
    }).not.toThrow();

    expect(result).toEqual({ asn: null, country: 'ZZ' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain('asn');
  });

  it('never rethrows when the country reader throws, and does not affect a successful asn lookup', () => {
    const logger = fakeLogger();
    const databases: GeoDatabases = {
      asn: { get: () => stubAsnResponse(64512) } as unknown as Reader<AsnResponse>,
      country: {
        get: () => {
          throw new Error('reader is broken');
        },
      } as unknown as Reader<CountryResponse>,
    };
    const lookupNetwork = createNetworkLookup(databases, logger);

    let result: NetworkLookup | undefined;
    expect(() => {
      result = lookupNetwork(KNOWN_PUBLIC_IP, undefined);
    }).not.toThrow();

    expect(result).toEqual({ asn: 64512, country: null });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain('country');
  });

  it('defaults to consoleErrorLogger when no logger is passed', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const databases: GeoDatabases = {
      asn: {
        get: () => {
          throw new Error('reader is broken');
        },
      } as unknown as Reader<AsnResponse>,
      country: { get: () => null } as unknown as Reader<CountryResponse>,
    };
    const lookupNetwork = createNetworkLookup(databases);

    lookupNetwork(KNOWN_PUBLIC_IP, undefined);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it('consoleErrorLogger itself calls console.error', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    consoleErrorLogger.error('a message', { some: 'meta' });

    expect(consoleErrorSpy).toHaveBeenCalledWith('a message', { some: 'meta' });
    consoleErrorSpy.mockRestore();
  });
});

describe('invariant 6 — the raw IP never reaches a log line or a thrown message', () => {
  it('does not leak a distinctive IP anywhere when the ASN reader throws an error whose OWN message contains it', () => {
    const logger = fakeLogger();
    const databases: GeoDatabases = {
      asn: {
        get: () => {
          // Simulates a hypothetical library bug that embeds the address
          // in its own thrown message — the worst case this file's
          // logging must still be safe against, not just "we don't pass
          // ip explicitly ourselves".
          throw new Error(`lookup failed for ${INVARIANT_6_IP}`);
        },
      } as unknown as Reader<AsnResponse>,
      country: { get: () => null } as unknown as Reader<CountryResponse>,
    };
    const lookupNetwork = createNetworkLookup(databases, logger);

    expect(() => lookupNetwork(INVARIANT_6_IP, undefined)).not.toThrow();

    const loggedText = JSON.stringify(logger.error.mock.calls);
    expect(loggedText).not.toContain(INVARIANT_6_IP);
  });

  it('does not leak a distinctive IP anywhere when the country reader throws an error whose OWN message contains it', () => {
    const logger = fakeLogger();
    const databases: GeoDatabases = {
      asn: { get: () => null } as unknown as Reader<AsnResponse>,
      country: {
        get: () => {
          throw new Error(`lookup failed for ${INVARIANT_6_IP}`);
        },
      } as unknown as Reader<CountryResponse>,
    };
    const lookupNetwork = createNetworkLookup(databases, logger);

    expect(() => lookupNetwork(INVARIANT_6_IP, undefined)).not.toThrow();

    const loggedText = JSON.stringify(logger.error.mock.calls);
    expect(loggedText).not.toContain(INVARIANT_6_IP);
  });

  it('does not leak a distinctive IP when the thrown value is not an Error at all (a raw string)', () => {
    // A reader could in principle throw a non-Error value (a plain
    // string, for instance) — logLookupFailure's `error instanceof Error
    // ? ... : typeof error` branch exists for exactly this case, and
    // must stay just as safe: `typeof error` is 'string', never the
    // string's own content.
    const logger = fakeLogger();
    const databases: GeoDatabases = {
      asn: {
        get: () => {
          // Deliberately a raw string throw, not `new Error(...)` — see
          // this test's own description for why.
          throw `lookup failed for ${INVARIANT_6_IP}`;
        },
      } as unknown as Reader<AsnResponse>,
      country: { get: () => null } as unknown as Reader<CountryResponse>,
    };
    const lookupNetwork = createNetworkLookup(databases, logger);

    expect(() => lookupNetwork(INVARIANT_6_IP, undefined)).not.toThrow();

    const loggedText = JSON.stringify(logger.error.mock.calls);
    expect(loggedText).not.toContain(INVARIANT_6_IP);
  });
});
