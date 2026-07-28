import net from 'node:net';

// T3.5.1 [E3, S3.5] — small, dependency-free utilities pipeline-harness.ts
// and pipeline-harness-process.ts both need. Split out purely to keep
// each of those files inside this repo's own 200-400 line/800 hard cap
// convention (CLAUDE.md's coding-style rules) — nothing here is specific
// to the pipeline harness's own domain.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CleanupStep {
  readonly label: string;
  run(): Promise<unknown>;
}

/**
 * Attempts every step in order, regardless of whether an earlier one
 * threw — mirrors packages/core/src/test/container-cleanup.ts's
 * `closeBoth` (T2.2.7 fix round 1), generalized from two steps to N and
 * reimplemented locally rather than imported: that module lives under
 * packages/core/src/test/, which is NOT re-exported through the public
 * `@posta/core/testing` subpath (packages/core/src/test/index.ts's own
 * barrel only re-exports pg-container/redis-container/pinned-tz), so
 * apps/worker has no legitimate import path to it. Same discipline,
 * generalized: if ANY step fails, every OTHER step still runs (a failing
 * worker-kill can never leak the Postgres container underneath it), and
 * if multiple steps fail, every failure is named in the thrown error —
 * never silently dropped in favor of just the first.
 */
export async function cleanupAll(resourceName: string, steps: readonly CleanupStep[]): Promise<void> {
  const failures: { label: string; error: unknown }[] = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push({ label: step.label, error });
    }
  }

  if (failures.length > 0) {
    const details = failures
      .map(({ label, error }) => `${label} failed with "${describeError(error)}"`)
      .join('; then ');
    throw new Error(`pipeline-harness: failed to clean up ${resourceName}: ${details}`);
  }
}

/** Grabs an ephemeral, currently-free TCP port on the IPv4 loopback by
 * binding a throwaway server to port 0 and reading back what the OS
 * assigned, then releasing it — the same small, bounded TOCTOU tradeoff
 * apps/worker/src/consumer/sigterm-flush.test.ts's own `getFreePort`
 * already accepts (see that file for the fuller reasoning); duplicated
 * here rather than imported since that file is a `.test.ts`, not a
 * shared module. */
export async function getFreePort(): Promise<number> {
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
