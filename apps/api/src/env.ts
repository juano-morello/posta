import { z } from 'zod';
import { zCsvList, zNonEmpty, zPort, zUrl } from '@posta/contracts';

// T0.3.5 — the API's Zod env schema (S0.3). The API owns redirects, all
// CRUD, auth, and analytics queries, and does the ASN/geo lookup at
// capture time before the IP is dropped (invariant 6) — so it is the one
// app that needs the full domain, datastore, R2, GeoIP, and auth groups.
// It deliberately does NOT get the worker's batch-flush vars
// (EVENT_BATCH_SIZE, EVENT_BATCH_INTERVAL_MS, DATABASE_URL_WORKER — the
// worker connects as the writer role, the API as a reader, T0.3.6) or
// WEB_PORT. See CLAUDE.md's per-app variable table for the reasoning.
//
// Only the primitives contracts already exports (T0.3.2) are reused here
// — this file selects and wires them for the API's own variables, it does
// not add new shared primitives (that stays contracts' job).

/**
 * `R2_ENDPOINT` is a URL in local dev (MinIO) but is explicitly left
 * empty in production to fall back to the R2 default (.env.example) — so
 * this must accept "" as well as a well-formed URL, unlike the other
 * required URLs in this schema.
 */
const zOptionalUrl = z.string().refine((value) => value === '' || zUrl.safeParse(value).success, {
  message: 'must be empty or a valid URL',
});

export const apiEnvSchema = z.object({
  // Domains (S0.3, T0.3.3) — everything makeUrlBuilders() needs, plus the
  // reserved-handle override list (T0.3.4).
  POSTA_LINK_DOMAIN: zNonEmpty,
  POSTA_APP_SUBDOMAIN: zNonEmpty,
  POSTA_API_SUBDOMAIN: zNonEmpty,
  POSTA_PROTOCOL: z.enum(['http', 'https']),
  POSTA_RESERVED_HANDLES: zCsvList,

  // Datastores — the API is the reader role (T0.3.6 gives the worker its
  // own DATABASE_URL_WORKER writer connection).
  DATABASE_URL: zUrl,
  REDIS_URL: zUrl,

  // Cloudflare R2 — the API owns both buckets: events (it enqueues, the
  // worker writes) and avatars (dashboard upload).
  R2_ACCOUNT_ID: zNonEmpty,
  R2_ACCESS_KEY_ID: zNonEmpty,
  R2_SECRET_ACCESS_KEY: zNonEmpty,
  R2_BUCKET_EVENTS: zNonEmpty,
  R2_BUCKET_AVATARS: zNonEmpty,
  R2_ENDPOINT: zOptionalUrl,

  // GeoIP — a filesystem path to the baked-in DB-IP .mmdb files (S0.7),
  // not a credential: no licence key to validate (CC BY 4.0, redistributable).
  GEOIP_DB_DIR: zNonEmpty,

  // Auth (Better Auth, S5.1) and the single seeded v1 account (invariant 9).
  BETTER_AUTH_SECRET: zNonEmpty,
  BETTER_AUTH_URL: zUrl,
  SEED_USER_EMAIL: zNonEmpty,
  SEED_USER_PASSWORD: zNonEmpty,
  SEED_USER_HANDLE: zNonEmpty,

  // Services
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: zNonEmpty,
  API_PORT: zPort,

  // Redis TTL for resolved slug→destination lookups (S3.3-adjacent).
  LINK_CACHE_TTL_SECONDS: z.coerce.number().int().positive(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
