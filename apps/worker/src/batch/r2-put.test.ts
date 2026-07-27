import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createR2Client, eventBatchKey, newId, runSqlMigrations, type R2ClientConfig } from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from './flush';

// T3.4.4 [E3, S3.4][INV-7] — flushBatch's R2 half. A REAL integration test
// against the compose MinIO (T0.4.4), never a mock — same discipline
// packages/core/src/r2/client.test.ts's own header already established
// ("do not stub the S3 client"). `REAL_CONFIG` below is that file's own
// `REAL_CONFIG`, duplicated rather than imported: it is local-dev-only
// MinIO root credentials, already checked into .env.example in plaintext,
// and this file has no other reason to depend on client.test.ts.
//
// Postgres is ALSO real (startPgContainer + runSqlMigrations, mirroring
// flush.test.ts's own setup) — not because this file's own verify cares
// about the Postgres side, but because createFlushBatch's returned
// flushBatch() now does BOTH writes per flush (this task's own header in
// flush.ts), so a flush with no working `db` would reject before ever
// reaching the R2 half.
//
// THE PROPERTY THIS FILE EXISTS TO PROVE — "one PUT per batch, never per
// event": three flush calls (sizes 1, 100, 100) must produce exactly THREE
// PutObjectCommand calls, not 201 (one per event, the bug this task
// exists to prevent) and not 1 (a bug that would silently drop two of the
// three batches' worth of events from the R2 log entirely). Each flush
// mints and passes its OWN `batchId` explicitly (rather than relying on
// flushBatch's own internal newId() default — see flush.ts's own header
// for why that default exists) so this test can compute each expected key
// via the SAME `eventBatchKey` the implementation uses, and fetch that
// exact object back afterward to check its line count independently.
const REAL_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

function buildCaptureEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: new Date().toISOString(),
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: null,
    referer: null,
    accept: null,
    accept_language: null,
    sec_fetch_site: null,
    sec_fetch_mode: null,
    sec_fetch_dest: null,
    sec_fetch_user: null,
    sec_purpose: null,
    sec_ch_ua: null,
    sec_ch_ua_mobile: null,
    sec_ch_ua_platform: null,
    purpose: null,
    x_purpose: null,
    x_moz: null,
    country: null,
    asn: null,
    visitor_hash: null,
    ...overrides,
  };
}

function buildBatch(size: number): CaptureEvent[] {
  return Array.from({ length: size }, () => buildCaptureEvent());
}

/** Counts non-blank lines — the same "no trailing blank line" NDJSON
 * convention serializeBatch's own docstring names, so an object with a
 * batch of 1 line and a trailing `\n` counts as 1, not 2. */
function countLines(body: string): number {
  return body.split('\n').filter((line) => line.length > 0).length;
}

async function getObjectText(
  r2Client: ReturnType<typeof createR2Client>,
  bucket: string,
  key: string,
): Promise<string> {
  const result = await r2Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await result.Body?.transformToString('utf-8');
  if (text === undefined) {
    throw new Error(`getObjectText: object at key "${key}" had no body`);
  }
  return text;
}

describe('createFlushBatch / flushBatch — R2 PUT (T3.4.4)', () => {
  let handle: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  let flushBatch: FlushBatch;

  const createdKeys: string[] = [];

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });

    r2Client = createR2Client(REAL_CONFIG);
    flushBatch = createFlushBatch({ db: handle.db, r2Client, r2Bucket: REAL_CONFIG.bucket });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await Promise.all(
        createdKeys.splice(0).map((key) =>
          r2Client.send(new DeleteObjectCommand({ Bucket: REAL_CONFIG.bucket, Key: key })),
        ),
      );
    }
    r2Client.destroy();
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    'issues exactly ONE PutObjectCommand per flush — 3 batches (1, 100, 100 events) produce 3 PUTs, not 201',
    async () => {
      const sendSpy = vi.spyOn(r2Client, 'send');

      const batchSizes = [1, 100, 100];
      const batches = batchSizes.map((size) => buildBatch(size));
      const batchIds = batchSizes.map(() => newId());

      for (const [index, events] of batches.entries()) {
        const batchId = batchIds[index]!;
        await flushBatch(events, batchId);
        const key = eventBatchKey(batchId, events[0]!.occurred_at);
        createdKeys.push(key);
      }

      const putCalls = sendSpy.mock.calls.filter(([command]) => command instanceof PutObjectCommand);
      expect(putCalls).toHaveLength(3);

      const bodies = await Promise.all(
        createdKeys.map((key) => getObjectText(r2Client, REAL_CONFIG.bucket, key)),
      );
      const lineCounts = bodies.map(countLines);

      expect(lineCounts).toEqual(batchSizes);

      sendSpy.mockRestore();
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );

  it('an empty batch issues zero PutObjectCommand calls — a pure no-op on the R2 side too', async () => {
    const sendSpy = vi.spyOn(r2Client, 'send');

    await flushBatch([]);

    const putCalls = sendSpy.mock.calls.filter(([command]) => command instanceof PutObjectCommand);
    expect(putCalls).toHaveLength(0);

    sendSpy.mockRestore();
  });

  it('[INV-7] a real R2 PUT failure rejects the whole flush — R2 never silently becomes optional', async () => {
    const brokenBucketFlush = createFlushBatch({
      db: handle.db,
      r2Client,
      r2Bucket: `posta-events-nonexistent-${newId().toLowerCase()}`,
    });

    await expect(brokenBucketFlush(buildBatch(1))).rejects.toBeDefined();
  });
});
