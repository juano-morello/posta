import { describe, expect, it, vi } from 'vitest';
import { closeBoth, describeError, type CleanupStep } from './container-cleanup';

// T2.2.7 fix round 1 — this logic previously lived, untested, inside both
// pg-container.ts and redis-container.ts's own closeClientAndContainer,
// each a byte-for-byte (describeError) or structural (the attempt-both
// shape) duplicate of the other. Now that it is a single shared helper
// used by every testcontainers harness in this directory — including
// T2.6.1's upcoming app-boot harness — its failure branches are worth
// testing directly: a leaked container per test file is a real CI cost,
// and until this file existed, the branch that prevents it had never
// actually executed under a test.

function step(label: string, run: () => Promise<unknown>): CleanupStep {
  return { label, run };
}

describe('describeError', () => {
  it("returns an Error's own message", () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error thrown value', () => {
    expect(describeError('a thrown string')).toBe('a thrown string');
    expect(describeError(42)).toBe('42');
  });
});

describe('closeBoth', () => {
  it('runs both steps and resolves when neither throws', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    await expect(
      closeBoth('Widget', step('first()', first), step('second()', second)),
    ).resolves.toBeUndefined();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('still attempts the second step when the first throws, then rethrows the first error unwrapped', async () => {
    const firstError = new Error('close failed');
    const first = vi.fn().mockRejectedValue(firstError);
    const second = vi.fn().mockResolvedValue(undefined);

    await expect(closeBoth('Widget', step('first()', first), step('second()', second))).rejects.toBe(
      firstError,
    );

    // The whole point of this helper: a failing FIRST step must not skip
    // the second — this is exactly the bug that would leak a container
    // whenever a client's close() throws before container.stop() gets a
    // chance to run.
    expect(second).toHaveBeenCalledOnce();
  });

  it('rethrows the second error unwrapped when only the second step throws', async () => {
    const secondError = new Error('stop failed');
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockRejectedValue(secondError);

    await expect(closeBoth('Widget', step('first()', first), step('second()', second))).rejects.toBe(
      secondError,
    );

    expect(first).toHaveBeenCalledOnce();
  });

  it('reports BOTH errors when both steps throw, never silently dropping one', async () => {
    const first = vi.fn().mockRejectedValue(new Error('close failed'));
    const second = vi.fn().mockRejectedValue(new Error('stop failed'));

    await expect(
      closeBoth('Widget', step('first()', first), step('second()', second)),
    ).rejects.toThrow(
      'Failed to clean up the testcontainers Widget: first() failed with "close failed", ' +
        'then second() failed with "stop failed".',
    );
  });
});
