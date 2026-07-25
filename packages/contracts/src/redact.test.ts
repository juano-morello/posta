import { describe, expect, it } from 'vitest';
import { redactCredentialsFromMessage } from './redact';

// S2.2 story-fan-out review (CRITICAL) — proves the exact scenario the
// finding described: an ioredis-style connection-error message embedding
// a REDIS_URL password must lose the password, while staying diagnosable
// (host and port intact).

describe('redactCredentialsFromMessage', () => {
  it('[security] redacts the password out of an embedded redis:// URL while keeping the host and port', () => {
    const message = 'connect ECONNREFUSED redis://user:s3cret@host:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('s3cret');
    expect(result).toContain('host:6379');
    expect(result).toContain('redis://');
    expect(result).toContain('[REDACTED]');
  });

  it('[security] redacts a postgresql:// URL carrying a username and password', () => {
    const message =
      'Connection terminated: postgresql://posta:Tr0ub4dor-AndFour@prod-db.internal:5432/posta';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('posta:Tr0ub4dor-AndFour');
    expect(result).not.toContain('Tr0ub4dor-AndFour');
    expect(result).toContain('prod-db.internal:5432/posta');
  });

  it('redacts an ioredis-style URL with an empty username (":pass@host")', () => {
    const message = 'ECONNREFUSED redis://:hunter2RedisPass@prod-redis.internal:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('hunter2RedisPass');
    expect(result).toContain('prod-redis.internal:6379');
  });

  it('redacts every credential-bearing URL when a message embeds more than one', () => {
    const message = 'tried redis://user1:pass1@host1:6379 then redis://user2:pass2@host2:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('pass1');
    expect(result).not.toContain('pass2');
    expect(result).toContain('host1:6379');
    expect(result).toContain('host2:6379');
  });

  it('leaves a message with no embedded URL unchanged', () => {
    const message = 'simulated Redis GET failure';

    expect(redactCredentialsFromMessage(message)).toBe(message);
  });

  it('leaves a credential-free URL (no userinfo) unchanged', () => {
    const message = 'connect ECONNREFUSED redis://host:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).toBe(message);
  });

  it('does not treat an unrelated email address as a credential (no scheme:// prefix present)', () => {
    const message = 'SEED_USER_EMAIL validation failed for juano@example.test';

    const result = redactCredentialsFromMessage(message);

    expect(result).toBe(message);
  });
});
