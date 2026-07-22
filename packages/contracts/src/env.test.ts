import { describe, expect, it } from 'vitest';
import { SECRET_ENV_KEYS, zBooleanish, zCsvList, zNonEmpty, zPort, zUrl } from './env';

// These are pure Zod schemas (T0.3.2) — no process.env access, so they can
// be exercised directly with literal strings the way an app's env schema
// would feed them a raw process.env value.

describe('zPort', () => {
  it('coerces a numeric string into a port number', () => {
    expect(zPort.parse('3001')).toBe(3001);
  });

  it('accepts the boundary values 1 and 65535', () => {
    expect(zPort.parse('1')).toBe(1);
    expect(zPort.parse('65535')).toBe(65535);
  });

  it('rejects 0', () => {
    expect(() => zPort.parse('0')).toThrow();
  });

  it('rejects a port above 65535', () => {
    expect(() => zPort.parse('65536')).toThrow();
  });

  it('rejects a non-integer port', () => {
    expect(() => zPort.parse('3001.5')).toThrow();
  });

  it('rejects a non-numeric string', () => {
    expect(() => zPort.parse('not-a-port')).toThrow();
  });

  it('rejects a negative port', () => {
    expect(() => zPort.parse('-1')).toThrow();
  });
});

describe('zUrl', () => {
  it('accepts a well-formed https URL', () => {
    expect(zUrl.parse('https://example.test')).toBe('https://example.test');
  });

  it('accepts a well-formed http URL', () => {
    expect(zUrl.parse('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('rejects a non-URL string', () => {
    expect(() => zUrl.parse('not a url')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => zUrl.parse('')).toThrow();
  });
});

describe('zNonEmpty', () => {
  it('accepts a non-empty string', () => {
    expect(zNonEmpty.parse('hello')).toBe('hello');
  });

  it('trims surrounding whitespace', () => {
    expect(zNonEmpty.parse('  hello  ')).toBe('hello');
  });

  it('rejects an empty string', () => {
    expect(() => zNonEmpty.parse('')).toThrow();
  });

  it('rejects a whitespace-only string', () => {
    expect(() => zNonEmpty.parse('   ')).toThrow();
  });
});

describe('zBooleanish', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('parses %s as %s', (input, expected) => {
    expect(zBooleanish.parse(input)).toBe(expected);
  });

  it('tolerates surrounding whitespace', () => {
    expect(zBooleanish.parse('  true  ')).toBe(true);
  });

  it('rejects an unrecognized value', () => {
    expect(() => zBooleanish.parse('maybe')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => zBooleanish.parse('')).toThrow();
  });
});

describe('zCsvList', () => {
  it('splits a comma-separated string into entries', () => {
    expect(zCsvList.parse('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace around entries', () => {
    expect(zCsvList.parse(' a , b ,c ')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty entries produced by a trailing comma', () => {
    expect(zCsvList.parse('a,b,')).toEqual(['a', 'b']);
  });

  it('drops empty entries produced by repeated commas', () => {
    expect(zCsvList.parse('a,,b')).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty string', () => {
    expect(zCsvList.parse('')).toEqual([]);
  });

  it('returns a single-item array for a value with no commas', () => {
    expect(zCsvList.parse('solo')).toEqual(['solo']);
  });
});

// SECRET_ENV_KEYS (T0.3.7/T0.3.8) is the single declared set of
// secret-shaped env key names — the one source of truth decision 3 in
// the batch brief calls for. web's NEXT_PUBLIC_ leak assertion (T0.3.7)
// and the fail-fast loader's redaction (T0.3.8) both read this SAME
// array rather than keeping two lists that could drift apart. Declared
// here, in contracts, one task earlier than the loader itself lands,
// because T0.3.7 needs it too.
describe('SECRET_ENV_KEYS', () => {
  it('is a frozen, non-empty array', () => {
    expect(Array.isArray(SECRET_ENV_KEYS)).toBe(true);
    expect(SECRET_ENV_KEYS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(SECRET_ENV_KEYS)).toBe(true);
  });

  it('contains exactly the nine secret-shaped keys named in .env.example', () => {
    expect([...SECRET_ENV_KEYS].sort()).toEqual(
      [
        'DATABASE_URL',
        'DATABASE_URL_WORKER',
        'REDIS_URL',
        'R2_ACCOUNT_ID',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'BETTER_AUTH_SECRET',
        'SEED_USER_PASSWORD',
        'REVALIDATE_SECRET',
      ].sort(),
    );
  });
});
