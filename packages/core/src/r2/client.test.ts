import { inspect } from 'node:util';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../ulid';
import { createR2Client, type R2ClientConfig } from './client';

/**
 * Resolves an S3Client's own endpoint provider. `S3Client['config']['endpoint']`
 * is typed as possibly `undefined` (the AWS SDK's own generic
 * `EndpointResolvedConfig` shape, not something this repo controls) even
 * though `createR2Client` always supplies a real `endpoint` — narrowed
 * here once, with an explicit runtime check rather than a non-null
 * assertion, so a genuinely missing provider fails loudly with a clear
 * message instead of a bare TypeError.
 */
async function resolveClientEndpoint(client: S3Client): Promise<{ hostname: string; protocol: string }> {
  const provider = client.config.endpoint;
  if (!provider) {
    throw new Error('S3Client.config.endpoint is unexpectedly undefined');
  }
  return provider();
}

// T3.4.1 (E3, S3.4) — the R2/S3-compatible client seam. This is a REAL
// integration test against the compose MinIO (T0.4.4), never a mock —
// see this task's own brief: "do not stub the S3 client". The values
// below mirror this worktree's own .env exactly (R2_ENDPOINT,
// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_EVENTS) — hardcoded
// as literal constants rather than read via a dotenv loader, the same
// convention packages/core/src/redis/client.test.ts's own TEST_URL
// already established for this repo (`pnpm test` does not load .env for
// process.env — only each app's own dotenv-wrapped scripts do). These
// are local-dev-only MinIO root credentials, already checked into
// .env.example in plaintext — not a real secret.
// Cloudflare account ids are 32 lowercase hex characters (R2ClientConfig's
// own `accountId` doc comment, security review round 2) — this is NOT
// this worktree's actual .env value (which is a human-readable dev
// placeholder, not a real Cloudflare id) but a well-formed FAKE one,
// deliberately shaped to pass the format validation `resolveEndpoint` now
// enforces, so the derived-endpoint tests below exercise the REAL
// validated path rather than accidentally relying on a value that would
// itself be rejected as malformed.
const REAL_ACCOUNT_ID = 'deadbeefcafef00dfeedfacefeedface';

const REAL_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accountId: REAL_ACCOUNT_ID,
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

// The exact config SHAPE existing callers use today (apps/worker's
// app.module.ts, replay.ts, and roughly a dozen test-file R2ClientConfig
// literals across apps/worker and packages/core) — all of them predate
// `accountId` and never set the key at all. `accountId` is OPTIONAL on
// `R2ClientConfig` precisely so these keep compiling untouched; wiring
// `R2_ACCOUNT_ID` down through each of them is T3.7.5's own job, not this
// one's. This constant proves createR2Client's RUNTIME behavior is
// correct for that omitted-key shape too, not just that it type-checks.
const LEGACY_CALLER_CONFIG: Omit<R2ClientConfig, 'accountId'> = {
  endpoint: REAL_CONFIG.endpoint,
  accessKeyId: REAL_CONFIG.accessKeyId,
  secretAccessKey: REAL_CONFIG.secretAccessKey,
  bucket: REAL_CONFIG.bucket,
};

// Deliberately wrong — forces MinIO to reject the request's computed
// SigV4 signature (the real access key id still resolves to a real
// MinIO user, so this fails with SignatureDoesNotMatch, not
// InvalidAccessKeyId — the auth-failure shape a WRONG PASSWORD produces
// in production against real R2, which is the scenario this test cares
// about).
const WRONG_SECRET = 'definitely-not-the-real-secret-99887766';

/** Keys this file creates during the "put and re-read" test, deleted in
 * afterEach so repeated runs never accumulate objects in the shared
 * posta-events bucket. */
const createdKeys: string[] = [];

afterEach(async () => {
  if (createdKeys.length === 0) return;
  const client = createR2Client(REAL_CONFIG);
  await Promise.all(
    createdKeys.splice(0).map((key) =>
      client.send(new DeleteObjectCommand({ Bucket: REAL_CONFIG.bucket, Key: key })),
    ),
  );
  client.destroy();
});

