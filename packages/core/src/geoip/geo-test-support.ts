import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Shared between loader.test.ts (T2.3.4) and lookup.test.ts (T2.3.5) — both
// need the REAL DB-IP mmdb pair (downloaded via `pnpm geo:fetch` into
// data/geoip, git-ignored, T0.1.1) for the assertions only real data can
// make honest: a stable, well-known ASN lookup, and — for lookup.test.ts
// specifically — the actual fallback ordering against real country data.
// Extracted out of loader.test.ts (T2.3.5's own testing requirements call
// for reusing loader.test.ts's existing assert helper rather than writing
// a second one) so both files import ONE definition instead of keeping two
// copies of the same "fail loudly, don't skip" guidance in sync by hand.
//
// The real-data tests do NOT skip when data/geoip is absent.
// assertRealGeoDataAvailable() throws the same "run `pnpm geo:fetch`"
// guidance the production loader itself gives on a missing file — a
// quietly-skipped test here would read as coverage that isn't there, which
// is worse than a failing one.

export const REAL_GEOIP_DIR = join(process.cwd(), 'data', 'geoip');
export const REAL_ASN_PATH = join(REAL_GEOIP_DIR, 'dbip-asn-lite.mmdb');
export const REAL_COUNTRY_PATH = join(REAL_GEOIP_DIR, 'dbip-country-lite.mmdb');

export function assertRealGeoDataAvailable(): void {
  if (existsSync(REAL_ASN_PATH) && existsSync(REAL_COUNTRY_PATH)) return;

  throw new Error(
    `This test needs the real DB-IP GeoIP databases. Run \`pnpm geo:fetch\` to download them ` +
      `into ${REAL_GEOIP_DIR} before running this suite.`,
  );
}
