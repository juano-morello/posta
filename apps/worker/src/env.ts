import { z } from 'zod';
import { zNonEmpty, zPort, zUrl } from '@posta/contracts';

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

/**
 * `R2_ENDPOINT` is a URL in local dev (MinIO) but is explicitly left
 * empty in production to fall back to the R2 default (.env.example) —
 * mirrors apps/api/src/env.ts's zOptionalUrl; kept as each app's own
 * one-line schema rather than a new shared contracts primitive for a
 * single field shape used by exactly two schemas so far.
 */
const zOptionalUrl = z.string().refine((value) => value === '' || zUrl.safeParse(value).success, {
  message: 'must be empty or a valid URL',
});

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
  LOG_LEVEL: zNonEmpty,

  // Event pipeline batching (S3.3) — flush on whichever trips first.
  EVENT_BATCH_SIZE: z.coerce.number().int().positive(),
  EVENT_BATCH_INTERVAL_MS: z.coerce.number().int().positive(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
