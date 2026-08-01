import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { WorkerHealthStatus } from '../health.controller';
import { describeError, sleep } from './pipeline-harness-cleanup';

// T3.5.1 [E3, S3.5] — everything about building, spawning, and polling
// the REAL compiled worker entrypoint (`node apps/worker/dist/main.js`),
// exactly the way apps/worker/src/consumer/sigterm-flush.test.ts's own
// header already justifies in full (that file's `buildWorker`/
// `spawnWorker`/`waitForHealth`/`waitForExit` are the established
// precedent this module mirrors; that reasoning is not repeated here).
// Split out of pipeline-harness.ts purely to keep each file inside this
// repo's own 200-400 line/800 hard cap convention.

export const REPO_ROOT = process.cwd();
const MAIN_JS_PATH = path.join('apps', 'worker', 'dist', 'main.js');

const BUILD_TIMEOUT_MS = 120_000;
const BUILD_LOCK_POLL_MS = 250;
// Generous: covers BUILD_TIMEOUT_MS's own ceiling plus room for whichever
// concurrent caller currently holds the lock (for a build OR — see
// `spawnWorkerExclusively()`'s own header — a brief post-spawn settle
// window) to finish.
const BUILD_LOCK_TIMEOUT_MS = BUILD_TIMEOUT_MS + 120_000;
// Deliberately OUTSIDE apps/worker/dist/ (a fix-forward past this
// constant's original location, discovered after T3.5.1 landed — see
// buildWorkerExclusively's own header for the full race this avoids):
// `nest build`'s `deleteOutDir: true` (nest-cli.json) wipes and recreates
// that ENTIRE directory on every build. A lock nested inside dist/ would
// vanish, mid-build, the instant the CURRENT holder's own build starts
// wiping it — and nothing but a competing process's own mkdirSync ever
// recreates that specific entry, so a second, still-waiting process
// racing to reacquire during exactly that window would succeed
// immediately and start a SECOND concurrent build believing it holds the
// lock: a silent, worse cousin of the crash this fix exists to remove.
// apps/worker/ itself is a source directory `nest build` never deletes,
// so the lock's own existence is now unaffected by what the build it
// guards does to dist/. Cost: no longer covered by .gitignore's blanket
// `dist/` ignore, so .gitignore now names this path directly — a lock
// left behind by an abnormal termination would otherwise show up as an
// untracked file in `git status`.
const BUILD_LOCK_PATH = path.join(REPO_ROOT, 'apps', 'worker', '.pipeline-harness-build.lock');

const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_INTERVAL_MS = 200;

export const STOP_EXIT_TIMEOUT_MS = 30_000;

function runBuildCommand(): void {
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

/**
 * `nest build`'s output target (`apps/worker/dist/`) is shared by every
 * file that calls `startPipelineHarness()` — and this story's whole
 * premise (T3.5.1's own dispatch brief) is MANY test files reusing this
 * ONE harness. Two of those files' `beforeAll`s racing `pnpm --filter
 * @posta/worker run build` concurrently (vitest's own default file-level
 * parallelism — see the root vitest.config.ts's own `fileParallelism:
 * false` project split for `tests/containers/**` and
 * `apps/api/src/redirect/test/**`, added for the IDENTICAL class of
 * problem: concurrent `docker compose build`/testcontainers-heavy files
 * racing shared state) would not merely waste time, it would corrupt
 * each other's `dist/` output mid-write. This function is a
 * self-contained fix, scoped entirely to this module (no
 * `vitest.config.ts`/CI change): a cross-PROCESS mutex via
 * `fs.mkdirSync`'s atomicity (EEXIST if another process already holds
 * the lock), since a plain in-module flag only protects callers inside
 * the SAME process, not the separate OS processes vitest's file
 * parallelism spawns. Bounded by BUILD_LOCK_TIMEOUT_MS: a lock that is
 * never released (a crashed holder) fails loudly with the lock path
 * named, rather than hanging every future run of this suite forever.
 *
 * Extracted from buildWorkerExclusively as its own exported function
 * purely so a unit test can drive it with a mocked `fs.mkdirSync` and
 * short timeouts, without also needing to mock a real `nest build` —
 * `lockPath`/`timeoutMs`/`pollMs` are parameters rather than reading the
 * module's own constants for exactly that reason.
 */
export async function acquireBuildLock(lockPath: string, timeoutMs: number, pollMs: number): Promise<void> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EEXIST: another process holds the lock right now — the expected,
      // common case. ENOENT: tolerated as defense-in-depth, not because
      // BUILD_LOCK_PATH's own parent (apps/worker/) is expected to ever
      // go missing anymore (see that constant's own comment for why it
      // no longer lives inside the directory `nest build` wipes) — but a
      // waiter here must never crash merely because its target
      // directory was transiently absent for some OTHER reason. Either
      // way, recreating the parent (idempotent, safe to repeat) and
      // retrying is the correct response, never rethrowing.
      if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
      if (Date.now() > deadline) {
        throw new Error(
          `pipeline-harness: timed out after ${timeoutMs}ms waiting for the worker build lock at ` +
            `"${lockPath}" — a concurrent build may be stuck; remove that directory by hand if no ` +
            `build is genuinely in progress`,
        );
      }
      if (code === 'ENOENT') fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      await sleep(pollMs);
    }
  }
}

