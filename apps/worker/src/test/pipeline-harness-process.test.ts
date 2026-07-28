import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireBuildLock } from './pipeline-harness-process';

// Fix-forward, discovered after T3.5.1 landed — not tied to a plan task
// ID. `buildWorkerExclusively`'s cross-process build mutex crashed with
// an unhandled ENOENT when two harness-using test files raced each
// other: `nest build`'s own `deleteOutDir: true` wipes and recreates
// apps/worker/dist/ wholesale on every build, and (before this fix) the
// lock lived INSIDE that directory — so a second process polling for the
// lock could catch the first process's build mid-wipe and see "parent
// directory doesn't exist" (ENOENT) rather than "lock already exists"
// (EEXIST), which the retry loop's catch block did not tolerate.
//
// The real fix is two-part (see pipeline-harness-process.ts's own
// comments on BUILD_LOCK_PATH and acquireBuildLock for the full
// reasoning): the lock now lives OUTSIDE apps/worker/dist/ entirely, so
// in production this exact ENOENT can no longer occur — but the retry
// loop also tolerates ENOENT as defense-in-depth, exactly the way it
// already tolerates EEXIST. This file proves THAT tolerance in
// isolation: a genuine two-OS-process race is not deterministically
// reproducible in a single unit test without mocking `fs`, so
// `acquireBuildLock` (extracted from `buildWorkerExclusively` for
// exactly this reason — see its own header) is driven here with a
// mocked `fs.mkdirSync` that manufactures the ENOENT this bug actually
// hit, plus its own short, injected timeout/poll parameters so this
// suite runs in milliseconds rather than needing BUILD_LOCK_TIMEOUT_MS's
// real ~180s ceiling.
describe('acquireBuildLock — tolerates a transient ENOENT on the lock path (fix-forward past T3.5.1)', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-harness-lock-'));
    // Nested one level down: acquireBuildLock's own first line
    // (`fs.mkdirSync(path.dirname(lockPath), { recursive: true })`) must
    // create this parent for the lock itself to be creatable at all,
    // matching the real BUILD_LOCK_PATH's own shape (a path inside a
    // directory that must itself be (re)created).
    lockPath = path.join(tempDir, 'nested', '.pipeline-harness-build.lock');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('retries past one ENOENT on the lock path and still acquires the lock, rather than crashing', async () => {
    const realMkdirSync = fs.mkdirSync;
    let lockAttempts = 0;

    // Only the call that targets the lock path ITSELF is intercepted;
    // every other mkdirSync call (recreating the lock's parent) always
    // falls through to the real filesystem — mirroring exactly which
    // call, in production, raced `nest build`'s deleteOutDir.
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (target === lockPath) {
        lockAttempts += 1;
        if (lockAttempts === 1) {
          const error = new Error('ENOENT: no such file or directory, mkdir') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
      }
      return realMkdirSync(target, options);
    }) as typeof fs.mkdirSync);

    await expect(acquireBuildLock(lockPath, 5_000, 5)).resolves.toBeUndefined();

    // Proves the retry actually happened (not a fluke first-attempt
    // success) and that the lock is genuinely held afterward.
    expect(lockAttempts).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('still rethrows immediately for a non-retryable mkdirSync error code (e.g. EACCES)', async () => {
    const realMkdirSync = fs.mkdirSync;

    vi.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (target === lockPath) {
        const error = new Error('EACCES: permission denied, mkdir') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return realMkdirSync(target, options);
    }) as typeof fs.mkdirSync);

    await expect(acquireBuildLock(lockPath, 5_000, 5)).rejects.toThrow(/EACCES/);
  });

  it('still enforces the deadline and names the lock path when the lock is never released', async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.mkdirSync(lockPath); // Simulates another process holding the lock forever.

    await expect(acquireBuildLock(lockPath, 50, 5)).rejects.toThrow(
      new RegExp(`timed out.*${lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 's'),
    );
  });
});
