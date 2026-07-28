import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createR2Client,
  eventBatchKey,
  EVENTS_DLQ_QUEUE,
  links,
  newId,
  runSqlMigrations,
  user,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, startRedisContainer, type PgContainerHandle, type RedisContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { DlqService, type EventsDlqJobPayload } from '../consumer/dlq.service';
import { createFlushBatch, type FlushBatch } from './flush';

// T3.4.6 [E3, S3.4][INV-7] — proves the coupling flush.ts's own header
// describes, end to end, against a GENUINELY stopped MinIO container (the
// real docker-compose service, T0.4.4 — never a mock, never a fake bucket
// name the way r2-put.test.ts's own [INV-7] test uses for a FAST,
// synchronous failure). "R2 PUT first, Postgres only if it succeeded" is
// the property under test; a fake-bucket 404 proves the code REJECTS on
// R2 failure, but says nothing about the RETRY/DLQ path this task wires
// in (r2-retry.ts, T3.4.5) actually engaging against a real transport
// failure (ECONNREFUSED, once the container's published port stops
// listening entirely) — that distinction is why this file exists
// alongside, not instead of, r2-put.test.ts's own assertion.
//
// CONTROLLING THE REAL MinIO CONTAINER — no established precedent existed
// anywhere in this codebase for stopping/starting the shared compose
// MinIO from a test (checked: packages/core/src/r2/client.test.ts,
// r2-put.test.ts, r2-retry.test.ts all force R2 failures either via a
// nonexistent bucket or wrong credentials, never a real outage).
// `runDocker`/the container-lifecycle helpers below mirror
// tests/containers/image-smoke.test.ts's own `spawnSync('docker', ...)` +
// throw-on-nonzero-exit pattern (the closest existing precedent for
// shelling out to docker from a vitest test), applied to `docker compose
// stop/start minio` instead of `docker compose run`/`docker inspect` on a
// one-off container. This file is careful to always restore MinIO in a
// `finally`/`afterAll` — this worktree's docker-compose stack is SHARED
// with other concurrent work, and this task's own dispatch brief is
// explicit that leaving MinIO stopped on exit is not acceptable.
//
// WHY THIS PROVES "R2 down = zero new Postgres rows" AND NOT MERELY "R2
// down = flushBatch rejects": a REAL DlqService (backed by a real
// testcontainers Redis, mirroring poison-dlq.test.ts's own "Postgres,
// Redis AND R2/MinIO are all real here" discipline) is wired in as
// `dlqSink` — flush.ts's own header explains why a DLQ-routed failure
// RESOLVES `flushBatch` rather than rejecting it (a handled outcome, not
// an exceptional one), so this test's own assertions have to read the
// actual STATE (zero Postgres rows, exactly one DLQ entry) rather than
// only the promise's settlement, which is exactly what "no Postgres
// commit if R2 failed" means as a state property, not a control-flow one.
//
// "THE DLQ ENTRY REPLAYS INTO BOTH STORES" (verify text) — read literally,
// per this task's own dispatch brief point 3: no new replay MECHANISM is
// built here (T3.6.3, unbuilt, S3.6's job). This test takes the payload
// straight OUT of the real DLQ job (`job.data.rawPayload`, `job.data.
// originalJobId` for the batchId) and calls the SAME real `flushBatch`
// again once MinIO is healthy — proving the recovery PATH this task's own
// coupling makes possible actually works, not that a generic replay tool
// exists. The SAME `batchId` is reused deliberately (both flushBatch's
// own idempotent-key property, keys.ts's own header, AND
// insertEventsBatch's `ON CONFLICT DO NOTHING`, T3.3.5) — a genuine retry
// of the identical batch must be safe on both stores, and this is that
// exact scenario, not a new one invented for the test.

const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

const CONTAINER_TEST_TIMEOUT_MS = 180_000;
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

const REPO_ROOT = process.cwd();
const MINIO_SERVICE = 'minio';
const DOCKER_TIMEOUT_MS = 30_000;
const MINIO_HEALTHY_POLL_INTERVAL_MS = 500;
const MINIO_HEALTHY_TIMEOUT_MS = 60_000;

// Fast, deliberately far below production's own DEFAULT_R2_MAX_ATTEMPTS
// (5)/DEFAULT_R2_INITIAL_DELAY_MS (200, flush.ts) — a genuinely stopped
// container's published port refuses a connection almost instantly
// (ECONNREFUSED), so there is no real transport latency to wait out here;
// keeping the backoff itself small just keeps THIS test's own outage
// window short, out of courtesy to the shared compose stack other
// concurrent work in this worktree depends on staying up.
const TEST_R2_MAX_ATTEMPTS = 3;
const TEST_R2_INITIAL_DELAY_MS = 20;