describe('createR2Client (T3.4.1)', () => {
  it('puts and re-reads an object against the real MinIO instance', async () => {
    const client = createR2Client(REAL_CONFIG);
    const key = `test/r2-client-test/${newId()}.txt`;
    createdKeys.push(key);
    const body = `hello from createR2Client test — ${newId()}`;

    await client.send(
      new PutObjectCommand({
        Bucket: REAL_CONFIG.bucket,
        Key: key,
        Body: body,
        ContentType: 'text/plain',
      }),
    );

    const getResult = await client.send(
      new GetObjectCommand({ Bucket: REAL_CONFIG.bucket, Key: key }),
    );
    const roundTripped = await getResult.Body?.transformToString('utf-8');

    expect(roundTripped).toBe(body);

    client.destroy();
  });

  it('sets forcePathStyle: true, so the SAME client addresses MinIO and R2 with no branch', () => {
    const client = createR2Client(REAL_CONFIG);

    expect(client.config.forcePathStyle).toBe(true);

    client.destroy();
  });

  describe('when the secret access key is wrong (forced auth failure)', () => {
    it('rejects, and the thrown error message contains NEITHER the real NOR the wrong secret', async () => {
      const wrongClient = createR2Client({ ...REAL_CONFIG, secretAccessKey: WRONG_SECRET });
      const key = `test/r2-client-test/${newId()}-auth-failure.txt`;

      let caught: unknown;
      try {
        await wrongClient.send(
          new PutObjectCommand({
            Bucket: REAL_CONFIG.bucket,
            Key: key,
            Body: 'should never be written',
          }),
        );
      } catch (error) {
        caught = error;
      } finally {
        wrongClient.destroy();
      }

      expect(caught).toBeDefined();
      const message = caught instanceof Error ? caught.message : String(caught);

      expect(message).not.toContain(REAL_CONFIG.secretAccessKey);
      expect(message).not.toContain(WRONG_SECRET);

      // Also check the WHOLE error object graph — not just `.message` —
      // the same "don't trust .message alone" discipline resolve-redis.ts's
      // own describeError applies to ioredis errors, extended here to
      // whatever shape the AWS SDK throws.
      //
      // [security review round 1, MEDIUM] `JSON.stringify(caught,
      // Object.getOwnPropertyNames(caught))` previously stood in for "the
      // whole serialized error", but the ARRAY form of JSON.stringify's
      // replacer applies the SAME top-level name allowlist at EVERY
      // nesting level — it does not recurse per-object. A real S3 SDK
      // error's own `$response`/`$metadata` have their OWN property names
      // (headers, body, ...), none of which are in `caught`'s top-level
      // name list, so they silently collapsed to `{}` and the assertion
      // below was passing because that content was discarded before the
      // check ever ran, not because it was actually inspected — a false
      // sense of security on exactly the property this test exists to
      // prove. `util.inspect(caught, { depth: null, showHidden: true })`
      // instead walks the FULL graph with no depth limit, so nested
      // `$response` internals (verified by hand against this real MinIO:
      // they contain the raw HTTP request, including the `authorization`
      // header) are genuinely present in `fullyInspected` for the
      // assertion below to actually check, not silently pruned first.
      //
      // Deliberately does NOT also assert `.not.toContain(accessKeyId)`
      // here: a full-depth dump DOES contain the access key id in
      // cleartext (`authorization: AWS4-HMAC-SHA256
      // Credential=<accessKeyId>/...`, confirmed against this real MinIO)
      // — SigV4's own protocol always sends the key id, never the secret,
      // over the wire. That is expected AWS/R2 protocol behavior, not a
      // leak this test's own SECRET-focused scope tries to catch; it is
      // exactly why createR2Client's own docstring warns callers never to
      // log a caught S3 error wholesale (no `util.inspect(error, {depth:
      // null})`, no bare `console.log(error)`) and to log an explicit
      // allowlisted subset instead.
      const fullyInspected = inspect(caught, { depth: null, showHidden: true });
      expect(fullyInspected).not.toContain(REAL_CONFIG.secretAccessKey);
      expect(fullyInspected).not.toContain(WRONG_SECRET);
    });
  });

  // T3.7.4 (E3, S3.7) [security] [INV-7] — closes the "KNOWN GAP" this
  // module's own docstring previously documented: R2_ACCOUNT_ID was
  // validated by three env schemas but read by nobody, so an empty
  // `endpoint` (production's own documented value) fell through to the
  // AWS SDK's default endpoint resolution, which cannot address a real
  // R2 account. These tests exercise `accountId` in isolation from
  // `endpoint` — never both empty by accident, never both set by
  // accident — so each branch of createR2Client's endpoint-selection
  // logic is covered on its own.
  describe('endpoint derivation from accountId (T3.7.4)', () => {
    it('uses `endpoint` verbatim when non-empty, even when accountId is ALSO set — local MinIO path is untouched', async () => {
      const client = createR2Client(REAL_CONFIG);

      const endpoint = await resolveClientEndpoint(client);

      expect(endpoint.hostname).toBe('localhost');
      expect(endpoint.protocol).toBe('http:');

      client.destroy();
    });

    it('derives https://<accountId>.r2.cloudflarestorage.com when endpoint is empty and accountId is set', async () => {
      const client = createR2Client({ ...REAL_CONFIG, endpoint: '', accountId: REAL_ACCOUNT_ID });

      const endpoint = await resolveClientEndpoint(client);

      expect(endpoint.hostname).toBe(`${REAL_ACCOUNT_ID}.r2.cloudflarestorage.com`);
      expect(endpoint.protocol).toBe('https:');

      client.destroy();
    });

    it('throws, naming BOTH R2_ENDPOINT and R2_ACCOUNT_ID, when both endpoint and accountId are empty', () => {
      expect(() => createR2Client({ ...REAL_CONFIG, endpoint: '', accountId: '' })).toThrow(
        /R2_ENDPOINT/,
      );
      expect(() => createR2Client({ ...REAL_CONFIG, endpoint: '', accountId: '' })).toThrow(
        /R2_ACCOUNT_ID/,
      );
    });

    it('uses `endpoint` verbatim when the accountId KEY is omitted entirely — matches existing callers that predate this field', async () => {
      const client = createR2Client(LEGACY_CALLER_CONFIG);

      const endpoint = await resolveClientEndpoint(client);

      expect(endpoint.hostname).toBe('localhost');
      expect(endpoint.protocol).toBe('http:');

      client.destroy();
    });

    it('throws, naming BOTH R2_ENDPOINT and R2_ACCOUNT_ID, when endpoint is empty and the accountId KEY is omitted entirely', () => {
      const config = { ...LEGACY_CALLER_CONFIG, endpoint: '' };

      expect(() => createR2Client(config)).toThrow(/R2_ENDPOINT/);
      expect(() => createR2Client(config)).toThrow(/R2_ACCOUNT_ID/);
    });

    it('never puts a credential into the thrown message — absence-asserted so an accidental interpolation would fail this test', () => {
      let caught: unknown;
      try {
        createR2Client({ ...REAL_CONFIG, endpoint: '', accountId: '' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : String(caught);

      // Sanity check FIRST: prove this assertion style can actually fail,
      // not just vacuously pass — a message that DOES embed the secret
      // must fail `.not.toContain`, or the real assertions below would be
      // meaningless.
      expect(`leaked: ${REAL_CONFIG.secretAccessKey}`).toContain(REAL_CONFIG.secretAccessKey);

      expect(message).not.toContain(REAL_CONFIG.accessKeyId);
      expect(message).not.toContain(REAL_CONFIG.secretAccessKey);
    });
  });

  // [security review round 2, MEDIUM] resolveEndpoint used to interpolate
  // `config.accountId` into a URL with ZERO format validation. A value
  // containing `/` terminates the authority early — `accountId =
  // 'evil.example.com/x'` produced `https://evil.example.com/x.r2.
  // cloudflarestorage.com`, whose ACTUAL connection host is
  // `evil.example.com`, not the intended R2 endpoint — and S3Client
  // resolves `endpoint` lazily, so this was never caught at boot, only on
  // the first real write, silently sending SigV4 credentials and event
  // data to the wrong host. These tests prove createR2Client rejects a
  // malformed accountId LOUDLY, before ever constructing that client, per
  // Cloudflare's own documented account-id format (32 lowercase hex
  // characters) — restoring this task's actual design goal ("fail loud
  // at construction, not silently on the first PUT") for this branch too.
  describe('accountId format validation (security review round 2, T3.7.4)', () => {
    const HOST_INJECTION_ACCOUNT_ID = 'evil.example.com/x';

    it('throws, naming R2_ACCOUNT_ID, rather than derive a client pointed at an attacker-controlled host', () => {
      expect(() =>
        createR2Client({ ...REAL_CONFIG, endpoint: '', accountId: HOST_INJECTION_ACCOUNT_ID }),
      ).toThrow(/R2_ACCOUNT_ID/);
    });

    it('never echoes the malformed accountId value into the thrown message — R2_ACCOUNT_ID is SECRET_ENV_KEYS-classified (packages/contracts/src/env.ts)', () => {
      let caught: unknown;
      try {
        createR2Client({ ...REAL_CONFIG, endpoint: '', accountId: HOST_INJECTION_ACCOUNT_ID });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : String(caught);

      expect(message).not.toContain(HOST_INJECTION_ACCOUNT_ID);
    });

    it('rejects other malformed shapes too, not only slash-bearing ones — wrong length, non-hex, and wrong case all fail Cloudflare\'s documented 32-lowercase-hex format', () => {
      const malformedValues = [
        'not-hex-at-all!!',
        'DEADBEEFCAFEF00DFEEDFACEFEEDFACE', // uppercase — Cloudflare's own format is lowercase-only
        'deadbeef', // far too short
        `${REAL_ACCOUNT_ID}00`, // one byte too long
      ];

      for (const malformed of malformedValues) {
        expect(() =>
          createR2Client({ ...REAL_CONFIG, endpoint: '', accountId: malformed }),
        ).toThrow(/R2_ACCOUNT_ID/);
      }
    });
  });
});
