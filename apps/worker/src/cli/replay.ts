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

// [review round 1, database-reviewer finding] MAX_BATCH_SIZE bounds
// `--batch-size` the same way `apps/worker/src/env.ts`'s `EVENT_BATCH_SIZE`
// already bounds the live path's own batch trigger (`.max(500)`, that
// schema's own comment): each replayed row binds all 31 `events` columns
// (schema/events.ts), and `insertEventsBatch` (packages/core/src/db/
// events.ts) issues one multi-row INSERT per batch, so Postgres's own
// ~65,535-parameter-per-statement ceiling divided by 31 is ~2,114 — the
// hard, driver-enforced limit. 500 is used here instead of that raw
// ceiling, matching `EVENT_BATCH_SIZE`'s own choice and
// `DEFAULT_REPLAY_BATCH_SIZE`'s own header (replay-driver.ts: "so replay
// never issues a larger single INSERT than the live path ever does") —
// an operator overriding `--batch-size` should never be able to make a
// replay less safe, parameter-wise, than the live flush path already is.
// Without this bound, `--batch-size 3000` (a plausible "meant 300" typo)
// would sail past `parseReplayArgs` cleanly and only fail once a batch
// actually filled, as an opaque Postgres "too many parameters" error —
// exactly the class of failure this file's own docstring elsewhere
// promises never happens ("the message always names which flag, so an
// operator never has to guess").
const MAX_BATCH_SIZE = 500;

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
    // [review round 2, database-reviewer finding] `Number.parseInt`
    // stops at the first non-digit rather than requiring the WHOLE
    // string to be numeric — `Number.parseInt('500abc', 10)` is `500`,
    // and `Number.isInteger(500)` is `true`, so `--batch-size 500abc`
    // would otherwise sail through as a silently-guessed `500`. The
    // full-string check below closes that gap before `parseInt` is ever
    // trusted, matching this function's own "fail loudly, name the
    // flag" discipline rather than silently accepting trailing garbage.
    const isFullyNumeric = /^\d+$/.test(rawBatchSize);
    const parsed = Number.parseInt(rawBatchSize, 10);
    if (!isFullyNumeric || !Number.isInteger(parsed) || parsed <= 0) {
      throw new ReplayArgsError(`posta replay: --batch-size "${rawBatchSize}" must be a positive integer`);
    }
    if (parsed > MAX_BATCH_SIZE) {
      throw new ReplayArgsError(
        `posta replay: --batch-size "${rawBatchSize}" exceeds the maximum of ${MAX_BATCH_SIZE} ` +
          '(matches EVENT_BATCH_SIZE\'s own production ceiling — apps/worker/src/env.ts)',
      );
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

/** [review round 1, silent-failure-hunter finding] A `--tenant` that
 * matches zero of the records genuinely present in `[from, to]` is not an
 * error (exit stays 0 — the range and the tool both worked correctly;
 * the tenant simply has nothing there) and not necessarily a mistake
 * (an operator sizing a job ahead of time, per `--dry-run`'s own stated
 * purpose, might reasonably probe a tenant that turns out to be empty
 * for that window). But a silent `0 batches, exit 0` gives an operator
 * NO way to tell "this tenant genuinely has nothing here" apart from
 * "I fat-fingered the tenant id" — this warning exists only to close
 * that gap, never to change the exit code or refuse the (correct, if
 * empty) result. Fires identically for `--dry-run` (matchedCount) and a
 * real replay (batchesWritten) — `replayEventLog`'s own contract flushes
 * whatever matched at least once at the end of the stream (see
 * replay-driver.ts's own `flushBuffer` call after its loop), so
 * `batchesWritten === 0` with `recordsRead > 0` can ONLY mean "the
 * filter matched nothing," never "matched something too small to flush."
 * Silent when `tenantId` is unset (no filter to have matched nothing) or
 * `recordsRead === 0` (an empty range is already a distinct, visible
 * signal via the success line's own "read 0 record(s)"). */
function warnIfTenantMatchedNothing(
  stderr: (line: string) => void,
  tenantId: string | undefined,
  recordsRead: number,
  matchedCount: number,
): void {
  if (tenantId === undefined || recordsRead === 0 || matchedCount > 0) return;

  stderr(
    `posta replay: --tenant "${tenantId}" matched 0 of ${recordsRead} record(s) read in range — ` +
      'not an error, but double-check the tenant id if that is unexpected.',
  );
}

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
      let totalRead = 0;
      for await (const record of streamEventLog(deps.r2Client, deps.r2Bucket, prefixes)) {
        totalRead += 1;
        if (matchesTenant(record)) matchedCount += 1;
      }
      warnIfTenantMatchedNothing(stderr, tenantId, totalRead, matchedCount);
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

    warnIfTenantMatchedNothing(stderr, tenantId, summary.recordsRead, summary.batchesWritten);
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
// the writer-role Postgres URL and the R2 fields `createR2Client` needs.
// `WORKER_PORT`/`EVENT_BATCH_SIZE`/`EVENT_BATCH_INTERVAL_MS`/
// `SHUTDOWN_TIMEOUT_MS`/`LOG_LEVEL`/`NODE_ENV` all govern the
// long-running BullMQ consumer process (main.ts) and are irrelevant to a
// one-shot replay run — requiring them here would fail this CLI's own
// startup on missing config that has nothing to do with replay.
//
// [T3.7.6] `R2_ACCOUNT_ID`, unlike those, IS included — this CLI is a
// disaster-recovery tool that has to reach the SAME production R2
// bucket, addressed the SAME way, as the live worker already does
// (T3.7.5, env.ts). `createR2Client` (packages/core/src/r2/client.ts,
// T3.7.4) reads `R2_ACCOUNT_ID` to DERIVE `R2_ENDPOINT` when that var is
// left empty — R2's own documented production shape — so a replay run
// pointed at production (`R2_ENDPOINT` unset, only `R2_ACCOUNT_ID` set)
// needs this schema to accept that value, and `main()` below to forward
// it, the same way apps/worker's own `main.ts` already does
// (`env.R2_ACCOUNT_ID` -> `AppModuleConfig.r2AccountId` ->
// `createR2Client`). Before this task, the field was left out on the
// grounds that "nothing ever actually reads it" — true when written,
// false since T3.7.5 landed R2_ACCOUNT_ID support in the worker's own
// path; the omission meant a production replay run with only
// R2_ACCOUNT_ID set would pass THIS schema's old (narrower) validation
// yet still crash one layer down, inside `createR2Client` itself, the
// first time it tried to resolve an endpoint from nothing.
const replayEnvSchemaObject = z.object({
  DATABASE_URL_WORKER: zUrl,
  // Mirrors env.ts's own R2_ACCOUNT_ID field exactly: OPTIONAL and
  // UNTRIMMED at the schema-field level (trimming happens in the
  // `.superRefine` below, not here) — see
  // `requireAtLeastOneReplayR2AddressingVar`'s own doc comment for why.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: zNonEmpty,
  R2_SECRET_ACCESS_KEY: zNonEmpty,
  R2_BUCKET_EVENTS: zNonEmpty,
  R2_ENDPOINT: zOptionalUrl,
});

/**
 * [T3.7.6] The same cross-field rule env.ts's own
 * `requireAtLeastOneR2AddressingVar` enforces for the worker's boot path,
 * duplicated here rather than imported — env.ts does not export that
 * function (only `workerEnvSchema`/`WorkerEnv`), and this schema
 * intentionally stays its OWN narrower type rather than a re-export of
 * `workerEnvSchema`'s shape (see this file's own header, above). Same
 * trim-before-check discipline, same both-keys-named message, same
 * both-issues-on-both-paths shape, for the same reason: `loadEnv`
 * (packages/contracts/src/env.ts) derives its `EnvFailure.key` from
 * `issue.path[0]`, one entry per distinct key, so adding the issue on
 * BOTH `R2_ENDPOINT` and `R2_ACCOUNT_ID` is what makes `main()`'s own
 * `formatEnvFailures()` report name both variables to an operator,
 * instead of just one.
 */
function requireAtLeastOneReplayR2AddressingVar(
  values: Pick<z.input<typeof replayEnvSchemaObject>, 'R2_ENDPOINT' | 'R2_ACCOUNT_ID'>,
  ctx: z.RefinementCtx,
): void {
  // [mirrors env.ts's own fix, T3.7.5 security review, MEDIUM] Trim
  // before checking presence — R2_ACCOUNT_ID's own `z.string().optional()`
  // does no trimming (unlike zNonEmpty), so a whitespace-only value must
  // be rejected explicitly here rather than assumed to read as "set".
  // Without this, R2_ACCOUNT_ID: '   ' would sail past this check and
  // only be caught one layer down, inside createR2Client's own format
  // regex — the exact bug env.ts's own history already records.
  const hasEndpoint = values.R2_ENDPOINT !== '';
  const hasAccountId = (values.R2_ACCOUNT_ID ?? '').trim() !== '';

  if (hasEndpoint || hasAccountId) return;

  const message =
    'R2_ENDPOINT and R2_ACCOUNT_ID are both empty — set one of them. R2_ENDPOINT for local ' +
    'dev (MinIO), or leave it empty and set R2_ACCOUNT_ID for production R2.';

  ctx.addIssue({ code: 'custom', path: ['R2_ENDPOINT'], message });
  ctx.addIssue({ code: 'custom', path: ['R2_ACCOUNT_ID'], message });
}

export const replayEnvSchema = replayEnvSchemaObject.superRefine(requireAtLeastOneReplayR2AddressingVar);

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
    // [T3.7.6] Same conditional-spread discipline as apps/worker/src/
    // app.module.ts's own `buildProductionFlush` — `R2ClientConfig.
    // accountId` is `accountId?: string` (no `| undefined`), and this
    // repo builds with `exactOptionalPropertyTypes`, so an omitted
    // `env.R2_ACCOUNT_ID` must become a genuinely OMITTED key here, never
    // an explicit `accountId: undefined`.
    ...(env.R2_ACCOUNT_ID !== undefined ? { accountId: env.R2_ACCOUNT_ID } : {}),
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
    /* v8 ignore next -- runReplayCli's own docstring guarantees it never
     * throws: every failure mode it can hit (bad args, a real R2/
     * Postgres error) is caught internally and reflected in its
     * returned exitCode instead. This catch exists only as a defense
     * against that contract being violated by a future change, not a
     * path any real invocation can reach today. */
    runError = error;
  }

  // [review round 2, silent-failure-hunter finding 1] r2Client.destroy()
  // and dbClient.closeDb() are two INDEPENDENT resources — the previous
  // shared try/catch let a destroy() throw skip closeDb() entirely,
  // silently leaking the Postgres pool. Same discipline as migrate.ts's
  // own main(): one try/catch PER resource, each into its own variable,
  // so one failure can never prevent the other's cleanup from running.
  let r2CloseError: unknown;
  try {
    r2Client.destroy();
  } catch (error) {
    r2CloseError = error;
  }

  let dbCloseError: unknown;
  try {
    await dbClient.closeDb();
  } catch (error) {
    dbCloseError = error;
  }

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  // Fold every failure that actually happened into ONE thrown error when
  // more than one occurred, never silently dropping any of the (up to
  // three) independent failure sources above in favor of another. When
  // exactly one occurred, it is thrown as-is (preserving its own type/
  // stack) — matching this function's pre-fix single-failure behavior.
  const failures: string[] = [];
  if (runError) failures.push(`the replay itself failed with "${describe(runError)}"`);
  if (r2CloseError) failures.push(`closing the R2 client failed with "${describe(r2CloseError)}"`);
  if (dbCloseError) failures.push(`closing the db pool failed with "${describe(dbCloseError)}"`);

  if (failures.length > 1) {
    throw new Error(`posta replay: multiple failures — ${failures.join('; then, separately, ')}.`);
  }
  if (runError) throw runError;
  if (r2CloseError) throw r2CloseError;
  if (dbCloseError) throw dbCloseError;

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
    console.error('posta replay: fatal error:', error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_RUNTIME_ERROR;
  });
}
/* v8 ignore stop */