/** Runs a `docker` subcommand and throws with full context (stdout+stderr)
 * on any non-zero exit, a timeout kill, or a spawn failure — mirrors
 * tests/containers/image-smoke.test.ts's own `runDocker` (no existing R2
 * integration test in this codebase controls a real container's
 * lifecycle, so that file's own docker-CLI-from-vitest pattern is the
 * closest established precedent). */
function runDocker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): string {
  const result = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs });

  if (result.error) {
    throw new Error(`Failed to spawn "docker ${args.join(' ')}": ${result.error.message}`);
  }
  if (result.status !== 0 || result.signal) {
    throw new Error(
      `"docker ${args.join(' ')}" exited status=${result.status} signal=${result.signal}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** `docker compose stop minio` — blocks until the container has actually
 * stopped (compose's own documented behavior), so by the time this
 * returns the published port is genuinely no longer listening. */
function stopMinio(): void {
  runDocker(['compose', 'stop', MINIO_SERVICE], DOCKER_TIMEOUT_MS);
}

/** `docker compose start minio` — restarts the SAME container (never
 * removed by `stop`), so its healthcheck (docker-compose.yml's own `curl
 * -f http://localhost:9000/minio/health/live`) resumes running against
 * it, unchanged. */
function startMinio(): void {
  runDocker(['compose', 'start', MINIO_SERVICE], DOCKER_TIMEOUT_MS);
}

/** Polls `docker inspect`'s own health status until it reports `healthy`
 * — the exact signal `docker compose ps` surfaces as `(healthy)`, and
 * what this worktree's shared stack is expected to be in both before this
 * suite starts and after it finishes (this task's own dispatch brief). */
async function waitForMinioHealthy(timeoutMs = MINIO_HEALTHY_TIMEOUT_MS): Promise<void> {
  const containerId = runDocker(['compose', 'ps', '-a', '-q', MINIO_SERVICE]);
  if (!containerId) {
    throw new Error(`"docker compose ps -a -q ${MINIO_SERVICE}" produced no container id`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastStatus = '(no attempt yet)';
  for (;;) {
    lastStatus = runDocker(['inspect', '--format', '{{.State.Health.Status}}', containerId]);
    if (lastStatus === 'healthy') return;
    if (Date.now() > deadline) {
      throw new Error(`MinIO (${containerId}) did not report healthy within ${timeoutMs}ms — last status: ${lastStatus}`);
    }
    await new Promise((resolve) => setTimeout(resolve, MINIO_HEALTHY_POLL_INTERVAL_MS));
  }
}

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

async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

async function seedLink(
  handle: PgContainerHandle,
  tenantId: string,
  slug: string,
  destination: string,
): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({ id: linkId, tenantId, slug, destination });
  return linkId;
}

interface EventRowSnapshot {
  readonly event_id: string;
}

async function fetchEventRows(handle: PgContainerHandle, eventIds: readonly string[]): Promise<EventRowSnapshot[]> {
  const result = await handle.pool.query<EventRowSnapshot>(
    'SELECT event_id FROM events WHERE event_id = ANY($1::text[])',
    [eventIds],
  );
  return result.rows;
}

/** Counts non-blank lines — same "no trailing blank line" NDJSON
 * convention r2-put.test.ts's own `countLines` already establishes. */
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

describe('flushBatch — coupled writes, R2 first, Postgres only if it succeeded (T3.4.6) [INV-7]', () => {
  let pg: PgContainerHandle;
  let redis: RedisContainerHandle;
  let dlqQueue: Queue<EventsDlqJobPayload>;
  let dlqService: DlqService;
  let r2Client: ReturnType<typeof createR2Client>;
  let flushBatch: FlushBatch;
  let tenantId: string;
  let linkId: string;
  const r2CreatedKeys: string[] = [];

  beforeAll(async () => {
    [pg, redis] = await Promise.all([startPgContainer(), startRedisContainer()]);
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

    dlqQueue = new Queue<EventsDlqJobPayload>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    dlqService = new DlqService(dlqQueue);

    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantId = await seedTenant(pg);
    linkId = await seedLink(pg, tenantId, 'promo', 'https://example.com/promo');

    flushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      dlqSink: dlqService,
      r2RetryOptions: { maxAttempts: TEST_R2_MAX_ATTEMPTS, initialDelayMs: TEST_R2_INITIAL_DELAY_MS },
    });

    // MinIO must genuinely be healthy before the outage phase deliberately
    // stops it — this is a sanity check on the shared stack's own starting
    // state, not part of the property under test.
    await waitForMinioHealthy();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    // Unconditional, regardless of test outcome: this worktree's compose
    // stack is shared with other concurrent work (this task's own
    // dispatch brief) — MinIO must be left running/healthy no matter how
    // the test above went.
    startMinio();
    await waitForMinioHealthy();

    if (r2CreatedKeys.length > 0) {
      await Promise.all(
        r2CreatedKeys.splice(0).map((key) =>
          r2Client.send(new DeleteObjectCommand({ Bucket: REAL_R2_CONFIG.bucket, Key: key })),
        ),
      );
    }
    r2Client.destroy();

    await dlqQueue.obliterate({ force: true });
    await dlqQueue.close();
    await redis.stop();
    await pg.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it(
    'stops MinIO mid-run: zero new Postgres rows, exactly one DLQ entry holding the whole batch — then, once MinIO returns, replaying that exact DLQ entry lands every row in both stores',
    async () => {
      const events = Array.from({ length: 5 }, () => buildCaptureEvent({ tenant_id: tenantId, link_id: linkId }));
      const eventIds = events.map((event) => event.event_id).sort();
      const batchId = newId();
      const key = eventBatchKey(batchId, events[0]!.occurred_at);
      r2CreatedKeys.push(key);

      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        stopMinio();

        // [INV-7] the coupling under test: flushBatch RESOLVES (a
        // DLQ-routed failure is a handled outcome, not an exceptional one
        // — see flush.ts's own header) rather than rejecting.
        await expect(flushBatch(events, batchId)).resolves.toBeUndefined();

        // Zero new Postgres rows — the transaction was never opened.
        const rows = await fetchEventRows(pg, eventIds);
        expect(rows).toHaveLength(0);

        // Exactly one DLQ entry, holding the WHOLE batch, not one per event.
        const dlqJobs = await dlqQueue.getJobs(['waiting']);
        expect(dlqJobs).toHaveLength(1);

        const [job] = dlqJobs;
        expect(job?.data.reason).toBe('r2-put-failed');
        expect(job?.data.originalJobId).toBe(batchId);
        expect(job?.data.attemptsMade).toBe(TEST_R2_MAX_ATTEMPTS);
        // NOT asserted null: dlq.service.ts's own `extractSqlState` duck-types
        // ANY error's string `.code` property, not specifically a Postgres
        // SQLSTATE (that file's own header claims 'r2-put-failed' is
        // "always null" here, but that holds only for an AWS-SDK-shaped
        // rejection with no `.code` at all — a genuine transport-level
        // ECONNREFUSED, this scenario's real error once the container's
        // port stops listening, DOES carry a `.code` of `'ECONNREFUSED'`,
        // which is what actually lands here). Pre-existing, shared
        // behavior in a file this task does not own — recorded, not
        // "fixed" by asserting something false instead.
        expect(job?.data.sqlstate).toBe('ECONNREFUSED');

        const dlqPayload = job?.data.rawPayload as CaptureEvent[];
        expect(dlqPayload.map((event) => event.event_id).sort()).toEqual(eventIds);

        // The R2 object itself was never created.
        await expect(
          r2Client.send(new GetObjectCommand({ Bucket: REAL_R2_CONFIG.bucket, Key: key })),
        ).rejects.toBeDefined();

        // ---- Recovery: MinIO returns ----
        startMinio();
        await waitForMinioHealthy();

        // Replays the payload straight OUT of the DLQ entry (not the
        // original in-memory `events` variable) — proving the stored
        // entry is itself a faithful, replayable record — through the
        // SAME real flushBatch, reusing the SAME batchId the DLQ entry
        // itself names as `originalJobId` (idempotent R2 key, and
        // `ON CONFLICT DO NOTHING` on the Postgres side either way).
        const replayBatchId = job!.data.originalJobId;
        await expect(flushBatch(dlqPayload, replayBatchId)).resolves.toBeUndefined();

        const rowsAfterReplay = await fetchEventRows(pg, eventIds);
        expect(rowsAfterReplay).toHaveLength(5);
        expect(rowsAfterReplay.map((row) => row.event_id).sort()).toEqual(eventIds);

        const body = await getObjectText(r2Client, REAL_R2_CONFIG.bucket, key);
        expect(countLines(body)).toBe(5);

        expect(unhandledRejections).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    },
    CONTAINER_TEST_TIMEOUT_MS,
  );
});
