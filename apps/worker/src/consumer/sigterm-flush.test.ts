import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Queue } from 'bullmq';
import { EVENTS_DLQ_QUEUE, EVENTS_QUEUE, newId, runSqlMigrations } from '@posta/core';
import {
  startPgContainer,
  startRedisContainer,
  type PgContainerHandle,
  type RedisContainerHandle,
} from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// T3.1.8 [E3, S3.1] — T3.1.6's shutdown.test.ts already proves the LOGIC
// (ShutdownService.onModuleDestroy() pauses the BullMQ worker and calls
// BatchAccumulator.flushNow() before app.close() resolves), against an
// IN-PROCESS app booted via `NestFactory.createApplicationContext()` and
// torn down by calling `app.close()` directly — never a real OS signal,
// never a real process boundary. This file proves the other half: that a
// REAL, COMPILED worker process, run exactly the way Kubernetes runs it
// (`node apps/worker/dist/main.js`, this file's own `MAIN_JS_PATH`/
// `REPO_ROOT` below reconstructing the Dockerfile's own `WORKDIR /app` +
// `CMD ["node", "apps/worker/dist/main.js"]`), receiving a REAL `SIGTERM`
// from `child_process.kill()`, actually reaches the same `process.exit(0)`
// `main.ts`'s `app.enableShutdownHooks(['SIGTERM'], { useProcessExit: true
// })` promises — not a stub, not `NestFactory.createApplicationContext()`,
// the literal entrypoint `main.ts` and `Dockerfile` both already commit to.
//
// WHY THE REAL, COMPILED ENTRYPOINT AND NOT A TS-EXECUTED SOURCE FILE:
// `apps/worker/package.json`'s own `"start": "node dist/main.js"` (the
// SAME command the Dockerfile's `CMD` runs) is the only production-shaped
// way this worker ever boots — there is no `tsx`/`ts-node` anywhere in this
// monorepo (checked: neither the root nor apps/worker's own
// package.json lists either), so running the TS source directly would be
// a parallel, never-shipped boot path, not the one this task exists to
// prove survives a real SIGTERM. `beforeAll` below runs `pnpm --filter
// @posta/worker run build` itself (mirroring tests/containers/
// image-smoke.test.ts's own "must be runnable on its own, not conditional
// on a prior build having already happened by hand" discipline) rather
// than assuming a fresh `dist/` is already sitting there.
//
// R2 MUST BE REAL TOO [T3.4.6]: flush.ts now PUTs to R2 BEFORE the
// Postgres INSERT, awaited to completion — a flush this test's SIGTERM
// triggers cannot land a single Postgres row without a working R2/MinIO
// behind it. `REAL_R2_*` below mirrors shutdown.test.ts's own already-
// reviewed local-dev-only MinIO root credentials (already in .env.example,
// not a real secret) — this test does not delete the R2 object its own
// real flush creates, for the identical reason shutdown.test.ts's header
// already gives: no batch_id is ever learned back out of this flow, so
// there is no key to target a `DeleteObjectCommand` at without risking
// another concurrent test's own object sharing the same UTC date/hour
// partition. A few bytes of leftover local-dev NDJSON debris is the same
// accepted tradeoff.
//
// WHY 250, AND WHY EVENT_BATCH_SIZE=500 (the schema's own ceiling, env.ts)
// / EVENT_BATCH_INTERVAL_MS=60s: this task's own brief names 250 as the
// count that must be sitting UNFLUSHED, in memory, at the moment SIGTERM
// is sent — proving it was ShutdownService's own onModuleDestroy() that
// flushed them, not either of BatchAccumulator's two automatic triggers
// (T3.3.1) firing first for the wrong reason. `EVENT_BATCH_SIZE=500` (the
// max `workerEnvSchema` allows, comfortably above 250) keeps the count
// trigger from ever firing; `EVENT_BATCH_INTERVAL_MS=60_000` is
// comfortably longer than this test's own runtime, so the interval timer
// never fires either — the SAME "never hit" discipline shutdown.test.ts's
// own `BATCH_SIZE_NEVER_HIT`/`BATCH_INTERVAL_MS_NEVER_HIT` already
// established, just re-derived here against `workerEnvSchema`'s own real
// 500 ceiling rather than shutdown.test.ts's unvalidated 1000 (that file
// bypasses the schema entirely, constructing `AppModule.forRoot()`
// in-process with a raw config object; THIS file goes through the real
// `loadEnv(workerEnvSchema, ...)` gate in main.ts, so 500 is the actual
// ceiling available here).
//
// "MID-BATCH" MEANS ACCUMULATED, NOT MERELY ENQUEUED — same reasoning
// shutdown.test.ts's own header already gives: this test waits for every
// pushed job to reach BullMQ's `'completed'` state (via the real,
// child-process-hosted `EventsConsumer`/`AccumulatingEventSink`) before
// ever sending SIGTERM, and separately asserts zero Postgres rows exist
// at that exact moment — proof the 250 events are genuinely sitting
// inside the in-memory accumulator, not still waiting in Redis, when the
// signal lands.
//
// READINESS SIGNAL — `GET /health` (health.controller.ts, T3.1.7), polled
// after spawn until it answers 200 OR 503 (either means the HTTP server,
// and therefore the whole Nest module graph including the BullMQ
// `EventsConsumer`, finished constructing — `NestFactory.create()` itself
// only resolves once every provider's `onModuleInit` has already run,
// strictly before `app.listen()` is ever reached, so `/health` answering
// at all is sufficient; a 503 here would only mean "already stale", never
// "not yet booted"). Mirrors tests/containers/image-smoke.test.ts's own
// `pollHealth` — including its "the container/process already exited"
// short-circuit, so a worker that crashes on boot fails FAST with a clear
// reason instead of silently burning the full poll timeout.
//
// RED-PHASE VERIFICATION ACTUALLY PERFORMED FOR THIS TASK (not merely
// planned): with the test below otherwise unchanged, `main.ts`'s own
// `app.enableShutdownHooks(['SIGTERM'], { useProcessExit: true });` line
// was temporarily commented out, `pnpm --filter @posta/worker run build`
// was re-run by hand, and `pnpm test sigterm-flush.test.ts` was run
// against that build. Result: a REAL assertion-level failure — 0 rows in
// Postgres (not 250) and `exitResult.code === null` / `exitResult.signal
// === 'SIGTERM'` (not 0/null) — because with no listener registered,
// Node's own default SIGTERM disposition (immediate termination, no
// async code runs) is exactly what fires; nothing about that failure was
// an import/module error or a hang. The line was then restored and the
// build re-run, after which every assertion below passes against the
// real worker. This confirms the assertions in this file actually detect
// the failure mode they exist to catch, not merely that the harness boots.
//
// TEST-ISOLATION DISCIPLINE: this file obliterates BOTH `EVENTS_QUEUE`
// and `EVENTS_DLQ_QUEUE` at setup AND teardown, even though it boots its
// own fresh testcontainers Redis (so no OTHER test file's state could
// ever leak in directly) — matching the defensive discipline this task's
// own dispatch brief calls out from events.consumer.test.ts (repeated
// `queue.obliterate({ force: true })` calls resetting BullMQ's own
// auto-increment job-id counter). Belt-and-suspenders here, not a fix for
// an observed collision in THIS file specifically.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const REPO_ROOT = process.cwd();
const MAIN_JS_PATH = path.join('apps', 'worker', 'dist', 'main.js');
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