export async function buildWorkerExclusively(): Promise<void> {
  await acquireBuildLock(BUILD_LOCK_PATH, BUILD_LOCK_TIMEOUT_MS, BUILD_LOCK_POLL_MS);

  try {
    runBuildCommand();
  } finally {
    fs.rmSync(BUILD_LOCK_PATH, { recursive: true, force: true });
  }
}

export function spawnWorker(env: NodeJS.ProcessEnv): { child: ChildProcess; getOutput: () => string } {
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

// [T3.5.4 fix-forward] Real, immediate NestJS boot time (DB/Redis
// connections, DI wiring) varies a lot — from well under a second to
// several seconds under load — but `MODULE_NOT_FOUND` (the failure mode
// this settle window exists to catch) is not a "slow boot", it is Node's
// OWN module resolution throwing SYNCHRONOUSLY within the first tick of
// the child process, empirically well under 100ms. 2s is generous margin
// above that, not a guess at how long a full boot takes.
const SPAWN_SETTLE_MS = 2_000;
const SPAWN_SETTLE_POLL_MS = 50;

/** Bounded, FAST poll — not `waitForHealth()`'s own (slower,
 * `HEALTH_POLL_INTERVAL_MS`) loop — for the one failure mode
 * `spawnWorkerExclusively()` needs to catch before it can safely release
 * the build lock: the child process exiting immediately because
 * `apps/worker/dist/main.js` didn't exist (or wasn't yet complete) at the
 * instant Node tried to resolve it. Resolves normally (no crash observed
 * within `timeoutMs`) without asserting anything about the app's ACTUAL
 * readiness — that is `waitForHealth()`'s job, called afterward, once the
 * lock is already released. */
async function waitForImmediateCrash(
  child: ChildProcess,
  timeoutMs: number,
  getOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `pipeline-harness: worker child process exited immediately after spawn ` +
          `(code=${child.exitCode}, signal=${child.signalCode}) — output:\n${getOutput()}`,
      );
    }
    await sleep(SPAWN_SETTLE_POLL_MS);
  }
}

