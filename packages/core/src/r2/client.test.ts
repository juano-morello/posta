import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../ulid';
import { createR2Client, type R2ClientConfig } from './client';

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
const REAL_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
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

      // Also check the whole serialized error (name, code, metadata) —
      // not just `.message` — the same "don't trust .message alone"
      // discipline resolve-redis.ts's own describeError applies to
      // ioredis errors, extended here to whatever shape the AWS SDK
      // throws.
      const fullySerialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
      expect(fullySerialized).not.toContain(REAL_CONFIG.secretAccessKey);
      expect(fullySerialized).not.toContain(WRONG_SECRET);
    });
  });
});
