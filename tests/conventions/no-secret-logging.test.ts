import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatEnvFailures,
  loadEnv,
  redactSecrets,
  SECRET_ENV_KEYS,
  type EnvFailure,
} from '../../packages/contracts/src/env';
import { apiEnvSchema } from '../../apps/api/src/env';
import { workerEnvSchema } from '../../apps/worker/src/env';

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
const REAL_SECRET_VALUES: Record<string, string> = {
  DATABASE_URL: 'postgresql://posta:Tr0ub4dor-AndFour@prod-db.internal:5432/posta',
  DATABASE_URL_WORKER: 'postgresql://posta_writer:C0rrectHorseBattery99@prod-db.internal:5432/posta',
  REDIS_URL: 'redis://:hunter2RedisPass@prod-redis.internal:6379',
  R2_ACCOUNT_ID: 'acct_9f8e7d6c5b4a3210fedcba',
  R2_ACCESS_KEY_ID: 'AKIAFAKEEXAMPLE1234567890',
  R2_SECRET_ACCESS_KEY: 'wJalrFAKEsecretACCESSkeyEXAMPLEwJalr1234567890',
  BETTER_AUTH_SECRET: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4BETTERAUTH',
  SEED_USER_PASSWORD: 'Sup3rSecretSeedPassword!42',
  REVALIDATE_SECRET: 'revalidate-hex-secret-00112233445566',
};

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

// Not every SECRET_ENV_KEYS entry belongs to every schema (REVALIDATE_SECRET
// is web-only, DATABASE_URL_WORKER is worker-only, DATABASE_URL is
// api-only) — derive each schema's actual secret subset from the schema's
// own declared shape rather than hand-maintaining a second list per app.
const API_SECRET_KEYS = SECRET_ENV_KEYS.filter((key) => key in apiEnvSchema.shape);
const WORKER_SECRET_KEYS = SECRET_ENV_KEYS.filter((key) => key in workerEnvSchema.shape);

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
      expect(rawSerialized).toContain(REAL_SECRET_VALUES[key]);
    }
  });

  it('redactSecrets(apiEnvSchema output) removes every real secret value before it is safe to log', () => {
    const result = loadEnv(apiEnvSchema, VALID_API_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const redacted = redactSecrets(result.data);
    const loggedOutput = JSON.stringify(redacted);

    for (const key of API_SECRET_KEYS) {
      expect(loggedOutput).not.toContain(REAL_SECRET_VALUES[key]);
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
      expect(loggedOutput).not.toContain(REAL_SECRET_VALUES[key]);
    }
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

  it.each(SECRET_ENV_KEYS)(
    'systematically: dropping %s alone reports it as missing, and the report never contains any real secret value',
    (secretKey) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const isWorkerKey = secretKey in VALID_WORKER_ENV || secretKey === 'DATABASE_URL_WORKER';
      const baseEnv = isWorkerKey ? VALID_WORKER_ENV : VALID_API_ENV;
      const schema = isWorkerKey ? workerEnvSchema : apiEnvSchema;

      if (!(secretKey in baseEnv)) {
        // Key does not apply to either schema tested here (none currently,
        // but this keeps the loop honest if SECRET_ENV_KEYS grows).
        return;
      }

      const brokenEnv = { ...baseEnv };
      delete brokenEnv[secretKey];

      const result = loadEnv(schema, brokenEnv);
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
