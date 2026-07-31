import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  SHUTDOWN_TIMEOUT_MS: '30000',
};

describe('workerEnvSchema', () => {
  it('parses a fully populated, valid env', () => {
    const result = workerEnvSchema.safeParse(VALID_WORKER_ENV);

    expect(result.success).toBe(true);
  });

  it('coerces WORKER_PORT, EVENT_BATCH_SIZE, EVENT_BATCH_INTERVAL_MS and SHUTDOWN_TIMEOUT_MS to numbers', () => {
    const result = workerEnvSchema.parse(VALID_WORKER_ENV);

    expect(result.WORKER_PORT).toBe(3002);
    expect(result.EVENT_BATCH_SIZE).toBe(100);
    expect(result.EVENT_BATCH_INTERVAL_MS).toBe(2000);
    expect(result.SHUTDOWN_TIMEOUT_MS).toBe(30000);
  });

  it('rejects SHUTDOWN_TIMEOUT_MS that is not a positive integer', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, SHUTDOWN_TIMEOUT_MS: '0' });

    expect(result.success).toBe(false);
  });

  it('accepts an empty R2_ENDPOINT (production leaves it empty to use the R2 default)', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, R2_ENDPOINT: '' });

    expect(result.success).toBe(true);
  });

  it('rejects a non-empty, non-URL R2_ENDPOINT', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, R2_ENDPOINT: 'not-a-url' });

    expect(result.success).toBe(false);
  });

  // [T3.7.5] The at-least-one-of cross-field rule — createR2Client
  // (packages/core/src/r2/client.ts, T3.7.4) needs one of R2_ENDPOINT /
  // R2_ACCOUNT_ID to address R2/MinIO at all; this schema enforces that at
  // boot, before a `.env` ever reaches createR2Client's own construction-
  // time throw.
  describe('the R2_ENDPOINT / R2_ACCOUNT_ID at-least-one-of rule', () => {
    it('rejects when both R2_ENDPOINT and R2_ACCOUNT_ID are empty, naming BOTH keys', () => {
      const result = workerEnvSchema.safeParse({
        ...VALID_WORKER_ENV,
        R2_ENDPOINT: '',
        R2_ACCOUNT_ID: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
        expect(failingPaths).toContain('R2_ENDPOINT');
        expect(failingPaths).toContain('R2_ACCOUNT_ID');

        const messages = result.error.issues.map((issue) => issue.message).join(' ');
        expect(messages).toContain('R2_ENDPOINT');
        expect(messages).toContain('R2_ACCOUNT_ID');
      }
    });

    it('rejects when both R2_ENDPOINT and R2_ACCOUNT_ID are omitted entirely', () => {
      const { R2_ENDPOINT: _R2_ENDPOINT, R2_ACCOUNT_ID: _R2_ACCOUNT_ID, ...rest } = VALID_WORKER_ENV;
      const result = workerEnvSchema.safeParse(rest);

      expect(result.success).toBe(false);
    });

    it('parses when only R2_ENDPOINT is set and R2_ACCOUNT_ID is empty', () => {
      const result = workerEnvSchema.safeParse({
        ...VALID_WORKER_ENV,
        R2_ENDPOINT: 'http://localhost:9000',
        R2_ACCOUNT_ID: '',
      });

      expect(result.success).toBe(true);
    });

    it('parses when only R2_ACCOUNT_ID is set and R2_ENDPOINT is empty', () => {
      const result = workerEnvSchema.safeParse({
        ...VALID_WORKER_ENV,
        R2_ENDPOINT: '',
        R2_ACCOUNT_ID: 'a'.repeat(32),
      });

      expect(result.success).toBe(true);
    });

    it('parses when R2_ACCOUNT_ID is omitted entirely and R2_ENDPOINT is set', () => {
      const { R2_ACCOUNT_ID: _R2_ACCOUNT_ID, ...rest } = VALID_WORKER_ENV;
      const result = workerEnvSchema.safeParse(rest);

      expect(result.success).toBe(true);
    });

    // [security review, MEDIUM] A whitespace-only R2_ACCOUNT_ID (a
    // plausible copy/paste or trailing-newline artifact in a `.env` file
    // or k8s Secret) must NOT read as "set" — unlike zNonEmpty, which
    // every other required field in this schema uses (z.string().trim()
    // .min(1)), R2_ACCOUNT_ID's own z.string().optional() does no
    // trimming, so this case has to be asserted explicitly rather than
    // assumed to fall out of the '' check above. createR2Client
    // (packages/core/src/r2/client.ts) would still safely reject this one
    // level down (R2_ACCOUNT_ID_FORMAT), but this schema's own
    // .superRefine exists specifically to fail LOUD at boot instead of
    // downstream — a whitespace value sailing past this check defeats
    // that purpose for this one input shape.
    it('rejects a whitespace-only R2_ACCOUNT_ID with an empty R2_ENDPOINT, naming BOTH keys', () => {
      const result = workerEnvSchema.safeParse({
        ...VALID_WORKER_ENV,
        R2_ENDPOINT: '',
        R2_ACCOUNT_ID: '   ',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
        expect(failingPaths).toContain('R2_ENDPOINT');
        expect(failingPaths).toContain('R2_ACCOUNT_ID');

        const messages = result.error.issues.map((issue) => issue.message).join(' ');
        expect(messages).toContain('R2_ENDPOINT');
        expect(messages).toContain('R2_ACCOUNT_ID');
      }
    });
  });

  // [T3.7.5] R2_ACCOUNT_ID is excluded from this generic "every key is
  // required" sweep — it is the one key in VALID_WORKER_ENV that is now
  // genuinely OPTIONAL: deleting it alone still parses, because
  // VALID_WORKER_ENV's own R2_ENDPOINT stays non-empty and satisfies the
  // at-least-one-of rule below. Its own required-ness (in combination with
  // R2_ENDPOINT) is covered by the dedicated tests further down.
  it.each(Object.keys(VALID_WORKER_ENV).filter((key) => key !== 'R2_ACCOUNT_ID'))(
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

  // [review round 2, database-reviewer finding] EVENT_BATCH_SIZE governs
  // flushBatch's own single multi-row INSERT (apps/worker/src/batch/
  // flush.ts, T3.3.2) — 31 bind params per row, so an unbounded value
  // risks exceeding Postgres's own per-statement parameter ceiling with a
  // cryptic runtime error instead of a loud, named one at boot.
  it('accepts EVENT_BATCH_SIZE at the upper bound (500)', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, EVENT_BATCH_SIZE: '500' });

    expect(result.success).toBe(true);
  });

  it('rejects EVENT_BATCH_SIZE above the upper bound (501)', () => {
    const result = workerEnvSchema.safeParse({ ...VALID_WORKER_ENV, EVENT_BATCH_SIZE: '501' });

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

/**
 * Minimal `KEY=VALUE` parser for `.env.example`, hand-rolled rather than a
 * `dotenv` dependency — apps/worker has no direct dependency on `dotenv`
 * (only the repo root's `dotenv-cli`, used to launch `nest start`, not to
 * parse), and this repo's `.env.example` never uses quoting, `export`
 * prefixes, or multi-line values (verified by hand against the file this
 * reads), so a full parser would be more machinery than the file's own
 * shape needs. Comments (`#`) and blank lines are skipped; every other
 * line is split on its first `=`.
 */
function parseDotEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    values[key] = value;
  }

  return values;
}

// [T3.7.5] Reads the REAL .env.example off disk (never a hand-typed copy
// of its contents) and parses it against workerEnvSchema directly — this
// is the assertion that would have FAILED before this task: the pre-T3.7.5
// schema marked R2_ACCOUNT_ID zNonEmpty while .env.example ships it empty,
// so a `.env` copied verbatim from the example failed the worker's own
// boot validation with nothing catching it. Keeps the example honest
// going forward: any future edit to either the schema or the example that
// breaks a fresh copy's ability to boot fails this test, not a confused
// operator at deploy time.
describe('.env.example', () => {
  it('parses cleanly against workerEnvSchema — a fresh copy must boot the worker', () => {
    const envExamplePath = path.join(process.cwd(), '.env.example');
    const contents = readFileSync(envExamplePath, 'utf8');
    const parsed = parseDotEnvFile(contents);

    const result = workerEnvSchema.safeParse(parsed);

    expect(result.success).toBe(true);
    if (!result.success) {
      // Surface exactly which keys are wrong, rather than a bare boolean
      // failure, if this ever regresses.
      const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(failingPaths).toEqual([]);
    }
  });
});
