import { describe, expect, it } from 'vitest';
import { SECRET_ENV_KEYS } from '@posta/contracts';
import { webPublicEnvSchema, webServerEnvSchema } from './env';

// T0.3.7 — web's Zod env schema (S0.3). Next.js splits env into
// server-only vars and NEXT_PUBLIC_ vars (inlined into the browser
// bundle at build time), so web's schema is split the same way:
// webServerEnvSchema for the server-only vars web needs (per CLAUDE.md's
// web role — WEB_PORT, NODE_ENV, REVALIDATE_SECRET, the domain vars
// needed to build bio/app URLs) and webPublicEnvSchema for the one
// browser-exposed var, NEXT_PUBLIC_API_URL. NOT DB, NOT R2, NOT the auth
// secret — web never touches the database directly (invariant 11: it
// reads bio data over HTTP from the API) and has no server-side secret
// beyond the revalidation webhook.
//
// The security assertion (decision 4 in the batch brief) is the point
// of this file: no secret-looking key may ever be declared under
// NEXT_PUBLIC_, checked against the SAME SECRET_ENV_KEYS set the loader
// uses (T0.3.8) plus a SECRET/PASSWORD/KEY/TOKEN name-pattern fallback,
// so a future `NEXT_PUBLIC_BETTER_AUTH_SECRET` fails this test even
// though BETTER_AUTH_SECRET was never itself added to web's schema.

const VALID_SERVER_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  WEB_PORT: '3000',
  REVALIDATE_SECRET: 'test-revalidate-secret',
  POSTA_LINK_DOMAIN: 'example.test',
  POSTA_PROTOCOL: 'https',
  POSTA_APP_SUBDOMAIN: 'app',
  POSTA_API_SUBDOMAIN: 'api',
};

const VALID_PUBLIC_ENV: Record<string, string> = {
  NEXT_PUBLIC_API_URL: 'https://api.example.test',
};

describe('webServerEnvSchema', () => {
  it('parses a fully populated, valid server env', () => {
    const result = webServerEnvSchema.safeParse(VALID_SERVER_ENV);

    expect(result.success).toBe(true);
  });

  it('coerces WEB_PORT to a number', () => {
    const result = webServerEnvSchema.parse(VALID_SERVER_ENV);

    expect(result.WEB_PORT).toBe(3000);
  });

  it.each(Object.keys(VALID_SERVER_ENV))(
    'produces a named error on schema for a missing %s',
    (missingKey) => {
      const rest = { ...VALID_SERVER_ENV };
      delete rest[missingKey];
      const result = webServerEnvSchema.safeParse(rest);

      expect(result.success).toBe(false);
      if (!result.success) {
        const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
        expect(failingPaths).toContain(missingKey);
      }
    },
  );

  it('does not include DATABASE_URL — web never touches Postgres directly', () => {
    expect(webServerEnvSchema.shape).not.toHaveProperty('DATABASE_URL');
  });

  it('does not include any R2 vars', () => {
    expect(webServerEnvSchema.shape).not.toHaveProperty('R2_ACCESS_KEY_ID');
    expect(webServerEnvSchema.shape).not.toHaveProperty('R2_SECRET_ACCESS_KEY');
  });

  it('does not include BETTER_AUTH_SECRET', () => {
    expect(webServerEnvSchema.shape).not.toHaveProperty('BETTER_AUTH_SECRET');
  });
});

describe('webPublicEnvSchema', () => {
  it('parses a valid NEXT_PUBLIC_API_URL', () => {
    const result = webPublicEnvSchema.safeParse(VALID_PUBLIC_ENV);

    expect(result.success).toBe(true);
  });

  it('rejects a missing NEXT_PUBLIC_API_URL', () => {
    const result = webPublicEnvSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it('rejects a non-URL NEXT_PUBLIC_API_URL', () => {
    const result = webPublicEnvSchema.safeParse({ NEXT_PUBLIC_API_URL: 'not-a-url' });

    expect(result.success).toBe(false);
  });
});

describe('no secret-looking key under NEXT_PUBLIC_ (security)', () => {
  const publicKeys = Object.keys(webPublicEnvSchema.shape);
  const secretNamePattern = /SECRET|PASSWORD|KEY|TOKEN/i;

  it('declares at least one public key, so this assertion is not vacuous', () => {
    expect(publicKeys.length).toBeGreaterThan(0);
  });

  it.each(publicKeys)('%s is not in the shared secret-key set', (key) => {
    expect(SECRET_ENV_KEYS).not.toContain(key);
  });

  it.each(publicKeys)('%s does not match a SECRET/PASSWORD/KEY/TOKEN name pattern', (key) => {
    expect(secretNamePattern.test(key)).toBe(false);
  });

  it('fails if a secret-shaped key is added to the public schema (regression proof)', () => {
    const withLeakedSecret = { ...webPublicEnvSchema.shape, NEXT_PUBLIC_BETTER_AUTH_SECRET: true };
    const leakedKeys = Object.keys(withLeakedSecret);
    const hasLeak = leakedKeys.some(
      (key) => SECRET_ENV_KEYS.includes(key) || secretNamePattern.test(key),
    );

    expect(hasLeak).toBe(true);
  });
});
