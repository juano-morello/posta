import { z } from 'zod';
import { zNonEmpty, zOptionalUrl, zPort, zUrl } from '@posta/contracts';

// T0.3.6 — the worker's Zod env schema (S0.3). The worker is a separate
// BullMQ consumer process: it drains Redis, enriches, and writes events
// to Postgres *and* R2 (invariant 7). It does NOT classify (invariant
// 4 — no human/bot verdict is ever computed or stored here) and it
// deliberately has NO geo config: geo/ASN lookup happens once, in the
// API, at capture time, before the raw IP is dropped (invariant 6,
// T0.7.10). Giving the worker a GeoIP path here would be a second place
// that could silently drift from that rule.
//
// DATABASE_URL_WORKER (not DATABASE_URL) — the worker connects as the
// writer role while the API connects as a reader with no SELECT on raw
// `events` (T4.2.4). Two roles means two URLs, wired from the start
// even though the privilege separation itself lands later.

// [T3.7.7] WORKER_CONCURRENCY's own default (the plan's own "default 8").
// Originally defined in events.consumer.ts (T3.5.4) — the one place the
// var was read, before this task added it to the schema below. Moved
// here so it has exactly one definition: events.consumer.ts's own
// readWorkerConcurrency() now IMPORTS this constant instead of declaring
// a second, independent `= 8` that could silently drift from this
// schema's own field default.
export const DEFAULT_WORKER_CONCURRENCY = 8;

const workerEnvSchemaObject = z.object({
  // Datastores — writer role (see file header). No domain/auth vars: the
  // worker builds no URLs and serves no auth-gated routes.
  DATABASE_URL_WORKER: zUrl,
  REDIS_URL: zUrl,

  // Cloudflare R2 — only what writing events needs: credentials, the
  // events bucket, and the endpoint override. NOT R2_BUCKET_AVATARS —
  // avatar upload is a dashboard/API concern, not the worker's.
  //
  // [T3.7.5] R2_ACCOUNT_ID is OPTIONAL (unlike the zNonEmpty this used to
  // be) — createR2Client (packages/core/src/r2/client.ts, T3.7.4) reads
  // it only to DERIVE R2_ENDPOINT when that var is left empty, R2's own
  // documented production shape (see R2_ENDPOINT's own comment below).
  // Marking it zNonEmpty made a `.env` copied verbatim from .env.example
  // fail this schema's own validation — .env.example ships it empty by
  // design, for local dev against MinIO via R2_ENDPOINT instead — and
  // nothing caught that until this task. The `.superRefine` below is what
  // still catches the ACTUAL misconfiguration (neither var set) instead
  // of silently accepting it: exactly one of R2_ENDPOINT / R2_ACCOUNT_ID
  // must be non-empty, named explicitly so an operator sees which of the
  // two keys to fix. Format validation (32 lowercase hex chars) stays
  // downstream, in createR2Client itself — this schema only decides
  // presence, not shape.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: zNonEmpty,
  R2_SECRET_ACCESS_KEY: zNonEmpty,
  R2_BUCKET_EVENTS: zNonEmpty,
  R2_ENDPOINT: zOptionalUrl,

  // Services
  WORKER_PORT: zPort,
  NODE_ENV: z.enum(['development', 'test', 'production']),
  // The pino level set (review, batch 5) — zNonEmpty let "banana" pass.
  // Reconcile this list if a different logger is ever chosen; 'info'
  // (.env.example's default) is in both pino's and most alternatives'
  // sets, so that value keeps working either way.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),

  // Event pipeline batching (S3.3) — flush on whichever trips first.
  // EVENT_BATCH_SIZE is capped at 500 [review round 2, database-reviewer
  // finding]: it governs BOTH BatchAccumulator's count trigger AND how
  // many rows land in flushBatch's own single multi-row INSERT
  // (apps/worker/src/batch/flush.ts, T3.3.2) — each row binds 31
  // parameters (schema/events.ts's full column count), so Postgres's own
  // ~65,535-parameter-per-statement ceiling divided by 31 is ~2,114. 500
  // is comfortably clear of that ceiling (500 * 31 = 15,500 params, ~24%
  // of the limit) while still far above any batch size this system would
  // operationally want (.env.example's default is 100) — an operator
  // typo (e.g. "3000" meant as "300") now fails LOUD at boot, via this
  // schema, instead of surfacing as a cryptic "too many parameters"
  // Postgres error the next time a batch actually fills.
  EVENT_BATCH_SIZE: z.coerce.number().int().positive().max(500),
  EVENT_BATCH_INTERVAL_MS: z.coerce.number().int().positive(),

  // [T3.7.7] How many BullMQ jobs EventsConsumer processes concurrently
  // (events.consumer.ts's own `@Processor(EVENTS_QUEUE, { concurrency:
  // readWorkerConcurrency() })`). Moved into this schema from
  // events.consumer.ts, where it used to be read and validated ad hoc —
  // `workerConcurrencySchema` there stays as-is (same
  // `z.coerce.number().int().positive()` shape, mirrored here) because
  // the `@Processor` decorator argument is evaluated at MODULE LOAD time,
  // before this schema's own `loadEnv()` call in main.ts ever runs (see
  // that file's own comment on the ordering) — this field exists for
  // validated, DOWNSTREAM consumption (warnIfConcurrencyCannotFillBatchSize
  // below), not to replace that decorator-time read, which reads the
  // exact same underlying env var and so can never disagree with it.
  //
  // OPTIONAL, defaulting to DEFAULT_WORKER_CONCURRENCY — unlike every
  // other numeric knob above, an operator who never sets this is not
  // misconfigured; readWorkerConcurrency() has always silently defaulted
  // to 8, and this field must keep answering the same way rather than
  // turning "unset" into a boot failure.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(DEFAULT_WORKER_CONCURRENCY),

  // T3.1.6 [S3.1] — bounds ShutdownService's onModuleDestroy() (apps/
  // worker/src/consumer/shutdown.ts): on SIGTERM it pauses the BullMQ
  // worker (awaiting whatever job is already in flight) and calls
  // BatchAccumulator.flushNow() — both steps raced against this many
  // milliseconds, so a genuinely wedged Postgres/R2 write cannot block a
  // rollout forever. .env.example's default (30000) is not arbitrary: it
  // matches docs/plan/10-deploy-operate.md's T10.5.5, which pairs it with
  // `terminationGracePeriodSeconds: 60` on the worker's k8s Deployment —
  // 30s comfortably covers a real flush of up to EVENT_BATCH_SIZE's own
  // ceiling (500 rows, one INSERT + one SELECT) against Postgres, plus
  // headroom for R2 once T3.4.3 lands, while leaving the OTHER 30s of the
  // grace period for `process.exit(0)` itself and Kubernetes' own SIGKILL
  // margin — a `SHUTDOWN_TIMEOUT_MS` raised without raising the grace
  // period to match is exactly the drift T10.5.6's own infra test
  // (`tests/infra/grace-period.test.ts`) exists to catch.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive(),
});

