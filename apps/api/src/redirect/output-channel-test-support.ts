import { vi } from 'vitest';

// [S2.4 fan-out fix round, security] Shared between capture-privacy.test.ts
// (T2.3.8) and enqueue-logging.test.ts (T2.4.4) — both suites exist to
// prove a secret/IP/capture-signal value is ABSENT from every output
// channel this codebase's loggers could write to, and both independently
// reimplemented the identical capture mechanism (~77 lines apiece). A
// story-level review found the two copies had already drifted —
// stringifyLoggable included the error stack in one copy and only
// name/message in the other — which is exactly the failure mode
// duplicated SECURITY-PROOF helpers create: if one copy's channel sweep
// is later extended and the other isn't, one of the two suites silently
// stops covering what it claims to. Consolidated here, once, so both
// files share the same "leaks nowhere" definition by construction rather
// than by two authors remembering to keep two copies in sync.
//
// Every logger in this codebase writes only to console (see
// consoleErrorLogger in middleware.ts, enqueue.ts's own EnqueueFailureLogger
// shape, geoip/lookup.ts, redis/salt.ts, partition-maintenance.job.ts — no
// pino instance is wired up anywhere yet), so capturing every console
// method PLUS raw stdout/stderr writes IS capturing "any injected logger"
// for this codebase as it exists today. If a future logger writes
// somewhere else entirely (a direct socket to a log aggregator, say),
// this channel list would need extending — noted as a known limit, not
// silently assumed away.
//
// [NOT a *.test.ts file] Mirrors resolve-test-support.ts's own reasoning
// (T2.2.5's fix round): apps/api/tsconfig.json's production build
// excludes `src/**/*.test.ts` but NOT a plain `.ts` file with shared
// fixtures, so this file IS swept into the production build — same as
// that file, importing `vitest`'s `vi` here is already an established,
// working pattern in this codebase, not a new risk introduced by this
// split.

/**
 * Turns any value this codebase's loggers might be handed into a string
 * for leak-checking. Consolidates the two shapes fix round 1's review
 * found had drifted apart (one kept the stack and dropped the name, the
 * other kept the name and dropped the stack) into one STRICT SUPERSET:
 * since both consuming suites exist to prove a secret is ABSENT, the more
 * thorough serialisation is the only correct choice — a version that
 * omitted the stack could hide a leak that lives there.
 */
export function stringifyLoggable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function recordChunk(chunks: string[], chunk: unknown): void {
  if (typeof chunk === 'string') {
    chunks.push(chunk);
    return;
  }
  if (Buffer.isBuffer(chunk)) {
    chunks.push(chunk.toString('utf8'));
    return;
  }
  chunks.push(stringifyLoggable(chunk));
}

export interface CapturedChannels {
  getOutput(): string;
  restore(): void;
}

/** Spies on every console method a stray leak could use, plus raw
 * process.stdout/stderr writes — see this file's own header for why that
 * covers "any injected logger" in this codebase specifically. */
export function captureAllOutputChannels(): CapturedChannels {
  const chunks: string[] = [];
  const recordArgs = (...args: unknown[]): void => {
    chunks.push(args.map(stringifyLoggable).join(' '));
  };

  type WriteFn = typeof process.stdout.write;
  const writeRecorder = ((chunk: unknown) => {
    recordChunk(chunks, chunk);
    return true;
  }) as WriteFn;

  const spies = [
    vi.spyOn(console, 'log').mockImplementation(recordArgs),
    vi.spyOn(console, 'warn').mockImplementation(recordArgs),
    vi.spyOn(console, 'error').mockImplementation(recordArgs),
    vi.spyOn(console, 'debug').mockImplementation(recordArgs),
    vi.spyOn(console, 'info').mockImplementation(recordArgs),
    vi.spyOn(process.stdout, 'write').mockImplementation(writeRecorder),
    vi.spyOn(process.stderr, 'write').mockImplementation(writeRecorder),
  ];

  return {
    getOutput: () => chunks.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

export interface RecordedLogCall {
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * The minimal logger shape both callers' own domain types (capture-privacy
 * .test.ts's CapturePipelineLogger, enqueue.ts's EnqueueFailureLogger)
 * already share structurally — `{ error(message, meta?) }`. Returning
 * this exact shape means createRecordingLogger's result is assignable to
 * EITHER caller's own named type with no cast needed; the two domain
 * types stay separately named on purpose (each names the tier it
 * protects), only the recording IMPLEMENTATION is shared.
 */
export interface RecordingLoggerLike {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A logger that BOTH forwards to console.error (so captureAllOutputChannels
 * sees it, matching every real logger in this codebase) AND keeps its own
 * call log (so a test can inspect exactly what was logged directly,
 * independent of the console-capture mechanism). */
export function createRecordingLogger(calls: RecordedLogCall[]): RecordingLoggerLike {
  return {
    error(message, meta) {
      calls.push(meta !== undefined ? { message, meta } : { message });
      console.error(message, meta);
    },
  };
}
