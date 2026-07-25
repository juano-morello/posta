import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGeoDatabases, openGeoDatabases, resetGeoDatabases } from './loader';

// T2.3.4 — proves the boot-time GeoIP loader fails LOUDLY (never returns a
// degraded/partial reader pair) and that openGeoDatabases() genuinely
// memoizes. Two kinds of fixture:
//
//   1. A nonexistent path and a few garbage/text bytes — no real database
//      needed for these, per the task brief's own guidance.
//   2. The REAL DB-IP mmdb pair, downloaded via `pnpm geo:fetch` into
//      data/geoip (git-ignored, T0.1.1). This is the ONLY way to prove
//      openGeoDatabases() returns the identical object across calls —
//      garbage bytes can't construct a working Reader to compare, and a
//      hand-rolled fake MMDB buffer would test this file's own fixture
//      code, not the real maxmind Reader path the API depends on.
//
// The real-data tests do NOT skip when data/geoip is absent. They call
// assertRealGeoDataAvailable() first, which throws the same
// "run `pnpm geo:fetch`" guidance the production loader itself gives on a
// missing file — a quietly-skipped test here would read as coverage that
// isn't there, which is worse than a failing one (see T2.3.4's report for
// the fuller reasoning).

const REAL_GEOIP_DIR = join(process.cwd(), 'data', 'geoip');
const REAL_ASN_PATH = join(REAL_GEOIP_DIR, 'dbip-asn-lite.mmdb');
const REAL_COUNTRY_PATH = join(REAL_GEOIP_DIR, 'dbip-country-lite.mmdb');

function assertRealGeoDataAvailable(): void {
  if (existsSync(REAL_ASN_PATH) && existsSync(REAL_COUNTRY_PATH)) return;

  throw new Error(
    `This test needs the real DB-IP GeoIP databases. Run \`pnpm geo:fetch\` to download them ` +
      `into ${REAL_GEOIP_DIR} before running this suite.`,
  );
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'posta-geoip-test-'));
}

