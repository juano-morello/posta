import { S3Client } from '@aws-sdk/client-s3';

// T3.4.1 (E3, S3.4) — the R2/S3-compatible client seam every later S3.4
// task (the append-log writer, ...) builds on. This module owns
// CONSTRUCTION only: how to build a correctly-configured S3Client that
// addresses BOTH Cloudflare R2 (production) and MinIO (local dev,
// docker-compose, T0.4.4) through the exact SAME code path — no
// environment-specific branch anywhere in this file.
//
// forcePathStyle: true is what makes that possible. Virtual-hosted-style
// addressing (the AWS SDK's own default) puts the bucket name in the
// HOSTNAME (`https://bucket.host/key`), which needs either real DNS per
// bucket or a wildcard TLS cert — neither of which a local MinIO
// container has. Path-style (`https://host/bucket/key`) works against
// MinIO out of the box, and R2 documents path-style as its own REQUIRED
// addressing mode (it does not support virtual-hosted the way S3 does).
// One flag, same client code, both targets.
//
// region: 'auto' is a FIXED protocol constant, not environment config —
// unlike endpoint/credentials/bucket it does not vary between MinIO and
// R2: Cloudflare documents 'auto' as R2's own required region value, and
// MinIO has no region concept at all (it ignores the field). This is not
// the "no hardcoded config defaults" invariant being broken for
// endpoint/bucket/credentials below — those three genuinely vary per
// environment and MUST come from `config`; this one constant never
// varies, so there is nothing for an env var to meaningfully override.
//
// Construct ONCE, at boot — never per request or per batch [INV-2's own
// "build once, close over deps" discipline, applied here the same way
// apps/api/src/main.ts's single getRedis() call and
// packages/core/src/redis/client.ts's own header describe for the Redis
// seam]. Each consumer (apps/api, apps/worker) calls createR2Client()
// exactly once, at its own boot time, from its own already-validated env
// (apps/api/src/env.ts, apps/worker/src/env.ts both already parse
// R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_EVENTS,
// R2_ENDPOINT through Zod), then closes over the single returned client.

/**
 * Config {@link createR2Client} needs. All four fields are REQUIRED here
 * — deliberately no `process.env` fallback inside this module (CLAUDE.md:
 * "config from env only... everything comes from the factory's config
 * parameter, which callers (api/worker) build from their own validated
 * env"). apps/api and apps/worker each already validate every one of
 * these through their own env schema at their own boot time; this module
 * has no business re-reading `process.env` a second time, which would
 * only create a second place a value could drift from what the app's own
 * schema already validated.
 *
 * `bucket` is carried on this type even though {@link createR2Client}
 * never reads it — S3Client's own constructor has no "default bucket"
 * option; a bucket is supplied per-call, to each
 * PutObjectCommand/GetObjectCommand's own `Bucket` param. It lives here
 * anyway so a caller builds exactly ONE config object from its env and
 * threads it both into this factory and into every later R2 call, rather
 * than keeping two separately-sourced values (the client's config and
 * the bucket name) that could silently drift apart.
 */
export interface R2ClientConfig {
  /**
   * The R2/MinIO endpoint URL, e.g. `http://localhost:9000` in local dev.
   * May be the empty string — production's own documented value (see
   * R2_ENDPOINT's schema comment, packages/contracts/src/env.ts's
   * `zOptionalUrl`, and .env.example) — in which case this factory omits
   * `endpoint` from the S3Client config entirely and falls through to the
   * AWS SDK's own default endpoint resolution. See this function's own
   * docstring for why that fallback is a KNOWN, DELIBERATELY UNRESOLVED
   * gap for this task, not a solved production path.
   */
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

/**
 * Builds a single S3-compatible client addressing either MinIO (local
 * dev) or Cloudflare R2 (production) through the SAME code path — see
 * this file's own header for the `forcePathStyle`/`region` reasoning.
 * Call this exactly once, at boot; every consumer closes over the
 * returned client (never construct one per-request or per-batch).
 *
 * [security] Never logs, and never touches, anything about `config`
 * beyond handing `accessKeyId`/`secretAccessKey` straight to the AWS
 * SDK's own `credentials` option — there is no error handling or
 * logging IN this function to sanitize (construction is synchronous and
 * does not itself contact the network; auth failures surface later, from
 * whatever command a caller sends). Callers that add logging around a
 * `client.send(...)` failure must sanitize the caught error themselves —
 * `redactCredentialsFromMessage` (`@posta/contracts`) is this repo's
 * existing precedent for that exact class of problem
 * (apps/api/src/redirect/enqueue.ts's `createLogEnqueueFailure`), though
 * note it targets `scheme://user:pass@host` URL-embedded credentials
 * specifically — an S3-protocol auth error (`SignatureDoesNotMatch` /
 * `InvalidAccessKeyId`) has a different shape and does not embed the raw
 * secret at all (S3's SigV4 auth failures report the computed signature
 * and the canonical request that was signed, never the secret key
 * itself), which this module's own test suite (client.test.ts) verifies
 * directly against the real MinIO rather than assuming.
 *
 * [security review round 1, LOW] That "never embeds the secret" property
 * does NOT extend to `config.accessKeyId`: verified by hand against this
 * real MinIO, an UNRESTRICTED `util.inspect(error, { depth: null,
 * showHidden: true })` dump of a caught auth-failure error DOES contain
 * the access key id in cleartext, nested inside `error.$response`'s
 * embedded raw HTTP request (`authorization: AWS4-HMAC-SHA256
 * Credential=<accessKeyId>/...` — SigV4 always sends the key id over the
 * wire, only the secret never crosses). No caller of this module exists
 * yet (the writer that actually calls `.send()` is a later E3 task), so
 * this is not live-exploitable today, but whoever writes that caller:
 * NEVER log a caught S3 error wholesale — no bare `console.log(error)`,
 * no `util.inspect(error, { depth: null })` on anything this client
 * throws. Log an explicit ALLOWLISTED subset instead — `error.name`,
 * `error.message`, `error.$metadata?.httpStatusCode`,
 * `error.$metadata?.requestId` — the same "don't trust the whole object,
 * only known-safe fields" discipline resolve-redis.ts's own describeError
 * already applies to ioredis errors, extended here to whatever shape the
 * AWS SDK throws.
 *
 * KNOWN GAP, left deliberately unresolved by this task's own brief: when
 * `config.endpoint` is the empty string, this function omits `endpoint`
 * from the S3Client config, which falls through to the AWS SDK's own
 * default endpoint resolution for the configured region. That default
 * does NOT correctly address a real R2 account — R2's actual default
 * endpoint is `https://<account-id>.r2.cloudflarestorage.com`, which
 * needs an account id this task's four-env-var brief does not list
 * (`R2_ACCOUNT_ID`). Left unresolved here on purpose, per this task's own
 * instructions — do not "fix" this by silently reaching for
 * `R2_ACCOUNT_ID`; that is a decision for whichever later task actually
 * wires production R2 endpoint resolution.
 */
export function createR2Client(config: R2ClientConfig): S3Client {
  return new S3Client({
    // Conditional spread, not `endpoint: config.endpoint || undefined` —
    // this repo's `exactOptionalPropertyTypes` forbids an explicit
    // `undefined` for an optional key; the key must be OMITTED entirely
    // (same pattern createEnqueueDroppedCounter, apps/api/src/redirect/
    // enqueue.ts, already uses for its own optional `registers` field).
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    region: 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}
