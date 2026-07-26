import { describe, expect, it } from 'vitest';
import { describeError } from './resolve-redis';

// S2.2 story-fan-out review (CRITICAL, silent-failure-hunter) —
// describeError is the ONE function every logger.warn(..., { error:
// describeError(error) }) call site in resolve-tenant.ts and
// resolve-link.ts goes through (6 call sites total). A prior version
// returned `error.message` verbatim; ioredis and `pg` embed the raw
// connection URL — password and all — directly in a connection error's
// own `.message`, so that was a real credential-logging path despite
// never logging the raw Error object. These tests exercise describeError
// itself, not the redaction regex in isolation (packages/contracts'
// redact.test.ts already covers that) — this file proves the WIRING: a
// real `Error` whose message embeds a credential comes out redacted.

describe('describeError (redaction wiring)', () => {
  it('[security] a Redis connection error message embedding REDIS_URL logs with the password absent and the host present', () => {
    const error = new Error('connect ECONNREFUSED redis://user:s3cret@host:6379');

    const result = describeError(error);

    expect(result).not.toContain('s3cret');
    expect(result).toContain('host:6379');
  });

  it('[security] a Postgres connection error message embedding DATABASE_URL logs with the password absent', () => {
    const error = new Error(
      'Connection terminated unexpectedly: postgresql://posta:Tr0ub4dor-AndFour@prod-db.internal:5432/posta',
    );

    const result = describeError(error);

    expect(result).not.toContain('Tr0ub4dor-AndFour');
    expect(result).toContain('prod-db.internal:5432/posta');
  });

  it('returns a plain Error message unchanged when it embeds no credential-bearing URL', () => {
    const error = new Error('simulated Redis GET failure');

    expect(describeError(error)).toBe('simulated Redis GET failure');
  });

  it('stringifies a non-Error rejection (e.g. a thrown string) the same way it always has', () => {
    expect(describeError('a thrown string, not an Error')).toBe('a thrown string, not an Error');
  });
});
