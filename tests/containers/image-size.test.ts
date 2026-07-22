import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

// T0.7.13 — S0.7's per-image size budget. Bloat is invisible until a
// rollout is slow: a stray `devDependency` that leaks into a runtime
// stage, an accidentally-uncopied .dockerignore rule, or (for the api
// image specifically, T0.7.10) a future SECOND GeoIP dataset nobody
// meant to bake in all cost nothing to notice locally and cost real pull
// time on every node. This reads the REAL built image's size via `docker
// image inspect` — never a hand-maintained "expected size" constant that
// could quietly drift from the actual artifact.
//
// Budgets (plan, S0.7): api 300MB, worker 300MB, web 250MB.

const REPO_ROOT = process.cwd();
const SETUP_TIMEOUT_MS = 180_000;
const BYTES_PER_MB = 1024 * 1024;

interface Budget {
  service: string;
  image: string;
  maxBytes: number;
}

// Image names come from docker-compose.yml's pinned `name: posta` project
// name (T0.7.11) — stable regardless of what directory this repo happens
// to be checked out into, unlike Compose's directory-basename default.
const BUDGETS: Budget[] = [
  { service: 'api', image: 'posta-api', maxBytes: 300 * BYTES_PER_MB },
  { service: 'worker', image: 'posta-worker', maxBytes: 300 * BYTES_PER_MB },
  { service: 'web', image: 'posta-web', maxBytes: 250 * BYTES_PER_MB },
];

/** Mirrors tests/boundaries/arrows.test.ts's own spawnSync +
 * result.error/result.status pattern: fail loudly with full context, never
 * a silent zero or an assertion against nothing. */
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

function getImageSizeBytes(image: string): number {
  const output = runDocker(['image', 'inspect', image, '--format', '{{.Size}}']);
  const size = Number(output);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`unexpected size output from "docker image inspect ${image}": "${output}"`);
  }
  return size;
}

beforeAll(() => {
  // Ensures the three app images actually exist and are current, so this
  // test is runnable on its own (`pnpm test
  // tests/containers/image-size.test.ts`), not conditional on
  // image-smoke.test.ts (T0.7.12) or a manual `docker compose up --build`
  // having already run first.
  runDocker(['compose', 'build', 'api', 'worker', 'web']);
}, SETUP_TIMEOUT_MS);

describe('image size budget (T0.7.13)', () => {
  for (const budget of BUDGETS) {
    it(`${budget.image} stays within its ${budget.maxBytes / BYTES_PER_MB}MB budget`, () => {
      const actualBytes = getImageSizeBytes(budget.image);
      const actualMB = (actualBytes / BYTES_PER_MB).toFixed(1);
      const maxMB = budget.maxBytes / BYTES_PER_MB;

      expect(
        actualBytes,
        `${budget.image} is ${actualMB}MB, over its ${maxMB}MB budget — a stray dependency likely leaked into the runtime stage`,
      ).toBeLessThanOrEqual(budget.maxBytes);
    });
  }
});