// [load-bearing, not cosmetic] createDbClient() (packages/core/src/db/
// client.ts) THROWS at construction time if DB_POOL_MAX is unset and no
// explicit `max` was passed — it has no silent default. Production gets
// this from docker-compose's/k8s's own env_file (.env.example's own
// DB_POOL_MAX=10); a bare `node dist/main.js` child process spawned
// directly by THIS file inherits none of that, so it must be set
// explicitly below or the DB_CLIENT provider factory (app.module.ts)
// crashes the child before /health ever answers. Mirrors packages/core/
// src/test/pg-container.ts's own CONTAINER_POOL_MAX (5)/shutdown.test.ts's
// own TEST_DB_POOL_MAX — a single test file, sequential queries, no
// horizontal-scaling concern.
const TEST_DB_POOL_MAX = 5;

const EVENT_COUNT = 250;
// workerEnvSchema's own hard ceiling (env.ts, T0.3.6) — comfortably above
// EVENT_COUNT, so the count trigger never fires during this test.
const BATCH_SIZE_NEVER_HIT = 500;
// Comfortably longer than this test's own runtime — the interval trigger
// must never fire either.
const BATCH_INTERVAL_MS_NEVER_HIT = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

const BUILD_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const JOBS_COMPLETED_TIMEOUT_MS = 30_000;
const JOBS_COMPLETED_POLL_INTERVAL_MS = 100;
// Comfortably above SHUTDOWN_TIMEOUT_MS — real OS process-exit/scheduling
// overhead on top of the bounded shutdown sequence itself.
const EXIT_WAIT_TIMEOUT_MS = 30_000;
// beforeAll/afterAll's own vitest hook timeout — generous: a `nest build`
// (~10-20s) plus two testcontainers boots plus 250 jobs plus a real
// SIGTERM-triggered flush (R2 PUT + Postgres INSERT) is real wall-clock
// work, matching this file's own top-level `vi.setConfig` reasoning.
const HOOK_TIMEOUT_MS = 240_000;

