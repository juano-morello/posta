import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  formatEnvFailures,
  loadEnv,
  redactSecrets,
  SECRET_ENV_KEYS,
  zBooleanish,
  zCsvList,
  zNonEmpty,
  zPort,
  zUrl,
} from './env';

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

// loadEnv/formatEnvFailures (T0.3.8) — the shared fail-fast loader. Pure
// and isomorphic: never reads process.env itself (the raw record is an
// argument), never process.exit()s, never console.logs. Callers (each
// app's main.ts) own the side effects; this module only ever returns
// data or a string.
describe('loadEnv', () => {
  const schema = z.object({
    REQUIRED_URL: zUrl,
    REQUIRED_PORT: zPort,
    OPTIONAL_ISH: zNonEmpty,
  });

  it('returns ok:true with the parsed data on a fully valid record', () => {
    const result = loadEnv(schema, {
      REQUIRED_URL: 'https://example.test',
      REQUIRED_PORT: '3001',
      OPTIONAL_ISH: 'present',
    });

    expect(result).toEqual({
      ok: true,
      data: {
        REQUIRED_URL: 'https://example.test',
        REQUIRED_PORT: 3001,
        OPTIONAL_ISH: 'present',
      },
    });
  });

  it('reports every missing key at once, not just the first', () => {
    const result = loadEnv(schema, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const keys = result.failures.map((f) => f.key).sort();
    expect(keys).toEqual(['OPTIONAL_ISH', 'REQUIRED_PORT', 'REQUIRED_URL']);
    expect(result.failures.every((f) => f.reason === 'missing')).toBe(true);
  });

  it('distinguishes "missing" (key absent/empty) from "invalid" (key present but malformed)', () => {
    const result = loadEnv(schema, {
      REQUIRED_URL: 'not-a-url',
      REQUIRED_PORT: '99999',
      OPTIONAL_ISH: 'present',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byKey = Object.fromEntries(result.failures.map((f) => [f.key, f.reason]));
    expect(byKey.REQUIRED_URL).toBe('invalid');
    expect(byKey.REQUIRED_PORT).toBe('invalid');
  });

  it('treats an empty-string value the same as a missing key', () => {
    const result = loadEnv(schema, {
      REQUIRED_URL: 'https://example.test',
      REQUIRED_PORT: '3001',
      OPTIONAL_ISH: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toEqual([{ key: 'OPTIONAL_ISH', reason: 'missing' }]);
  });

  it('never reads process.env itself — an unrelated real env var does not leak into a passing result', () => {
    const originalValue = process.env.LOADENV_ISOMORPHIC_PROBE;
    process.env.LOADENV_ISOMORPHIC_PROBE = 'should-be-invisible';
    try {
      const result = loadEnv(schema, {
        REQUIRED_URL: 'https://example.test',
        REQUIRED_PORT: '3001',
        OPTIONAL_ISH: 'present',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).not.toHaveProperty('LOADENV_ISOMORPHIC_PROBE');
    } finally {
      if (originalValue === undefined) delete process.env.LOADENV_ISOMORPHIC_PROBE;
      else process.env.LOADENV_ISOMORPHIC_PROBE = originalValue;
    }
  });

  it('never includes a failing value anywhere in its output, secret or not', () => {
    const result = loadEnv(schema, {
      REQUIRED_URL: 'this-is-not-a-url-but-contains-hunter2-a-fake-secret',
      REQUIRED_PORT: '3001',
      OPTIONAL_ISH: 'present',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialized = JSON.stringify(result.failures);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('this-is-not-a-url');
  });
});

describe('formatEnvFailures', () => {
  it('names every failing key on its own line', () => {
    const output = formatEnvFailures([
      { key: 'DATABASE_URL', reason: 'missing' },
      { key: 'API_PORT', reason: 'invalid' },
    ]);

    expect(output).toContain('DATABASE_URL: missing');
    expect(output).toContain('API_PORT: invalid');
  });

  it('never echoes a value — only the shape {key, reason} strings ever reach the formatter', () => {
    // formatEnvFailures's own type signature (EnvFailure[]) makes a raw
    // value structurally impossible to pass in; this asserts the
    // *output* stays confined to what a caller who only has {key,
    // reason} pairs could ever produce, i.e. no hidden interpolation of
    // anything beyond those two fields.
    const output = formatEnvFailures([{ key: 'BETTER_AUTH_SECRET', reason: 'missing' }]);

    expect(output).toBe(
      [
        'Invalid environment configuration. Fix these variables before starting:',
        '  - BETTER_AUTH_SECRET: missing',
      ].join('\n'),
    );
  });
});

describe('redactSecrets', () => {
  it('replaces every SECRET_ENV_KEYS value with a placeholder, leaving others untouched', () => {
    const parsed = {
      DATABASE_URL: 'postgresql://posta:realpassword@prod-db/posta',
      API_PORT: 3001,
      LOG_LEVEL: 'info',
    };

    const redacted = redactSecrets(parsed);

    expect(redacted.DATABASE_URL).not.toBe(parsed.DATABASE_URL);
    expect(redacted.DATABASE_URL).not.toContain('realpassword');
    expect(redacted.API_PORT).toBe(3001);
    expect(redacted.LOG_LEVEL).toBe('info');
  });

  it('accepts a custom secret-key set instead of the default', () => {
    const redacted = redactSecrets({ CUSTOM_TOKEN: 'abc123', OTHER: 'kept' }, ['CUSTOM_TOKEN']);

    expect(redacted.CUSTOM_TOKEN).not.toBe('abc123');
    expect(redacted.OTHER).toBe('kept');
  });

  it('does not mutate the input object (immutability)', () => {
    const parsed = { BETTER_AUTH_SECRET: 'super-secret-value' };
    redactSecrets(parsed);

    expect(parsed.BETTER_AUTH_SECRET).toBe('super-secret-value');
  });
});