/**
 * [T3.5.4 fix-forward] THE SPAWN RACE `buildWorkerExclusively()` ALONE
 * DOES NOT CLOSE: that function releases the build lock the instant `nest
 * build` finishes, trusting "no two builds ever overlap" is enough. It is
 * not — found running e2e-kill-recovery.test.ts's own regression sweep
 * alongside sigterm-flush.test.ts/pipeline-harness.test.ts/
 * e2e-exactly-once.test.ts/e2e-duplicate-delivery.test.ts (vitest's own
 * default file-level parallelism): File A releases the lock the instant
 * its OWN build finishes and immediately calls `spawnWorker()`, but
 * nothing stops File B from acquiring the now-free lock and starting ITS
 * OWN build (wiping `apps/worker/dist/` via `nest build`'s
 * `deleteOutDir: true`) in the narrow window before File A's
 * `spawn('node', [MAIN_JS_PATH])` actually resolves `dist/main.js` from
 * disk. The result: a REAL, reproduced failure — `Error: Cannot find
 * module '.../apps/worker/dist/main.js'`, `MODULE_NOT_FOUND`, exit code 1
 * — not a flaky assertion.
 *
 * A FIRST FIX (holding the SAME build lock through the entire spawn +
 * `waitForHealth()` — i.e., until the app is FULLY ready, DB/Redis
 * connections and all) closed the race but created a worse problem: it
 * serializes every heavy worker-spawning test file's ENTIRE boot sequence
 * (containers, migrations, DI wiring) behind one global lock, and under
 * this suite's real concurrent load (multiple files each booting their
 * own Postgres+Redis testcontainers) that pushed several files' `beforeAll`
 * hooks past their own timeouts waiting for a lock that wouldn't free up
 * — reproduced directly, not theorized. The actual race this lock needs
 * to close is much narrower: only the instant `spawn()` resolves
 * `dist/main.js` from disk. Once a child process has SURVIVED a couple of
 * seconds without exiting, Node has already loaded `main.js` and every
 * module it `require()`s into memory — nothing about that ALREADY-RUNNING
 * process cares if the file on disk is later rewritten, no matter how
 * long the REST of its boot (DB connections, DI wiring) still takes.
 *
 * So the lock is held only from right before `spawn()` through
 * `waitForImmediateCrash()`'s short, fast-polled settle window
 * (`SPAWN_SETTLE_MS`) — not through the caller's own (potentially much
 * slower) `waitForHealth()` call, which the caller still makes
 * afterward, lock-free. A file with multiple sequential spawns (like
 * e2e-kill-recovery.test.ts's three killed workers plus one recovery
 * worker) calls this once per spawn — each call is its own short-lived
 * critical section, not one held for the file's entire lifetime.
 */
export async function spawnWorkerExclusively(
  env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcess; getOutput: () => string }> {
  await acquireBuildLock(BUILD_LOCK_PATH, BUILD_LOCK_TIMEOUT_MS, BUILD_LOCK_POLL_MS);

  try {
    const spawned = spawnWorker(env);
    await waitForImmediateCrash(spawned.child, SPAWN_SETTLE_MS, spawned.getOutput);
    return spawned;
  } finally {
    fs.rmSync(BUILD_LOCK_PATH, { recursive: true, force: true });
  }
}

export async function waitForHealth(
  child: ChildProcess,
  port: number,
  getOutput: () => string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt succeeded';

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `pipeline-harness: worker child process exited before /health ever answered ` +
          `(code=${child.exitCode}, signal=${child.signalCode}) — output:\n${getOutput()}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200 || response.status === 503) return;
      lastError = `unexpected status ${response.status} from /health`;
    } catch (error: unknown) {
      lastError = describeError(error);
    }

    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    `pipeline-harness: worker /health did not answer within ${timeoutMs}ms — last error: ${lastError}\n` +
      `output:\n${getOutput()}`,
  );
}

/** Deliberately does not check `response.ok` — health.controller.ts's own
 * header: "Always computes and returns the full body ... regardless of
 * health... The ONLY thing that differs... is the HTTP status code
 * itself", so the 503 branch's body is exactly as usable as the 200
 * branch's. */
export async function fetchHealth(port: number): Promise<WorkerHealthStatus> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return (await response.json()) as WorkerHealthStatus;
}

/** SIGTERMs `child` and waits for it to exit, SIGKILLing on timeout — a
 * no-op if the process has already exited. */
export async function stopWorkerProcess(
  child: ChildProcess,
  getOutput: () => string,
  timeoutMs = STOP_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exitPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `pipeline-harness: worker child process did not exit within ${timeoutMs}ms after SIGTERM — ` +
            `force-killed. Output so far:\n${getOutput()}`,
        ),
      );
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  child.kill('SIGTERM');
  await exitPromise;
}
