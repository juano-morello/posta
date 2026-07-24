// T2.2.7 fix round 1 — extracted out of pg-container.ts (T1.1.2) and
// redis-container.ts (T2.2.7), which had independently grown the SAME
// "attempt both, report both on double failure, rethrow the survivor"
// cleanup shape: describeError was byte-for-byte identical in both files,
// and closeClientAndContainer reimplemented the same structure twice,
// differing only in resource types and message wording. That discipline is
// subtle and load-bearing — it exists so a failing client-close can't leak
// the container underneath it — so it belongs in exactly one place, not
// two that a future correction has to remember to update in lockstep.
// Every testcontainers harness in this directory calls this module now;
// per-harness wording stays informative (which resource, which operation)
// via the `label` on each {@link CleanupStep}, rather than flattening to
// something generic enough to be useless when debugging a leaked
// container.

/** Stringifies an unknown thrown value for an error message — an
 * `Error`'s own `message`, or `String(error)` for anything else (a thrown
 * string, a rejected non-Error value, ...). Shared by every testcontainers
 * harness in this directory so a non-Error rejection renders consistently
 * wherever cleanup fails. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One half of a two-step cleanup: `label` is what a failure message calls
 * this step (e.g. `'closeDb()'`, `'client.quit()'`, `'container.stop()'`),
 * `run` performs it. `run`'s own resolved value is discarded — cleanup
 * steps are run for their side effect, not their result — so `Promise<unknown>`
 * (rather than `Promise<void>`) lets a caller pass a bound method like
 * ioredis's `client.quit` (which resolves to `'OK'`) directly as `run`
 * without an extra wrapper arrow just to discard the type.
 */
export interface CleanupStep {
  readonly label: string;
  run(): Promise<unknown>;
}

/**
 * Runs `first` then `second`, UNCONDITIONALLY attempting both even if
 * `first` throws — a plain `await first.run(); await second.run();`
 * sequence would skip `second` (and leak whatever it was meant to tear
 * down, typically a container) whenever `first` throws, since the second
 * statement would never run. If both fail, the thrown error's message
 * names both failures (never just the first, silently dropping the
 * second) — the same guarantee pg-container.ts's own header comment
 * described before this was extracted. If only one step fails, that
 * step's OWN error is rethrown unchanged, not wrapped, so a caller's
 * `.catch()` or `expect(...).rejects` still sees the original error type
 * and message.
 *
 * `resourceName` (e.g. `'Postgres'`, `'Redis'`) names the harness in the
 * combined double-failure message — `"Failed to clean up the
 * testcontainers ${resourceName}: ..."` — so a failure is traceable to
 * which harness produced it without inspecting a stack trace first.
 */
export async function closeBoth(
  resourceName: string,
  first: CleanupStep,
  second: CleanupStep,
): Promise<void> {
  let firstError: unknown;
  try {
    await first.run();
  } catch (error) {
    firstError = error;
  }

  let secondError: unknown;
  try {
    await second.run();
  } catch (error) {
    secondError = error;
  }

  if (firstError && secondError) {
    throw new Error(
      `Failed to clean up the testcontainers ${resourceName}: ${first.label} failed with ` +
        `"${describeError(firstError)}", then ${second.label} failed with ` +
        `"${describeError(secondError)}".`,
    );
  }
  if (firstError) throw firstError;
  if (secondError) throw secondError;
}