// Same local-dev-only MinIO root credentials as shutdown.test.ts's own
// REAL_R2_* constants (already in .env.example, not a real secret) — see
// this file's own header for why a real, working R2/MinIO is required.
const REAL_R2_ENDPOINT = 'http://localhost:9000';
const REAL_R2_ACCESS_KEY_ID = 'posta-local-dev';
const REAL_R2_SECRET_ACCESS_KEY = 'posta-local-dev-secret';
const REAL_R2_BUCKET = 'posta-events';
// Unlike the four fields above, R2_ACCOUNT_ID is schema-validated
// (workerEnvSchema, env.ts) but never actually consumed by
// `createR2Client()` on the local-MinIO-endpoint-override path
// (packages/core/src/r2/client.ts's own header) — any non-empty value
// satisfies it, matching apps/worker/src/env.test.ts's own
// `VALID_WORKER_ENV.R2_ACCOUNT_ID`.
const R2_ACCOUNT_ID = 'test-account-id';

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

async function countEventsRows(pg: PgContainerHandle): Promise<number> {
  const result = await pg.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM events');
  return Number(result.rows[0]?.count ?? '0');
}

/** Builds and rebuilds `apps/worker/dist/` from current source — the SAME
 * `nest build` the Dockerfile's own build stage runs, so this test never
 * relies on a `dist/` some prior, unrelated command happened to leave
 * behind. Mirrors tests/containers/image-smoke.test.ts's own
 * `runDocker`/apps/worker/src/batch/coupled-writes.test.ts's own
 * `runDocker`: throws with full stdout+stderr context on any non-zero
 * exit, a timeout kill, or a spawn failure. */
