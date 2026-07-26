import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

// T0.7.12 — S0.7's start-and-answer-health smoke test. A green `docker
// build` only proves the layers assembled; it says nothing about whether
// the resulting image actually STARTS and serves traffic — a missing
// runtime dependency, an env schema that rejects what's actually
// provided, or (the case this file exists to catch) a CMD pointed at a
// path that doesn't exist all pass `docker build` clean and only surface
// here, at `docker run` time.
//
// Runs each app's REAL built image (docker-compose.yml's api/worker/web
// services, T0.7.11) as a one-off container on the same compose network
// as the real datastores. `docker compose run --rm --no-deps` reuses that
// service's env_file/environment/network wiring exactly, so this exercises
// the identical container CI and a human's `docker compose up --build -d`
// would run — not a hand-rolled `docker run` missing half that config.
// `--no-deps` only skips ALSO starting postgres/redis/minio for this
// one-off run — beforeAll below already brings them up and waits for them
// healthy, the same sequence `pnpm dev` (T0.4.6) and `dev:reset` (T0.4.7)
// use.
//
// Fails LOUDLY, never skips: every helper below throws with real context
// (docker's own stdout/stderr) on any failure, the same discipline
// tests/infra/redis-policy.test.ts uses for "is the real infra even up?".
// A missing Docker daemon, a build failure, or a container that never
// answers health all surface as a failing test, not a silently-skipped
// one.

const REPO_ROOT = process.cwd();
const SETUP_TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const TEST_TIMEOUT_MS = HEALTH_TIMEOUT_MS + 15_000;

// How often/long waitForMinioInitExit (below) polls docker inspect for the
// bootstrap container's final state. Distinct from POLL_INTERVAL_MS, which
// polls an HTTP health endpoint on a long-running service — this instead
// polls a one-shot container's exit code, and does so much faster because
// the bootstrap (an `mc alias set` + two `mc mb`) completes in well under a
// second, not the tens of seconds a service takes to become healthy.
const MINIO_INIT_POLL_INTERVAL_MS = 200;
const MINIO_INIT_TIMEOUT_MS = 30_000;

interface ImageSpec {
  service: string;
  containerPort: number;
  healthPath: string;
}

const IMAGES: ImageSpec[] = [
  { service: 'api', containerPort: 3001, healthPath: '/health' },
  { service: 'worker', containerPort: 3002, healthPath: '/health' },
  { service: 'web', containerPort: 3000, healthPath: '/' },
];

/** Runs a docker/docker-compose subcommand and throws with full context
 * (stdout+stderr) on any non-zero exit, a timeout kill, or a spawn
 * failure. Mirrors tests/boundaries/arrows.test.ts's own spawnSync +
 * result.error/result.status pattern. */
function runDocker(args: string[], timeout = SETUP_TIMEOUT_MS): string {
  const result = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout });

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

/** Starts a one-off, detached container for `service` on an ephemeral
 * published host port, reusing that service's full docker-compose.yml
 * config (env_file, environment overrides, network membership).
 * `overrideCommand`, when given, replaces the image's CMD entirely — this
 * is how the "bad CMD" guard test below exercises a broken entrypoint
 * without needing a second, hand-edited Dockerfile. */
function startContainer(service: string, containerPort: number, overrideCommand: string[] = []): string {
  const containerId = runDocker([
    'compose',
    'run',
    '--rm',
    '-d',
    '--no-deps',
    '-p',
    `0:${containerPort}`,
    service,
    ...overrideCommand,
  ]);

  if (!containerId) {
    throw new Error(`"docker compose run" for "${service}" produced no container id`);
  }
  return containerId;
}

/** The host port Docker actually published `containerPort` on — assigned
 * dynamically (`-p 0:<port>`) so parallel/repeated runs never collide on a
 * fixed host port. */
function getPublishedPort(containerId: string, containerPort: number): number {
  const output = runDocker(['port', containerId, `${containerPort}/tcp`]);
  const match = output.match(/:(\d+)\s*$/);
  if (!match) {
    throw new Error(
      `could not parse a published port for container ${containerId} from "docker port" output: "${output}"`,
    );
  }
  return Number(match[1]);
}

function isContainerRunning(containerId: string): boolean {
  const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerId], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}

