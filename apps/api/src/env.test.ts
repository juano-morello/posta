import { describe, expect, it } from 'vitest';
import { apiEnvSchema } from './env';

// T0.3.5 — the API's Zod env schema (S0.3). Built entirely from the
// isomorphic primitives contracts already exports (T0.3.2); this file
// only asserts the API-specific *selection and wiring* of those
// primitives, not the primitives' own behavior (that's
// packages/contracts/src/env.test.ts).
//
// Variable set per CLAUDE.md's api role (redirects, CRUD, auth, analytics,
// geo lookup at capture): domains, DATABASE_URL, REDIS_URL, all R2, GEOIP,
// all AUTH, API_PORT, NODE_ENV, LOG_LEVEL, LINK_CACHE_TTL_SECONDS,
// REDIS_LOOKUP_TIMEOUT_MS. NOT the worker's batch vars, NOT WEB_PORT —
// those belong to other apps' schemas.

const VALID_API_ENV: Record<string, string> = {
  POSTA_LINK_DOMAIN: 'example.test',
  POSTA_APP_SUBDOMAIN: 'app',
  POSTA_API_SUBDOMAIN: 'api',
  POSTA_PROTOCOL: 'https',
  POSTA_RESERVED_HANDLES: 'app,api,www',
  DATABASE_URL: 'postgresql://posta:posta@localhost:5432/posta',
  REDIS_URL: 'redis://localhost:6379',
  R2_ACCOUNT_ID: 'test-account-id',
  R2_ACCESS_KEY_ID: 'test-access-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
  R2_BUCKET_EVENTS: 'posta-events',
  R2_BUCKET_AVATARS: 'posta-avatars',
  R2_ENDPOINT: 'http://localhost:9000',
  GEOIP_DB_DIR: './data/geoip',
  BETTER_AUTH_SECRET: 'test-better-auth-secret',
  BETTER_AUTH_URL: 'https://app.example.test',
  SEED_USER_EMAIL: 'juano@example.test',
  SEED_USER_PASSWORD: 'test-seed-password',
  SEED_USER_HANDLE: 'juano',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  API_PORT: '3001',
  LINK_CACHE_TTL_SECONDS: '3600',
  REDIS_LOOKUP_TIMEOUT_MS: '30',
};

describe('apiEnvSchema', () => {
  it('parses a fully populated, valid env', () => {
    const result = apiEnvSchema.safeParse(VALID_API_ENV);

    expect(result.success).toBe(true);
  });

  it('coerces API_PORT and LINK_CACHE_TTL_SECONDS to numbers', () => {
    const result = apiEnvSchema.parse(VALID_API_ENV);

    expect(result.API_PORT).toBe(3001);
    expect(result.LINK_CACHE_TTL_SECONDS).toBe(3600);
  });

  it('parses POSTA_RESERVED_HANDLES into a string array', () => {
    const result = apiEnvSchema.parse(VALID_API_ENV);

    expect(result.POSTA_RESERVED_HANDLES).toEqual(['app', 'api', 'www']);
  });

  it('accepts an empty R2_ENDPOINT (production leaves it empty to use the R2 default)', () => {
    const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, R2_ENDPOINT: '' });

    expect(result.success).toBe(true);
  });

  it('rejects a non-empty, non-URL R2_ENDPOINT', () => {
    const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, R2_ENDPOINT: 'not-a-url' });

    expect(result.success).toBe(false);
  });

  it.each(Object.keys(VALID_API_ENV))(
    'produces a named error on schema for a missing %s',
    (missingKey) => {
      const rest = { ...VALID_API_ENV };
      delete rest[missingKey];
      const result = apiEnvSchema.safeParse(rest);

      expect(result.success).toBe(false);
      if (!result.success) {
        const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
        expect(failingPaths).toContain(missingKey);
      }
    },
  );

  it('rejects an invalid POSTA_PROTOCOL', () => {
    const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, POSTA_PROTOCOL: 'ftp' });

    expect(result.success).toBe(false);
  });

  it('rejects API_PORT out of range', () => {
    const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, API_PORT: '70000' });

    expect(result.success).toBe(false);
  });

  it('rejects a LOG_LEVEL that is not a recognized pino level', () => {
    const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, LOG_LEVEL: 'banana' });

    expect(result.success).toBe(false);
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])(
    'accepts LOG_LEVEL=%s',
    (level) => {
      const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, LOG_LEVEL: level });

      expect(result.success).toBe(true);
    },
  );

  it('does not include worker-only batch vars in its shape', () => {
    expect(apiEnvSchema.shape).not.toHaveProperty('EVENT_BATCH_SIZE');
    expect(apiEnvSchema.shape).not.toHaveProperty('EVENT_BATCH_INTERVAL_MS');
    expect(apiEnvSchema.shape).not.toHaveProperty('DATABASE_URL_WORKER');
  });

  it('does not include WEB_PORT in its shape', () => {
    expect(apiEnvSchema.shape).not.toHaveProperty('WEB_PORT');
  });

  // Security review findings (batch 5): SEED_USER_PASSWORD/SEED_USER_EMAIL
  // seed the ONE v1 administrative account (tenant_id == user_id, no
  // public signup — invariant 9), so this is the one credential that
  // gates the entire system. zNonEmpty alone (>=1 char, any string) was
  // too weak a boot-time check for the single field that matters most.
  it('rejects a SEED_USER_PASSWORD shorter than 12 characters', () => {
    const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, SEED_USER_PASSWORD: 'short1!' });

    expect(result.success).toBe(false);
  });

  it('accepts a SEED_USER_PASSWORD of exactly 12 characters', () => {
    const result = apiEnvSchema.safeParse({
      ...VALID_API_ENV,
      SEED_USER_PASSWORD: 'exactly12chr',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a SEED_USER_EMAIL that is not a valid email address', () => {
    const result = apiEnvSchema.safeParse({ ...VALID_API_ENV, SEED_USER_EMAIL: 'not-an-email' });

    expect(result.success).toBe(false);
  });

  it('accepts a well-formed SEED_USER_EMAIL', () => {
    const result = apiEnvSchema.safeParse({
      ...VALID_API_ENV,
      SEED_USER_EMAIL: 'juano@example.test',
    });

    expect(result.success).toBe(true);
  });
});