/**
 * [T3.7.5] Cross-field rule createR2Client (packages/core/src/r2/client.ts,
 * T3.7.4) already enforces one level down, at construction time: at least
 * one of R2_ENDPOINT / R2_ACCOUNT_ID must be non-empty, or there is no way
 * to address R2/MinIO at all. Enforcing it here too — at boot, against the
 * raw env — means a misconfigured `.env` fails LOUD via loadEnv's own
 * named-key report (main.ts) instead of surfacing later as
 * createR2Client's thrown error the first time the accumulator's
 * BATCH_ACCUMULATOR provider is constructed (app.module.ts).
 *
 * Both `.superRefine` issues below share one message and are added on
 * BOTH keys' own paths (never a bare root-level issue) so that:
 *   - this schema's own tests can assert the message names both keys
 *     directly off `result.error.issues`;
 *   - `loadEnv` (packages/contracts/src/env.ts) — which derives its
 *     `EnvFailure.key` from `issue.path[0]`, one entry per distinct key —
 *     reports BOTH R2_ENDPOINT and R2_ACCOUNT_ID as failing keys, not just
 *     one, matching this task's own "message names BOTH keys" spec.
 */
function requireAtLeastOneR2AddressingVar(
  values: Pick<z.input<typeof workerEnvSchemaObject>, 'R2_ENDPOINT' | 'R2_ACCOUNT_ID'>,
  ctx: z.RefinementCtx,
): void {
  // [security review, MEDIUM] R2_ACCOUNT_ID (line 42) is a bare
  // `z.string().optional()` — unlike zNonEmpty (z.string().trim().min(1)),
  // which every OTHER required field in this schema uses, it does no
  // trimming. Trim here, not on the schema field itself: the field stays
  // a plain `string | undefined` (main.ts passes it straight through to
  // AppModuleConfig.r2AccountId, then to createR2Client, which trims
  // nothing of its own either — R2_ACCOUNT_ID_FORMAT's regex is anchored
  // and would simply reject a value with leading/trailing whitespace).
  // Without this, R2_ACCOUNT_ID: '   ' reads as "set" here, sails past
  // this schema's own boot-time check, and is only caught one layer down
  // by createR2Client's format check — defeating the reason this
  // .superRefine exists at all (this function's own doc comment above).
  const hasEndpoint = values.R2_ENDPOINT !== '';
  const hasAccountId = (values.R2_ACCOUNT_ID ?? '').trim() !== '';

  if (hasEndpoint || hasAccountId) return;

  const message =
    'R2_ENDPOINT and R2_ACCOUNT_ID are both empty — set one of them. R2_ENDPOINT for local ' +
    'dev (MinIO), or leave it empty and set R2_ACCOUNT_ID for production R2.';

  ctx.addIssue({ code: 'custom', path: ['R2_ENDPOINT'], message });
  ctx.addIssue({ code: 'custom', path: ['R2_ACCOUNT_ID'], message });
}