function buildWorker(): void {
  const result = spawnSync('pnpm', ['--filter', '@posta/worker', 'run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });

  if (result.error) {
    throw new Error(`Failed to spawn "pnpm --filter @posta/worker run build": ${result.error.message}`);
  }
  if (result.status !== 0 || result.signal) {
    throw new Error(
      `"pnpm --filter @posta/worker run build" exited status=${result.status} signal=${result.signal}:\n` +
        `${result.stdout}\n${result.stderr}`,
    );
  }
}

/** Grabs an ephemeral, currently-free TCP port on the IPv4 loopback by
 * binding a throwaway server to port 0 and reading back what the OS
 * assigned, then releasing it — the same small, bounded TOCTOU tradeoff
 * every "get a free port" helper (including published `get-port`-style
 * npm packages) makes; nothing in this monorepo already does this
 * (checked), so a fixed literal port was the only alternative, which
 * would collide the moment two of this file's own runs (or a real
 * docker-compose worker service) ever overlapped on the same host. */
async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (address === null || typeof address === 'string') {
          reject(new Error('getFreePort: server.address() returned no usable port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** Spawns the real, compiled worker entrypoint exactly as the Dockerfile's
 * own `CMD ["node", "apps/worker/dist/main.js"]` does — `cwd: REPO_ROOT`
 * plus a repo-relative path, mirroring that `WORKDIR /app` + relative-CMD
 * pairing, not `apps/worker` as cwd. `stdio: ['ignore', 'pipe', 'pipe']`:
 * this test never writes to the child's stdin, and buffering stdout/stderr
 * (rather than inheriting them straight to the test runner's own output)
 * keeps a passing run's console clean while still preserving everything
 * needed for a failing run's own error messages below. */
function spawnWorker(env: NodeJS.ProcessEnv): { child: ChildProcess; getOutput: () => string } {
  const child = spawn('node', [MAIN_JS_PATH], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  return { child, getOutput: () => output };
}

/** Polls `GET /health` until it answers (200 or 503 — see this file's own
 * header for why either means "booted") or `timeoutMs` elapses. Also
 * checks the child process hasn't already exited on every iteration —
 * mirrors tests/containers/image-smoke.test.ts's own `pollHealth`
 * "container already exited" short-circuit, so a worker that crashes on
 * boot (a bad env var, a startup exception) fails immediately with the
 * child's own captured output, rather than silently burning the full
 * timeout waiting for a health check nothing will ever answer. */
async function waitForHealth(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  getOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt succeeded';

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `worker child process exited before /health ever answered ` +
          `(code=${child.exitCode}, signal=${child.signalCode}) — output:\n${getOutput()}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200 || response.status === 503) return;
      lastError = `unexpected status ${response.status} from /health`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(
    `worker /health did not answer within ${timeoutMs}ms — last error: ${lastError}\noutput:\n${getOutput()}`,
  );
}

/** Waits for the child process's own `'exit'` event, bounded by
 * `timeoutMs` — a genuinely wedged shutdown must fail this test LOUDLY
 * rather than hang the whole suite forever; on timeout the child is
 * force-killed (`SIGKILL`) before rejecting, so a failing run never
 * leaks an orphaned worker process behind it. */
function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  getOutput: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `worker child process did not exit within ${timeoutMs}ms after SIGTERM — force-killed. ` +
            `output so far:\n${getOutput()}`,
        ),
      );
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('worker survives SIGTERM mid-batch — real child process, real Redis + Postgres + R2 (T3.1.8)', () => {
  let redis: RedisContainerHandle;
  let pg: PgContainerHandle;
  let eventsQueue: Queue<CaptureEvent>;
  let dlqQueue: Queue<unknown>;
  let child: ChildProcess;
  let getChildOutput: () => string;
  let pushedEvents: CaptureEvent[];
  let rowCountBeforeSigterm: number;
  let exitResult: { code: number | null; signal: NodeJS.Signals | null };
  let rowCountAfterExit: number;
  let persistedEventIds: string[];
  let dlqDepthAfterExit: number;
  let eventsQueueFailedAfterExit: number;

  beforeAll(async () => {
    buildWorker();

    [redis, pg] = await Promise.all([startRedisContainer(), startPgContainer()]);
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });

    eventsQueue = new Queue<CaptureEvent>(EVENTS_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    dlqQueue = new Queue<unknown>(EVENTS_DLQ_QUEUE, {
      connection: { url: redis.url, maxRetriesPerRequest: null },
    });
    // [test-isolation discipline, see this file's own header] Obliterate
    // both queues before this test drives them at all.
    await eventsQueue.obliterate({ force: true });
    await dlqQueue.obliterate({ force: true });

    const port = await getFreePort();
    const spawned = spawnWorker({
      ...process.env,
      DATABASE_URL_WORKER: pg.url,
      DB_POOL_MAX: String(TEST_DB_POOL_MAX),
      REDIS_URL: redis.url,
      R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: REAL_R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: REAL_R2_SECRET_ACCESS_KEY,
      R2_BUCKET_EVENTS: REAL_R2_BUCKET,
      R2_ENDPOINT: REAL_R2_ENDPOINT,
      WORKER_PORT: String(port),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      EVENT_BATCH_SIZE: String(BATCH_SIZE_NEVER_HIT),
      EVENT_BATCH_INTERVAL_MS: String(BATCH_INTERVAL_MS_NEVER_HIT),
      SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
    });
    child = spawned.child;
    getChildOutput = spawned.getOutput;

    await waitForHealth(child, port, HEALTH_TIMEOUT_MS, getChildOutput);

    pushedEvents = Array.from({ length: EVENT_COUNT }, (_unused, index) =>
      buildCaptureEvent({ slug: `promo-${index}` }),
    );
    await Promise.all(pushedEvents.map((event) => eventsQueue.add('capture', event)));

    // Waits for every pushed job to reach 'completed' — the signal that
    // AccumulatingEventSink.handle() (and therefore accumulator.add(), in
    // the CHILD process) has already run for all 250, so the accumulator
    // is genuinely holding a partial, unflushed batch by the time SIGTERM
    // is sent — see this file's own header.
    await vi.waitFor(
      async () => {
        const counts = await eventsQueue.getJobCounts('completed');
        expect(counts.completed).toBe(EVENT_COUNT);
      },
      { timeout: JOBS_COMPLETED_TIMEOUT_MS, interval: JOBS_COMPLETED_POLL_INTERVAL_MS },
    );

    rowCountBeforeSigterm = await countEventsRows(pg);

    child.kill('SIGTERM');
    exitResult = await waitForExit(child, EXIT_WAIT_TIMEOUT_MS, getChildOutput);

    rowCountAfterExit = await countEventsRows(pg);
    const idsResult = await pg.pool.query<{ event_id: string }>('SELECT event_id FROM events');
    persistedEventIds = idsResult.rows.map((row) => row.event_id);

    const dlqCounts = await dlqQueue.getJobCounts('waiting', 'active', 'delayed', 'paused', 'completed', 'failed');
    dlqDepthAfterExit = Object.values(dlqCounts).reduce((sum, count) => sum + count, 0);

    const eventsQueueCounts = await eventsQueue.getJobCounts('failed');
    eventsQueueFailedAfterExit = eventsQueueCounts.failed ?? 0;
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    // Best-effort: if a failure above left the child process running (an
    // assertion inside beforeAll never runs afterAll's own siblings, but
    // a later failing `it` still triggers this), don't leak it into the
    // shared worktree's process table.
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await eventsQueue.obliterate({ force: true }).catch(() => undefined);
    await dlqQueue.obliterate({ force: true }).catch(() => undefined);
    await eventsQueue.close();
    await dlqQueue.close();
    await pg.stop();
    await redis.stop();
  }, HOOK_TIMEOUT_MS);

  it('has NOT flushed before SIGTERM — the 250 events are genuinely still in-memory, not auto-flushed by either trigger', () => {
    expect(rowCountBeforeSigterm).toBe(0);
  });

  it('exits cleanly (code 0, no signal) once the graceful SIGTERM shutdown sequence completes', () => {
    expect(exitResult.code).toBe(0);
    expect(exitResult.signal).toBeNull();
  });

  it('persists all 250 buffered events to Postgres, with no duplicates, by the time the process exits', () => {
    expect(rowCountAfterExit).toBe(EVENT_COUNT);
    expect(new Set(persistedEventIds).size).toBe(EVENT_COUNT);
    const expectedIds = pushedEvents.map((event) => event.event_id).sort();
    expect(persistedEventIds.sort()).toEqual(expectedIds);
  });

  it('routes nothing to the dead-letter queue', () => {
    expect(dlqDepthAfterExit).toBe(0);
  });

  it('leaves no failed jobs behind on EVENTS_QUEUE itself', () => {
    expect(eventsQueueFailedAfterExit).toBe(0);
  });
});