/** Captures the error a throwing function raises, failing the test (via
 * the thrown assertion) if it does not throw at all — every case in this
 * file expects a throw, so a silent non-throw is itself a failure, not an
 * absence of one to shrug past. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected fn to throw, but it completed without error');
}

afterEach(() => {
  resetGeoDatabases();
});

describe('createGeoDatabases (T2.3.4)', () => {
  describe('a missing GEOIP_DB_DIR path', () => {
    it('throws naming the exact path, the env var, and how to fix it — nothing else', () => {
      const dbDir = join(makeTempDir(), 'does-not-exist');
      const dbPath = join(dbDir, 'dbip-asn-lite.mmdb');

      const error = captureError(() => createGeoDatabases({ dbDir }));

      // Exact match, not a substring check: this is the strongest proof
      // the message leaks nothing beyond the path, the env var, and the
      // fix — any future addition (a stray env dump, a raw OS error
      // string, an unrelated directory listing) breaks this immediately.
      expect(error.message).toBe(
        `GeoIP ASN database not found or unreadable at "${dbPath}" (from GEOIP_DB_DIR). ` +
          `Run \`pnpm geo:fetch\` to download it, or check that GEOIP_DB_DIR points at the right directory.`,
      );
    });

    it('does not leak other env vars into the message', () => {
      const originalDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgres://someuser:supersecret@example.test:5432/db';

      try {
        const dbDir = join(makeTempDir(), 'does-not-exist');
        const error = captureError(() => createGeoDatabases({ dbDir }));

        expect(error.message).not.toContain('supersecret');
        expect(error.message).not.toContain('DATABASE_URL');
      } finally {
        if (originalDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = originalDatabaseUrl;
        }
      }
    });
  });

  describe('when GEOIP_DB_DIR itself is unset and no dbDir is passed', () => {
    it('throws naming GEOIP_DB_DIR', () => {
      const originalDir = process.env.GEOIP_DB_DIR;
      delete process.env.GEOIP_DB_DIR;

      try {
        const error = captureError(() => createGeoDatabases());
        expect(error.message).toContain('GEOIP_DB_DIR');
      } finally {
        if (originalDir === undefined) {
          delete process.env.GEOIP_DB_DIR;
        } else {
          process.env.GEOIP_DB_DIR = originalDir;
        }
      }
    });
  });

  describe('a truncated file (interrupted download)', () => {
    it('throws rather than returning a reader, distinctly from "missing"', () => {
      const dbDir = makeTempDir();
      // A handful of random-looking bytes: not empty (empty is its own
      // edge case a truncated download rarely produces), too short to
      // contain the MMDB metadata section, which mmdb-lib's Reader must
      // find or fail to parse.
      writeFileSync(join(dbDir, 'dbip-asn-lite.mmdb'), Buffer.from([0x1f, 0x8b, 0x00, 0x0a, 0xff, 0x00, 0x42]));

      const error = captureError(() => createGeoDatabases({ dbDir }));

      expect(error.message).toContain('not a valid MMDB file');
      expect(error.message).not.toContain('not found or unreadable');
    });
  });

  describe('a file that exists but is not an MMDB at all', () => {
    it('throws the same "invalid" error as a truncated file, not a "missing" one', () => {
      const dbDir = makeTempDir();
      writeFileSync(join(dbDir, 'dbip-asn-lite.mmdb'), 'this is a plain text file, not a database\n', 'utf8');

      const error = captureError(() => createGeoDatabases({ dbDir }));

      expect(error.message).toContain('not a valid MMDB file');
      expect(error.message).toContain('GEOIP_DB_DIR');
    });
  });

  describe('a directory that has only one of the two databases', () => {
    it('names ASN specifically when the ASN file is the one missing', () => {
      const dbDir = makeTempDir();
      // The country file is present (garbage content is fine — the ASN
      // read happens first and must fail before country is ever touched).
      writeFileSync(join(dbDir, 'dbip-country-lite.mmdb'), 'not a real database', 'utf8');

      const error = captureError(() => createGeoDatabases({ dbDir }));

      expect(error.message).toContain('ASN');
      expect(error.message).toContain('dbip-asn-lite.mmdb');
      expect(error.message).not.toContain('dbip-country-lite.mmdb');
    });

    it('names country specifically when the country file is the one missing', () => {
      assertRealGeoDataAvailable();
      const dbDir = makeTempDir();
      // A REAL, valid ASN file, so the ASN read succeeds and the failure
      // is unambiguously about the missing country file — a fake/garbage
      // ASN file would fail for the wrong reason before country is ever
      // reached, which would not test this case at all.
      writeFileSync(join(dbDir, 'dbip-asn-lite.mmdb'), readFileSync(REAL_ASN_PATH));

      const error = captureError(() => createGeoDatabases({ dbDir }));

      expect(error.message).toContain('country');
      expect(error.message).toContain('dbip-country-lite.mmdb');
      expect(error.message).not.toContain('dbip-asn-lite.mmdb');
    });
  });

  describe('with the real DB-IP databases', () => {
    beforeEach(() => {
      assertRealGeoDataAvailable();
    });

    it('returns a FRESH object on every call, never memoized', () => {
      const first = createGeoDatabases({ dbDir: REAL_GEOIP_DIR });
      const second = createGeoDatabases({ dbDir: REAL_GEOIP_DIR });

      expect(second).not.toBe(first);
    });

    it('returns a genuinely frozen object', () => {
      const readers = createGeoDatabases({ dbDir: REAL_GEOIP_DIR });

      expect(Object.isFrozen(readers)).toBe(true);
    });

    it('assigns the ASN reader and country reader to the correct keys, not swapped', () => {
      const readers = createGeoDatabases({ dbDir: REAL_GEOIP_DIR });

      expect(readers.asn.metadata.databaseType).toContain('ASN');
      expect(readers.country.metadata.databaseType).toContain('Country');
    });
  });
});

describe('openGeoDatabases (T2.3.4)', () => {
  beforeEach(() => {
    assertRealGeoDataAvailable();
  });

  it('returns the identical object on a second call', () => {
    const first = openGeoDatabases({ dbDir: REAL_GEOIP_DIR });
    const second = openGeoDatabases({ dbDir: REAL_GEOIP_DIR });

    expect(second).toBe(first);
  });

  it('ignores options passed after the first call, keeping the original memoized object', () => {
    const first = openGeoDatabases({ dbDir: REAL_GEOIP_DIR });
    const second = openGeoDatabases({ dbDir: join(makeTempDir(), 'irrelevant-after-first-call') });

    expect(second).toBe(first);
  });

  describe('after resetGeoDatabases()', () => {
    it('builds a brand new object on the next call', () => {
      const first = openGeoDatabases({ dbDir: REAL_GEOIP_DIR });
      resetGeoDatabases();
      const second = openGeoDatabases({ dbDir: REAL_GEOIP_DIR });

      expect(second).not.toBe(first);
    });
  });
});
