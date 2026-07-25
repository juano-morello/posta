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

  // [security fix round 1] The original character class
  // (`[^\s@/]+`) bounded the userinfo match at the FIRST `/` or `@` it
  // saw — correct for the baseline shape above, wrong the moment a
  // password itself contains either. Base64-alphabet passwords (the kind
  // managed Redis providers — Upstash, Redis Cloud, ElastiCache AUTH
  // tokens — commonly generate) routinely include both `+` and `/`. Every
  // row below mirrors the security reviewer's own adversarial probe table
  // against the shared redactor; the two "was broken" cases are RED-proven
  // against the pre-fix regex in this task's report before the fix landed.

  it('[security] fully redacts a password containing regex metacharacters', () => {
    const message = 'connect ECONNREFUSED redis://user:p*a$s(s)w[o]rd@host:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('p*a$s(s)w[o]rd');
    expect(result).not.toContain('s(s)w');
    expect(result).toContain('host:6379');
    expect(result).toContain('[REDACTED]');
  });

  it('[security] fully redacts a percent-encoded password', () => {
    const message = 'connect ECONNREFUSED redis://user:p%40ss%2Fword@host:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('p%40ss%2Fword');
    expect(result).not.toContain('ss%2Fword');
    expect(result).toContain('host:6379');
    expect(result).toContain('[REDACTED]');
  });

  it('[security, was BROKEN before this fix — partial leak] fully redacts a password containing a literal "@", keeping host:port', () => {
    // Previously: the character class stopped at the FIRST `@`, so only
    // `redis://user:p@` was matched and replaced — leaving `ssword@host:6379`
    // in cleartext right behind it. `new URL()` correctly treats the LAST
    // `@` before the host as the userinfo/host boundary (percent-encoding
    // the embedded `@` internally, exactly as a spec-compliant parser
    // must), so the WHOLE password is now gone.
    const message = 'connect ECONNREFUSED redis://user:p@ssword@host:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('ssword');
    expect(result).not.toContain('p@ssword');
    expect(result).toContain('host:6379');
    expect(result).toContain('[REDACTED]');
  });

  it('[security, was BROKEN before this fix — total exposure] never leaves a password containing an unescaped "/" in cleartext', () => {
    // Previously: the character class excluded `/` entirely, so this
    // message matched NOTHING and passed through completely unredacted —
    // the worst of the two gaps. A raw, un-percent-encoded `/` inside
    // userinfo is not valid URI syntax to begin with (RFC 3986 requires
    // it be pct-encoded there), so `new URL()` itself cannot parse this
    // string — genuinely ambiguous input, not a parser limitation. The
    // fix's fallback for that case redacts the WHOLE scheme://... chunk
    // rather than risk leaving any password fragment in cleartext; host
    // and port are sacrificed ONLY for this already-malformed shape, not
    // for the well-formed cases above.
    const message = 'connect ECONNREFUSED redis://user:pa/ssDistinctive123@host:6379';

    const result = redactCredentialsFromMessage(message);

    expect(result).not.toContain('pa/ssDistinctive123');
    expect(result).not.toContain('ssDistinctive123');
    expect(result).not.toContain('host:6379'); // sacrificed for this shape — documented above
    expect(result).toContain('redis://');
    expect(result).toContain('[REDACTED]');
  });
});
