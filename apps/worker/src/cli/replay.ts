import { parseArgs } from 'node:util';
import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { zNonEmpty, zOptionalUrl, zUrl, formatEnvFailures, loadEnv } from '@posta/contracts';
import {
  createDbClient,
  createR2Client,
  eventPrefixes,
  streamEventLog,
  type DbClient,
  type LoggedEvent,
} from '@posta/core';
import { replayEventLog, type ReplaySummary } from './replay-driver';

// T3.6.4 (E3, S3.6) [INV-7][INV-8] — `posta replay --from <date> --to
// <date> [--tenant <id>] [--dry-run]`, the actual operator-facing CLI
// T3.6.3's driver (replay-driver.ts) exists to be wrapped by. This file
// owns exactly three things T3.6.3 explicitly left to "a future CLI":
// parsing operator flags into a `[from, to]` range (eventPrefixes' own
// header names this file as that future caller), a `--tenant` filter
// applied to the streamed records, and `--dry-run` counting. It never
// re-implements batching or the INSERT itself — every write still goes
// through `replayEventLog` (never a second `.insert(events)`,
// never `flushBatch`/`enrich()` — see replay-driver.ts's own header for
// why re-resolving a destination at replay time would silently rewrite
// history, invariant 7).
//
// --- Where the tenant filter actually lives ---------------------------
//
// `replayEventLog` takes `prefixes` (date/hour partitions), not records —
// tenant isn't encoded in an R2 key, so there is no "hand it pre-filtered
// input" seam at that level. The cleanest seam turned out to be
// replay-driver.ts's own `ReplayDriverOptions.filter` (added by this
// task): an optional `(record: LoggedEvent) => boolean` predicate applied
// AFTER a record is streamed but BEFORE it is buffered/inserted. That
// keeps the batching loop itself — the thing T3.6.3's driver already
// built and tested — as the ONE implementation of "read from R2, batch,
// insert", with this file supplying only the predicate. `--dry-run` never
// touches that predicate/driver at all (see below).
//
// --- Why --dry-run never calls replayEventLog --------------------------
//
// `replayEventLog` always inserts once its buffer fills — there is no
// "count but don't write" mode inside it, and adding one would be a
// second, parallel meaning bolted onto a function whose whole contract is
// "write it". `--dry-run` instead calls `streamEventLog` (T3.6.2)
// directly — the exact same read primitive the driver itself uses
// underneath — and only counts matches. This also means a dry run never
// opens a write path to Postgres at all: `runReplayCli` still receives a
// `db` handle (so callers/tests can share one deps object for both modes),
// but the dry-run branch never reads it.
//
// --- Exit codes ----------------------------------------------------------
//
// 0 = completed (replayed or dry-run counted); 1 = bad arguments (an
// inverted/unparseable `--from`/`--to`, a missing required flag, or an
// unrecognized flag) — the message always names which flag, so an
// operator never has to guess; 2 = a real runtime failure (R2/Postgres
// unreachable, a corrupt NDJSON line, ...) surfaced from
// `eventPrefixes`/`streamEventLog`/`replayEventLog` themselves.

/** Thrown by {@link parseReplayArgs} — always carries a message naming the
 * offending flag, never a bare "invalid arguments". */
export class ReplayArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayArgsError';
  }
}

export interface ReplayCliOptions {
  /** Raw operator-supplied value for `--from`, already proven to parse as
   * an ISO-8601 instant — passed through to `eventPrefixes` verbatim
   * (that function does its own parsing too; this is not re-derived into
   * a different string representation here, so there is only ever one
   * place that decides what "a valid instant" means for a given raw
   * string vs. what it means for the from/to ORDER check below). */
  readonly from: string;
  readonly to: string;
  readonly tenantId?: string;
  readonly dryRun: boolean;
  /** `--batch-size` override, forwarded to `replayEventLog` (ignored in
   * `--dry-run` mode, which never buffers/inserts). Omitted uses
   * `replayEventLog`'s own {@link DEFAULT_REPLAY_BATCH_SIZE}. */
  readonly batchSize?: number;
}

/** Parses `--from`/`--to` into a `Date`, throwing a {@link ReplayArgsError}
 * that names `flag` (never a bare "invalid date") when the flag is
 * missing or its value does not parse as an ISO-8601 instant — the same
 * "throw loudly, name what failed" discipline `packages/core/src/r2/
 * keys.ts`'s own `parseInstant` already uses for the identical class of
 * input, extended here with the flag name a raw `Error` from that
 * function would not have. */
function parseRequiredDate(rawValue: string | undefined, flag: string): { raw: string; date: Date } {
  if (rawValue === undefined || rawValue.length === 0) {
    throw new ReplayArgsError(`posta replay: ${flag} is required`);
  }

  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    throw new ReplayArgsError(`posta replay: ${flag} "${rawValue}" is not a valid ISO-8601 date`);
  }

  return { raw: rawValue, date };
}

