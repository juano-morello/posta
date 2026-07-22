import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  formatEnvFailures,
  loadEnv,
  redactSecrets,
  SECRET_ENV_KEYS,
  type EnvFailure,
} from '../../packages/contracts/src/env';
import { apiEnvSchema } from '../../apps/api/src/env';
import { workerEnvSchema } from '../../apps/worker/src/env';
import { webServerEnvSchema } from '../../apps/web/src/env';

// T0.3.10 — secrets never reach logs (S0.3, acceptance criterion 2). A
// prior story in this epic shipped "guard" tests that only exercised
// the easy, already-passing case and never proved the guard actually
// fires — see tests/conventions/no-literal-domain.test.ts's own header
// for that lesson applied to a different guard. This file applies the
// same discipline here: every test below drives the REAL loadEnv,
// formatEnvFailures, and redactSecrets from contracts, against the REAL
// apiEnvSchema/workerEnvSchema apps/api and apps/worker actually boot
// with (T0.3.5/T0.3.6), using REALISTIC secret values — not empty
// strings, not mocks — and then greps the actual captured output
// (whatever main.ts would hand to console.error, or whatever a
// startup debug log would hand to console.log) for those exact
// values. Nothing here asserts against a stub standing in for the
// loader; the loader is the thing under test.
//
// Two paths are covered, both required by the acceptance criterion:
//   1. The success path — a fully valid env, redacted before it would
//      ever be safe to log (redactSecrets).
//   2. A deliberately-triggered error path — a genuinely invalid env
//      (some required key missing or malformed) that makes loadEnv
//      report real failures, formatted by formatEnvFailures exactly as
//      main.ts formats them, and printed through console.error exactly
//      as main.ts prints them.

// Realistic-looking secret values, distinct enough to grep for
// unambiguously — not the kind of short/generic string that could
// accidentally collide with legitimate output like a key name or the
// word "missing".
// `satisfies` (not `: Record<string, string>`) keeps the inferred type as
// the precise object literal — each key a known, always-present property —
// rather than widening to a plain index signature. Under this repo's
// noUncheckedIndexedAccess, a widened Record<string, string> would make
// every access below (even the literal, known-to-exist ones like
// `.DATABASE_URL`) type as `string | undefined`; `satisfies` still
// verifies every value is a string, it just doesn't erase the specific
// keys while doing so. `secretValue()` below covers the few call sites
// that need a genuinely dynamic key instead.
const REAL_SECRET_VALUES = {
  DATABASE_URL: 'postgresql://posta:Tr0ub4dor-AndFour@prod-db.internal:5432/posta',
  DATABASE_URL_WORKER: 'postgresql://posta_writer:C0rrectHorseBattery99@prod-db.internal:5432/posta',
  REDIS_URL: 'redis://:hunter2RedisPass@prod-redis.internal:6379',
  R2_ACCOUNT_ID: 'acct_9f8e7d6c5b4a3210fedcba',
  R2_ACCESS_KEY_ID: 'AKIAFAKEEXAMPLE1234567890',
  R2_SECRET_ACCESS_KEY: 'wJalrFAKEsecretACCESSkeyEXAMPLEwJalr1234567890',
  BETTER_AUTH_SECRET: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4BETTERAUTH',
  SEED_USER_PASSWORD: 'Sup3rSecretSeedPassword!42',
  REVALIDATE_SECRET: 'revalidate-hex-secret-00112233445566',
} satisfies Record<string, string>;

/** REAL_SECRET_VALUES indexed by a KEY COMPUTED at runtime (e.g. from
 * SECRET_ENV_KEYS, typed as a general `readonly string[]`) rather than one
 * of its own known literal properties. Fails loudly — same "don't assume,
 * assert" discipline as the TESTED_SCHEMAS coverage guard below — if a key
 * this file iterates over ever has no fixture value, instead of silently
 * reading `undefined` and letting a `.toContain(undefined)` assertion pass
 * or fail for the wrong reason. */
function secretValue(key: string): string {
  const value = (REAL_SECRET_VALUES as Record<string, string>)[key];
  if (value === undefined) {
    throw new Error(
      `REAL_SECRET_VALUES has no fixture value for "${key}" — add one before testing it.`,
    );
  }
  return value;
}