function stopContainer(containerId: string): void {
  // Best-effort, deliberately not `runDocker`: a container that already
  // crashed (the bad-CMD case) may have auto-removed itself already
  // (`--rm`) — that is success, not a teardown failure, so this tolerates
  // "already gone" instead of throwing over it.
  spawnSync('docker', ['rm', '-f', containerId], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Polls `http://localhost:<port><path>` until it answers 200 or
 * `timeoutMs` elapses. Also checks the container is still running on
 * every iteration — a container that already exited (a bad CMD, a crash
 * on boot) fails IMMEDIATELY with a clear reason instead of silently
 * burning the full timeout waiting for a health check nothing will ever
 * answer. */
async function pollHealth(containerId: string, port: number, path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt succeeded';

  while (Date.now() < deadline) {
    if (!isContainerRunning(containerId)) {
      throw new Error(
        `container ${containerId} exited before ${path} ever answered healthy — ` +
          `a bad CMD/entrypoint or a crash during boot`,
      );
    }

    try {
      const response = await fetch(`http://localhost:${port}${path}`);
      if (response.ok) return;
      lastError = `unexpected status ${response.status} from ${path}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`${path} did not answer healthy within ${timeoutMs}ms — last error: ${lastError}`);
}

/** The full smoke check for one image: start it for real, wait for its
 * health endpoint, always clean up. Throws (never returns a false/skip
 * value) on any failure along the way — this is the single seam both the
 * happy-path tests and the "bad CMD" guard test below share, so the guard
 * exercises the exact same code the happy path relies on. */
async function smokeTestImage(spec: ImageSpec, overrideCommand?: string[]): Promise<void> {
  const containerId = startContainer(spec.service, spec.containerPort, overrideCommand);
  try {
    const hostPort = getPublishedPort(containerId, spec.containerPort);
    await pollHealth(containerId, hostPort, spec.healthPath, HEALTH_TIMEOUT_MS);
  } finally {
    stopContainer(containerId);
  }
}

/** Waits for the one-shot `minio-init` bootstrap container (docker-compose.yml)
 * to exit, then asserts it exited 0 — never lets a real bootstrap failure
 * pass silently.
 *
 * Deliberately does NOT use `docker compose wait`: that command lists only
 * RUNNING containers (docker/compose's `Wait` calls `ContainerList` with
 * `all=false`), so if minio-init — a script that completes in well under a
 * second — has already exited by the time `wait` runs its query, the
 * container is invisible to that query and `wait` fails with "no containers
 * for project", regardless of whether the bootstrap actually succeeded.
 * Confirmed directly against the installed docker compose: calling
 * `docker compose wait minio-init` after the container had already exited
 * reproduces that exact error every time — it is not a hypothetical, it is
 * the mechanism behind the observed CI flake.
 *
 * (A single `docker compose up -d --wait postgres redis minio minio-init`
 * looks like the obvious atomic fix, but was verified NOT to work here: the
 * `--wait` flag only treats a one-shot container's own exit as success when
 * some OTHER selected service depends on it via `condition:
 * service_completed_successfully` — and api/worker, which declare that
 * dependency, are not part of this selection. Without them, `--wait` applies
 * its default "running or healthy" condition to minio-init, sees it exited,
 * and fails the whole command even on a clean exit 0.)
 *
 * Polling `docker inspect` by a container ID captured right after `up -d`
 * has no such race: the container is never removed (`restart: "no"`, no
 * `--rm`), so inspect finds it whether it is still running or has already
 * exited — "already exited" is the expected/common case here, not a
 * fallback. This only reports success once the real exit code is read as 0;
 * a genuine bootstrap failure still throws with that exit code and the
 * container's own logs. */
async function waitForMinioInitExit(timeoutMs = MINIO_INIT_TIMEOUT_MS): Promise<void> {
  const containerId = runDocker(['compose', 'ps', '-a', '-q', 'minio-init']);
  if (!containerId) {
    throw new Error('"docker compose ps -a -q minio-init" produced no container id');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [status, exitCode] = runDocker([
      'inspect',
      '--format',
      '{{.State.Status}} {{.State.ExitCode}}',
      containerId,
    ]).split(' ');

    if (status === 'exited') {
      if (exitCode !== '0') {
        const logs = spawnSync('docker', ['logs', containerId], { encoding: 'utf8' }).stdout;
        throw new Error(`minio-init exited with code ${exitCode} — bucket bootstrap failed:\n${logs}`);
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, MINIO_INIT_POLL_INTERVAL_MS));
  }

  throw new Error(`minio-init did not exit within ${timeoutMs}ms`);
}

beforeAll(async () => {
  // Same sequence `pnpm dev` (T0.4.6) and `dev:reset` (T0.4.7) use: bring
  // the three datastores up and wait for the bucket-bootstrap one-shot to
  // finish, so api/worker/minio-dependent boot below doesn't race infra
  // that's "up" but not yet accepting connections.
  runDocker(['compose', 'up', '-d', '--wait', 'postgres', 'redis', 'minio']);
  runDocker(['compose', 'up', '-d', 'minio-init']);
  await waitForMinioInitExit();

  // Ensures the three app images actually exist and are current. This
  // test must be runnable on its own (`pnpm test
  // tests/containers/image-smoke.test.ts`), not conditional on a prior
  // `docker compose up --build` having already happened by hand.
  runDocker(['compose', 'build', 'api', 'worker', 'web']);
}, SETUP_TIMEOUT_MS);

describe('image smoke test (T0.7.12)', () => {
  for (const spec of IMAGES) {
    it(
      `${spec.service} image starts and answers ${spec.healthPath}`,
      async () => {
        await expect(smokeTestImage(spec)).resolves.toBeUndefined();
      },
      TEST_TIMEOUT_MS,
    );
  }

  // The guard itself: proves a bad CMD is caught HERE, not silently
  // shipped. Overrides the api image's real CMD (`node
  // apps/api/dist/main.js`) with a path that does not exist — the exact
  // "CMD points at a nonexistent entrypoint" case S0.7's acceptance
  // criterion names. Node starts (the binary exists), fails to find the
  // module, and exits almost immediately; smokeTestImage must observe
  // that failure and throw rather than hang out the full 30s health
  // timeout or, worse, report green.
  it(
    'fails loudly when CMD is pointed at a nonexistent entrypoint',
    async () => {
      const badEntrypointSpec: ImageSpec = { service: 'api', containerPort: 3001, healthPath: '/health' };
      await expect(
        smokeTestImage(badEntrypointSpec, ['node', '/nonexistent/entrypoint.js']),
      ).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});