/**
 * Parses `posta replay`'s own argv (e.g. `process.argv.slice(2)`) into
 * validated {@link ReplayCliOptions}, or throws {@link ReplayArgsError}.
 * Never returns a partially-valid result and never silently drops a flag
 * — an unrecognized flag, a flag given no value, or a stray positional
 * all fail loudly via `node:util`'s own `parseArgs({ strict: true,
 * allowPositionals: false })`.
 *
 * `--from`/`--to` are REQUIRED and compared as raw instants (not
 * `eventPrefixes`' own UTC-calendar-DAY comparison) — this check is
 * strictly stronger: any pair rejected here would also fail
 * `eventPrefixes`' day-level check once `[from, to]` reaches it, but a
 * same-day pair with `from`'s time-of-day literally after `to`'s (an
 * obvious operator typo, e.g. swapped `--from`/`--to` values on the same
 * day) is exactly the "--from after --to" case the CLI's own brief names,
 * and `eventPrefixes` alone would never catch it (same-day inputs always
 * produce identical, non-erroring output there, by design — see that
 * function's own header). Catching it here, with the flag named in the
 * message, is strictly more useful to an operator than the same input
 * later silently producing a "wrong" 24/48-prefix range further downstream.
 */
export function parseReplayArgs(argv: readonly string[]): ReplayCliOptions {
  let rawFrom: string | undefined;
  let rawTo: string | undefined;
  let rawTenant: string | undefined;
  let dryRun: boolean;
  let rawBatchSize: string | undefined;

  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        tenant: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'batch-size': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
    rawFrom = values.from;
    rawTo = values.to;
    rawTenant = values.tenant;
    dryRun = values['dry-run'] ?? false;
    rawBatchSize = values['batch-size'];
  } catch (cause) {
    throw new ReplayArgsError(
      `posta replay: failed to parse arguments: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const from = parseRequiredDate(rawFrom, '--from');
  const to = parseRequiredDate(rawTo, '--to');

  if (from.date.getTime() > to.date.getTime()) {
    throw new ReplayArgsError(
      `posta replay: --from ("${from.raw}") is after --to ("${to.raw}") — check for swapped flags`,
    );
  }

  let batchSize: number | undefined;
  if (rawBatchSize !== undefined) {
    const parsed = Number.parseInt(rawBatchSize, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ReplayArgsError(`posta replay: --batch-size "${rawBatchSize}" must be a positive integer`);
    }
    batchSize = parsed;
  }

  return {
    from: from.raw,
    to: to.raw,
    dryRun,
    ...(rawTenant !== undefined ? { tenantId: rawTenant } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
  };
}

export interface ReplayCliDeps {
  readonly db: DbClient['db'];
  /** The already-constructed S3-compatible client (createR2Client,
   * T3.4.1) — built once by whoever wires up this CLI (main(), below),
   * never here — same "construct once, close over deps" discipline every
   * other consumer of this client already follows. */
  readonly r2Client: S3Client;
  readonly r2Bucket: string;
  /** Defaults to `console.log`/`console.error`. Injectable so
   * replay.test.ts can capture output instead of asserting against real
   * stdout/stderr. */
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

export interface ReplayCliResult {
  readonly exitCode: number;
  /** Set only in `--dry-run` mode. */
  readonly matchedCount?: number;
  /** Set only in a real (non-dry-run) replay. */
  readonly summary?: ReplaySummary;
}

const EXIT_OK = 0;
const EXIT_ARGS_ERROR = 1;
const EXIT_RUNTIME_ERROR = 2;

/**
 * Runs one `posta replay` invocation end to end: parse argv, compute the
 * `[from, to]` prefix range (`eventPrefixes`, T3.6.1), then either count
 * tenant-matching records (`--dry-run`) or replay them through
 * `replayEventLog` (T3.6.3) with a tenant filter applied. Never throws —
 * every failure mode (bad args, a real R2/Postgres error) is reported via
 * `deps.stderr` and reflected in the returned `exitCode`, so a caller
 * (this file's own `main()`, or a test) never needs its own top-level
 * try/catch around this function specifically.
 */
export async function runReplayCli(
  argv: readonly string[],
  deps: ReplayCliDeps,
): Promise<ReplayCliResult> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  let options: ReplayCliOptions;
  try {
    options = parseReplayArgs(argv);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return { exitCode: EXIT_ARGS_ERROR };
  }

  const tenantId = options.tenantId;
  const matchesTenant = (record: LoggedEvent): boolean =>
    tenantId === undefined || record.tenant_id === tenantId;

  try {
    const prefixes = eventPrefixes(options.from, options.to);

    if (options.dryRun) {
      let matchedCount = 0;
      for await (const record of streamEventLog(deps.r2Client, deps.r2Bucket, prefixes)) {
        if (matchesTenant(record)) matchedCount += 1;
      }
      stdout(
        `posta replay --dry-run: ${matchedCount} record(s) would be replayed` +
          (tenantId !== undefined ? ` for tenant "${tenantId}"` : '') +
          ', 0 inserted',
      );
      return { exitCode: EXIT_OK, matchedCount };
    }

    const summary = await replayEventLog({
      db: deps.db,
      r2Client: deps.r2Client,
      r2Bucket: deps.r2Bucket,
      prefixes,
      ...(tenantId !== undefined ? { filter: matchesTenant } : {}),
      ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    });

    stdout(
      `posta replay: read ${summary.recordsRead} record(s), wrote ${summary.batchesWritten} batch(es)` +
        (tenantId !== undefined ? ` (filtered to tenant "${tenantId}")` : ''),
    );
    return { exitCode: EXIT_OK, summary };
  } catch (error) {
    stderr(`posta replay: failed: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: EXIT_RUNTIME_ERROR };
  }
}