const VALID_API_ENV: Record<string, string> = {
  POSTA_LINK_DOMAIN: 'example.test',
  POSTA_APP_SUBDOMAIN: 'app',
  POSTA_API_SUBDOMAIN: 'api',
  POSTA_PROTOCOL: 'https',
  POSTA_RESERVED_HANDLES: 'app,api,www',
  DATABASE_URL: REAL_SECRET_VALUES.DATABASE_URL,
  REDIS_URL: REAL_SECRET_VALUES.REDIS_URL,
  R2_ACCOUNT_ID: REAL_SECRET_VALUES.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: REAL_SECRET_VALUES.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: REAL_SECRET_VALUES.R2_SECRET_ACCESS_KEY,
  R2_BUCKET_EVENTS: 'posta-events',
  R2_BUCKET_AVATARS: 'posta-avatars',
  R2_ENDPOINT: 'http://localhost:9000',
  GEOIP_DB_DIR: './data/geoip',
  BETTER_AUTH_SECRET: REAL_SECRET_VALUES.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: 'https://app.example.test',
  SEED_USER_EMAIL: 'juano@example.test',
  SEED_USER_PASSWORD: REAL_SECRET_VALUES.SEED_USER_PASSWORD,
  SEED_USER_HANDLE: 'juano',
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  API_PORT: '3001',
  LINK_CACHE_TTL_SECONDS: '3600',
};

const VALID_WORKER_ENV: Record<string, string> = {
  DATABASE_URL_WORKER: REAL_SECRET_VALUES.DATABASE_URL_WORKER,
  REDIS_URL: REAL_SECRET_VALUES.REDIS_URL,
  R2_ACCOUNT_ID: REAL_SECRET_VALUES.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: REAL_SECRET_VALUES.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: REAL_SECRET_VALUES.R2_SECRET_ACCESS_KEY,
  R2_BUCKET_EVENTS: 'posta-events',
  R2_ENDPOINT: 'http://localhost:9000',
  WORKER_PORT: '3002',
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  EVENT_BATCH_SIZE: '100',
  EVENT_BATCH_INTERVAL_MS: '2000',
};

// webServerEnvSchema is exercised directly here (loadEnv + the schema),
// the same way api/worker are — this does NOT require wiring web into a
// runtime (T0.3.8 deliberately scoped main.ts wiring to api/worker only);
// it only requires the schema, which T0.3.7 already built and tested.
const VALID_WEB_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  WEB_PORT: '3000',
  REVALIDATE_SECRET: REAL_SECRET_VALUES.REVALIDATE_SECRET,
  POSTA_LINK_DOMAIN: 'example.test',
  POSTA_PROTOCOL: 'https',
  POSTA_APP_SUBDOMAIN: 'app',
  POSTA_API_SUBDOMAIN: 'api',
};

// Not every SECRET_ENV_KEYS entry belongs to every schema (REVALIDATE_SECRET
// is web-only, DATABASE_URL_WORKER is worker-only, DATABASE_URL is
// api-only) — derive each schema's actual secret subset from the schema's
// own declared shape rather than hand-maintaining a second list per app.
const API_SECRET_KEYS = SECRET_ENV_KEYS.filter((key) => key in apiEnvSchema.shape);
const WORKER_SECRET_KEYS = SECRET_ENV_KEYS.filter((key) => key in workerEnvSchema.shape);
const WEB_SECRET_KEYS = SECRET_ENV_KEYS.filter((key) => key in webServerEnvSchema.shape);

// Every schema this file actually exercises, in one place — both the
// success-path tests and the systematic error-path loop below read from
// this single list, so adding a fourth tested schema later means editing
// one array, not every test that iterates SECRET_ENV_KEYS.
//
// `schema: ZodTypeAny` (not the three schemas' own inferred literal
// types): without it, TS infers TESTED_SCHEMAS as an array of three
// DIFFERENT object shapes, and `covering.schema` below becomes a union of
// three distinct ZodObject types — passing that union into loadEnv<T>'s
// `schema: z.ZodType<T>` parameter fails to unify under this repo's
// exactOptionalPropertyTypes. ZodTypeAny is Zod's own escape hatch for
// exactly this "heterogeneous collection of schemas" case.
const TESTED_SCHEMAS: { baseEnv: Record<string, string>; schema: ZodTypeAny }[] = [
  { baseEnv: VALID_API_ENV, schema: apiEnvSchema },
  { baseEnv: VALID_WORKER_ENV, schema: workerEnvSchema },
  { baseEnv: VALID_WEB_ENV, schema: webServerEnvSchema },
];