export const workerEnvSchema = workerEnvSchemaObject.superRefine(requireAtLeastOneR2AddressingVar);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * [T3.7.7] The bug: since T3.5.4, `AccumulatingEventSink.handle()` awaits
 * `BatchAccumulator.add()` until the event's own batch has actually
 * flushed, so a BullMQ job stays "held open" (its lock/attempt count not
 * released) for that whole time. That caps how many events can ever be
 * simultaneously represented in the accumulator at `WORKER_CONCURRENCY`
 * — so when `WORKER_CONCURRENCY < EVENT_BATCH_SIZE`, the accumulator's
 * COUNT trigger (fires once `batchSize` events have arrived) can
 * mathematically never fire: concurrency itself caps "in flight" below
 * the count threshold. Every batch ends up waiting out the full
 * `EVENT_BATCH_INTERVAL_MS` interval trigger instead, flushing at
 * roughly `WORKER_CONCURRENCY` events instead of the configured
 * `EVENT_BATCH_SIZE`.
 *
 * DELIBERATELY NEVER FATAL. This pairing is often a deliberate choice —
 * flush-on-interval-only, for a low-traffic deployment wanting bounded
 * latency and smaller batches — so this cannot be a `.superRefine` on
 * `workerEnvSchemaObject` the way `requireAtLeastOneR2AddressingVar` is:
 * a `.superRefine` failure is a PARSE failure, and `loadEnv` (main.ts)
 * treats every parse failure as fatal, exiting the process. Both
 * `apps/worker/src/consumer/sigterm-flush.test.ts` and
 * `apps/worker/src/test/e2e-kill-recovery.test.ts` deliberately run with
 * `WORKER_CONCURRENCY < EVENT_BATCH_SIZE` on purpose — it is their own
 * mechanism for keeping the count trigger from firing, so they can
 * assert the SIGTERM/interval-based flush path specifically. Failing
 * boot on this pairing would turn a performance note into an outage AND
 * break both of those tests' own deliberate setup.
 *
 * Takes the ALREADY-VALIDATED, parsed `WorkerEnv` (never raw
 * `process.env`) — call this from main.ts immediately after
 * `loadEnv(workerEnvSchema, process.env)` succeeds. Emits at most one
 * `console.warn`, naming both variable names and both actual values, and
 * does nothing at all when concurrency can fill the batch.
 */
export function warnIfConcurrencyCannotFillBatchSize(env: WorkerEnv): void {
  if (env.WORKER_CONCURRENCY >= env.EVENT_BATCH_SIZE) return;

  console.warn(
    `WORKER_CONCURRENCY (${env.WORKER_CONCURRENCY}) is less than EVENT_BATCH_SIZE ` +
      `(${env.EVENT_BATCH_SIZE}) — since T3.5.4, at most WORKER_CONCURRENCY events can be ` +
      'in flight at once, so the batch count trigger can never fire; every batch will flush ' +
      'on the EVENT_BATCH_INTERVAL_MS timer instead, at up to WORKER_CONCURRENCY events per ' +
      'flush.',
  );
}