// --- Real CLI entrypoint (`node dist/cli/replay.js` / a future `posta
// replay` wrapper) ---------------------------------------------------
//
// Deliberately its OWN, narrower env schema — not apps/worker's
// `workerEnvSchema` (env.ts) — scoped to exactly what this CLI touches:
// the writer-role Postgres URL and the four R2 fields `createR2Client`
// needs. `WORKER_PORT`/`EVENT_BATCH_SIZE`/`EVENT_BATCH_INTERVAL_MS`/
// `SHUTDOWN_TIMEOUT_MS`/`LOG_LEVEL`/`NODE_ENV`/`R2_ACCOUNT_ID` all govern
// the long-running BullMQ consumer process (main.ts) and are irrelevant
// to a one-shot replay run — requiring them here would fail this CLI's
// own startup on missing config that has nothing to do with replay.
// `R2_ACCOUNT_ID` in particular: `workerEnvSchema` validates it, but
// (like main.ts's own `buildProductionFlush`, apps/worker/src/
// app.module.ts) nothing ever actually reads it — `createR2Client`'s
// `endpoint` comes from `R2_ENDPOINT` alone.
const replayEnvSchema = z.object({
  DATABASE_URL_WORKER: zUrl,
  R2_ACCESS_KEY_ID: zNonEmpty,
  R2_SECRET_ACCESS_KEY: zNonEmpty,
  R2_BUCKET_EVENTS: zNonEmpty,
  R2_ENDPOINT: zOptionalUrl,
});

/**
 * The real `posta replay` CLI entrypoint: validates env (fail-fast, same
 * contract as apps/worker/src/main.ts), builds a real `DbClient`/R2
 * client from it, runs `runReplayCli` against real `process.argv`, and
 * closes both resources afterward — capturing-and-combining a resource
 * cleanup failure with a run failure rather than letting the cleanup
 * failure silently replace it, the same discipline every CLI entrypoint
 * in this codebase already follows (packages/core/src/db/migrate.ts,
 * seed.ts, seed-asn.ts, migrate-down.ts).
 *
 * Exported (not only reached via the `require.main` guard below) so
 * replay.test.ts can exercise this real, env-driven entrypoint directly
 * against a real Postgres/MinIO — the same "main() itself is fully
 * covered above" pattern migrate.test.ts already establishes for
 * migrate.ts's own `main()`. Sets `process.exitCode` rather than calling
 * `process.exit()` directly — the latter would kill the test process
 * itself the moment a test imports and calls this function.
 */
export async function main(): Promise<void> {
  const envResult = loadEnv(replayEnvSchema, process.env);
  if (!envResult.ok) {
    console.error(formatEnvFailures(envResult.failures));
    process.exitCode = EXIT_ARGS_ERROR;
    return;
  }
  const env = envResult.data;

  const dbClient = createDbClient({ connectionString: env.DATABASE_URL_WORKER });
  const r2Client = createR2Client({
    endpoint: env.R2_ENDPOINT,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_EVENTS,
  });

  let runError: unknown;
  let result: ReplayCliResult | undefined;
  try {
    result = await runReplayCli(process.argv.slice(2), {
      db: dbClient.db,
      r2Client,
      r2Bucket: env.R2_BUCKET_EVENTS,
    });
  } catch (error) {
    runError = error;
  }

  let closeError: unknown;
  try {
    r2Client.destroy();
    await dbClient.closeDb();
  } catch (error) {
    closeError = error;
  }

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  if (runError && closeError) {
    throw new Error(
      `posta replay: failed with "${describe(runError)}", then closing resources also failed with ` +
        `"${describe(closeError)}".`,
    );
  }
  if (runError) throw runError;
  if (closeError) throw closeError;

  process.exitCode = result?.exitCode ?? EXIT_RUNTIME_ERROR;
}

// Only run main() when executed directly (`node dist/cli/replay.js`), not
// when imported by replay.test.ts — same guard, same "CLI-bootstrap
// wiring, not testable logic" v8-ignore rationale as migrate.ts's own
// (packages/core/src/db/migrate.ts). `require.main` is the test runner's
// own entry module under vitest, never this file, so this branch can
// never be true in a test process.
/* v8 ignore start */
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('posta replay: fatal error:', error instanceof Error ? error.message : error);
    process.exitCode = EXIT_RUNTIME_ERROR;
  });
}
/* v8 ignore stop */