/** Simulates exactly what apps/api|worker's main.ts does on a load failure. */
function printFailuresLikeMainTs(failures: readonly EnvFailure[]): void {
  console.error(formatEnvFailures(failures));
}

describe('secrets never reach logs (success path — redaction before logging)', () => {
  it('SECRET_ENV_KEYS actually names 9 keys, so this test is not vacuous', () => {
    expect(SECRET_ENV_KEYS.length).toBe(9);
  });

  it('a real parsed apiEnvSchema config genuinely contains every real secret value (sanity check)', () => {
    const result = loadEnv(apiEnvSchema, VALID_API_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rawSerialized = JSON.stringify(result.data);
    for (const key of API_SECRET_KEYS) {
      expect(rawSerialized).toContain(secretValue(key));
    }
  });

  it('redactSecrets(apiEnvSchema output) removes every real secret value before it is safe to log', () => {
    const result = loadEnv(apiEnvSchema, VALID_API_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactSecrets(result.data);
    const loggedOutput = JSON.stringify(redacted);

    for (const key of API_SECRET_KEYS) {
      expect(loggedOutput).not.toContain(secretValue(key));
    }
    // And the keys are still present, just redacted — proving this is
    // real redaction, not accidental key omission.
    expect(loggedOutput).toContain('DATABASE_URL');
    expect(loggedOutput).toContain('[REDACTED]');
  });

  it('redactSecrets(workerEnvSchema output) removes DATABASE_URL_WORKER and REDIS_URL', () => {
    const result = loadEnv(workerEnvSchema, VALID_WORKER_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactSecrets(result.data);
    const loggedOutput = JSON.stringify(redacted);

    expect(WORKER_SECRET_KEYS).toEqual(
      expect.arrayContaining(['DATABASE_URL_WORKER', 'REDIS_URL']),
    );
    for (const key of WORKER_SECRET_KEYS) {
      expect(loggedOutput).not.toContain(secretValue(key));
    }
  });

  it('redactSecrets(webServerEnvSchema output) removes REVALIDATE_SECRET', () => {
    const result = loadEnv(webServerEnvSchema, VALID_WEB_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Sanity check first (the earlier-flagged lesson: prove the
    // PRE-redaction data genuinely contains the secret, so this isn't
    // silently checking against something that was never there).
    const rawSerialized = JSON.stringify(result.data);
    expect(WEB_SECRET_KEYS).toEqual(['REVALIDATE_SECRET']);
    for (const key of WEB_SECRET_KEYS) {
      expect(rawSerialized).toContain(secretValue(key));
    }

    const redacted = redactSecrets(result.data);
    const loggedOutput = JSON.stringify(redacted);

    for (const key of WEB_SECRET_KEYS) {
      expect(loggedOutput).not.toContain(secretValue(key));
    }
    expect(loggedOutput).toContain('REVALIDATE_SECRET');
    expect(loggedOutput).toContain('[REDACTED]');
  });
});

describe('secrets never reach logs (error path — deliberately invalid env)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a fully missing env reports every required key as missing, with no values to leak', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = loadEnv(apiEnvSchema, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    printFailuresLikeMainTs(result.failures);

    const capturedOutput = errorSpy.mock.calls.flat().join('\n');
    expect(capturedOutput).toContain('DATABASE_URL: missing');
    expect(capturedOutput).toContain('BETTER_AUTH_SECRET: missing');
    // No real secret value exists in this scenario to check for — the
    // point of THIS case is that "missing" never has a value to leak in
    // the first place. The malformed-but-present case below is where a
    // real leak risk actually lives.
  });

  it('a malformed-but-present DATABASE_URL never leaks its value, while still naming the key', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const injectedSecret = 'CorrectHorseBatteryStaple-not-actually-a-url-99';
    const brokenEnv = { ...VALID_API_ENV, DATABASE_URL: `this is not a url at all ${injectedSecret}` };

    const result = loadEnv(apiEnvSchema, brokenEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    printFailuresLikeMainTs(result.failures);

    const capturedOutput = errorSpy.mock.calls.flat().join('\n');
    expect(capturedOutput).toContain('DATABASE_URL: invalid');
    expect(capturedOutput).not.toContain(injectedSecret);
    // Every OTHER real secret in this same env is untouched too — the
    // failure of one key must not somehow spill a sibling's value.
    for (const [key, value] of Object.entries(REAL_SECRET_VALUES)) {
      if (key === 'DATABASE_URL' || key === 'DATABASE_URL_WORKER') continue;
      expect(capturedOutput).not.toContain(value);
    }
  });

  it('a malformed-but-present REDIS_URL never leaks its value', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const injectedSecret = 'hunter2RedisPass-embedded-not-a-url';
    const brokenEnv = { ...VALID_API_ENV, REDIS_URL: `this is not a url at all ${injectedSecret}` };

    const result = loadEnv(apiEnvSchema, brokenEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    printFailuresLikeMainTs(result.failures);

    const capturedOutput = errorSpy.mock.calls.flat().join('\n');
    expect(capturedOutput).toContain('REDIS_URL: invalid');
    expect(capturedOutput).not.toContain(injectedSecret);
  });

  it('a malformed-but-present DATABASE_URL_WORKER never leaks its value (worker schema)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const injectedSecret = 'writer-role-password-embedded-C0rrectHorse';
    const brokenEnv = {
      ...VALID_WORKER_ENV,
      DATABASE_URL_WORKER: `this is not a url at all ${injectedSecret}`,
    };

    const result = loadEnv(workerEnvSchema, brokenEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    printFailuresLikeMainTs(result.failures);

    const capturedOutput = errorSpy.mock.calls.flat().join('\n');
    expect(capturedOutput).toContain('DATABASE_URL_WORKER: invalid');
    expect(capturedOutput).not.toContain(injectedSecret);
  });

  it('a broken WEB_PORT never leaks the real, present REVALIDATE_SECRET value, while still naming the failing key', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // REVALIDATE_SECRET stays populated with its REAL value here — the
    // failure is triggered by an unrelated field (WEB_PORT), which is
    // exactly the sibling-key-leak scenario the acceptance criterion
    // ("secrets never logged, including error paths") is about: one
    // field failing must never spill an untouched sibling's value.
    const brokenEnv = { ...VALID_WEB_ENV, WEB_PORT: 'not-a-port' };

    const result = loadEnv(webServerEnvSchema, brokenEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    printFailuresLikeMainTs(result.failures);

    const capturedOutput = errorSpy.mock.calls.flat().join('\n');
    expect(capturedOutput).toContain('WEB_PORT: invalid');
    expect(capturedOutput).not.toContain(REAL_SECRET_VALUES.REVALIDATE_SECRET);
  });

  it.each(SECRET_ENV_KEYS)(
    'systematically: dropping %s alone reports it as missing, and the report never contains any real secret value',
    (secretKey) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      // Find whichever tested schema actually declares this key. This is
      // the coverage guard: the whole point of iterating SECRET_ENV_KEYS
      // (rather than a hand-picked subset) is that adding a new key to
      // that frozen set should force new test coverage here. An earlier
      // version of this loop silently `return`ed when no schema covered a
      // key — Vitest recorded that as a PASSING test that asserted
      // nothing, which is exactly how REVALIDATE_SECRET went unexercised
      // despite this loop including it. Fail loudly instead: a future
      // secret added to SECRET_ENV_KEYS with no schema wired into
      // TESTED_SCHEMAS now breaks this test until coverage is added,
      // rather than passing green while proving nothing.
      const covering = TESTED_SCHEMAS.find((tested) => secretKey in tested.baseEnv);
      if (!covering) {
        expect.fail(
          `SECRET_ENV_KEYS contains "${secretKey}" but no tested schema in ` +
            'TESTED_SCHEMAS exercises it — add it to a VALID_*_ENV fixture ' +
            'above (or add a new tested schema) before this can pass.',
        );
        return;
      }

      const brokenEnv = { ...covering.baseEnv };
      delete brokenEnv[secretKey];

      const result = loadEnv(covering.schema, brokenEnv);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      printFailuresLikeMainTs(result.failures);

      const capturedOutput = errorSpy.mock.calls.flat().join('\n');
      expect(capturedOutput).toContain(`${secretKey}: missing`);

      for (const value of Object.values(REAL_SECRET_VALUES)) {
        expect(capturedOutput).not.toContain(value);
      }
    },
  );
});
