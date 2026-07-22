import { describe, expect, it } from 'vitest';
import { workerEnvSchema } from './env';

// T0.3.6 — the worker's Zod env schema (S0.3). The worker is a BullMQ
// consumer that drains Redis, enriches, and writes events to Postgres
// *and* R2 (invariant 7) — it does NOT classify (invariant 4) and it
// deliberately gets no geo config (invariant 6: geo lookup happens in
// the API at capture, before the IP is dropped; T0.7.10 keeps the
// worker without an ASN/country reader on purpose).
//
// It connects to Postgres as the writer role via DATABASE_URL_WORKER —
// a distinct variable from the API's reader-role DATABASE_URL — even
// though the privilege separation itself (a DB role with no SELECT on
// raw `events`) doesn't land until T4.2.4. The split is wired now so it
// only needs a value change later, not a schema change.

const VALID_WORKER_ENV: Record<string, string> = {
  DATABASE_URL_WORKER: 'postgresql://posta:posta@localhost:5432/posta',
  REDIS_URL: 'redis://localhost:6379',
  R2_ACCOUNT_ID: 'test-account-id',
  R2_ACCESS_KEY_ID: 'test-access-key-id',
  R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
  R2_BUCKET_EVENTS: 'posta-events',
  R2_ENDPOINT: 'http://localhost:9000',
  WORKER_PORT: '3002',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  EVENT_BATCH_SIZE: '100',
  EVENT_BATCH_INTERVAL_MS: '2000',
};

describe('workerEnvSchema', () => {
  it('parses a fully populated, valid env', () => {
    const result = workerEnvSchema.safeParse(VALID_WORKER_ENV);

    expect(result.success).toBe(true);
  });

  it('coerces WORKER_PORT, EVENT_BATCH_SIZE and EVENT_BATCH_INTERVAL_MS to numbers', () => {
    const result = workerEnvSchema.parse(VALID_WORKER_ENV);

    expect(result.WORKER_PORT).toBe(3002);
    expect(result.EVENT_BATCH_SIZE).toBe(100);
    expect(result.EVENT_BATCH_INTERVAL_MS).toBe(2000);
  });

  it('accepts an empty R2_ENDPOINT (production leaves it empty to use the R2 default)', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, R2_ENDPOINT: '' });

    expect(result.success).toBe(true);
  });

  it('rejects a non-empty, non-URL R2_ENDPOINT', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, R2_ENDPOINT: 'not-a-url' });

    expect(result.success).toBe(false);
  });

  it.each(Object.keys(VALID_WORKER_ENV))(
    'produces a named error on schema for a missing %s',
    (missingKey) => {
      const rest = { ...VALID_WORKER_ENV };
      delete rest[missingKey];
      const result = workerEnvSchema.safeParse(rest);

      expect(result.success).toBe(false);
      if (!result.success) {
        const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
        expect(failingPaths).toContain(missingKey);
      }
    },
  );

  it('rejects EVENT_BATCH_SIZE that is not a positive integer', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, EVENT_BATCH_SIZE: '0' });

    expect(result.success).toBe(false);
  });

  it('rejects a LOG_LEVEL that is not a recognized pino level', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, LOG_LEVEL: 'banana' });

    expect(result.success).toBe(false);
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])(
    'accepts LOG_LEVEL=%s',
    (level) => {
      const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, LOG_LEVEL: level });

      expect(result.success).toBe(true);
    },
  );

  it('does not read DATABASE_URL — the worker uses the writer-role DATABASE_URL_WORKER', () => {
    expect(workerEnvSchema.shape).not.toHaveProperty('DATABASE_URL');
    expect(workerEnvSchema.shape).toHaveProperty('DATABASE_URL_WORKER');
  });

  it('does not include geo config (invariant 6 — geo lookup happens only in the API)', () => {
    expect(workerEnvSchema.shape).not.toHaveProperty('GEOIP_DB_DIR');
  });

  it('does not include auth vars', () => {
    expect(workerEnvSchema.shape).not.toHaveProperty('BETTER_AUTH_SECRET');
    expect(workerEnvSchema.shape).not.toHaveProperty('BETTER_AUTH_URL');
  });

  it('does not include domain builder vars', () => {
    expect(workerEnvSchema.shape).not.toHaveProperty('POSTA_LINK_DOMAIN');
  });

  it('does not include the avatars R2 bucket — the worker only writes events', () => {
    expect(workerEnvSchema.shape).not.toHaveProperty('R2_BUCKET_AVATARS');
  });
});
