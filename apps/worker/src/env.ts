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

export const workerEnvSchema = z.object({
  // Datastores — writer role (see file header). No domain/auth vars: the
  // worker builds no URLs and serves no auth-gated routes.
  DATABASE_URL_WORKER: zUrl,
  REDIS_URL: zUrl,

  // Cloudflare R2 — only what writing events needs: credentials, the
  // events bucket, and the endpoint override. NOT R2_BUCKET_AVATARS —
  // avatar upload is a dashboard/API concern, not the worker's.
  R2_ACCOUNT_ID: zNonEmpty,
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
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
