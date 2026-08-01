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
 * Config {@link createR2Client} needs. Four fields are REQUIRED;
 * `accountId` is OPTIONAL (see its own doc comment below for why) —
 * deliberately no `process.env` fallback inside this module (CLAUDE.md:
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
   * `zOptionalUrl`, and .env.example) — in which case this factory
   * derives the endpoint from `accountId` instead. See this function's
   * own docstring for the full derivation/error rules.
   */
  readonly endpoint: string;
  /**
   * The Cloudflare account id `R2_ACCOUNT_ID` carries — only READ by this
   * factory when `endpoint` is empty, to derive R2's own account-scoped
   * endpoint (`https://<accountId>.r2.cloudflarestorage.com`). OPTIONAL,
   * unlike `endpoint` above — the key may be OMITTED entirely, not just
   * set to `''` — because `R2ClientConfig` object literals already exist
   * at call sites across apps/worker (production code and tests alike)
   * that predate this field and do not know about it yet; wiring
   * `R2_ACCOUNT_ID` down through each of those call sites is T3.7.5's own
   * job, not this one's, and a required field here would break every one
   * of them at compile time before T3.7.5 ever lands. A missing key is
   * treated identically to an empty string by `createR2Client` — see its
   * own docstring — so omitting it and passing `''` mean the same thing.
   *
   * [security review round 2, MEDIUM] TRUSTED, operator-only config —
   * same trust tier as `endpoint` above, not a new privilege boundary —
   * but `resolveEndpoint` raw-interpolates a non-empty value into a URL
   * (`https://<accountId>.r2.cloudflarestorage.com`), so unlike
   * `endpoint` (already usable verbatim with zero validation, by design)
   * this value's SHAPE is validated first: Cloudflare's own documented
   * format is exactly 32 lowercase hex characters, and a value shaped
   * like a path (containing `/`) would otherwise terminate the URL's
   * authority early and silently redirect the connection — credentials
   * included — to whatever host precedes the `/`. `R2_ACCOUNT_ID` is also
   * in `SECRET_ENV_KEYS` (packages/contracts/src/env.ts) even though it
   * is not itself a credential, purely so a malformed value never gets
   * echoed back into a thrown error message either — see
   * `resolveEndpoint`'s own doc comment.
   */
  readonly accountId?: string;
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
 * ENDPOINT RESOLUTION (T3.7.4, closes this file's former "KNOWN GAP"):
 * when `config.endpoint` is non-empty, it is used VERBATIM — the local
 * MinIO path is completely unaffected by `accountId`. When `endpoint` is
 * empty and `accountId` is set to a WELL-FORMED account id (32 lowercase
 * hex characters — Cloudflare's own documented format), this factory
 * derives R2's own documented account-scoped endpoint,
 * `https://<accountId>.r2.cloudflarestorage.com`, and uses that. When
 * BOTH are empty, `accountId` is omitted entirely, OR `accountId` is
 * non-empty but MALFORMED (round 2 security review — see
 * `resolveEndpoint`'s own doc comment for why shape matters here), this
 * factory throws rather than construct a client that would fall through
 * to the AWS SDK's own default endpoint resolution, or address the wrong
 * host outright, and fail later — on the first `.send()`, or silently —
 * far from this misconfiguration's actual cause.
 *
 * [security] The thrown message names only the relevant env var keys
 * (`R2_ENDPOINT`, `R2_ACCOUNT_ID`) an operator needs to fix — never
 * `config` itself, and never `accessKeyId`/`secretAccessKey`/the raw
 * malformed `accountId` value, which this module's own test suite
 * (client.test.ts) verifies directly via absence assertions, not an
 * assumption.
 */
export function createR2Client(config: R2ClientConfig): S3Client {
  const endpoint = resolveEndpoint(config);

  return new S3Client({
    endpoint,
    region: 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Cloudflare's own documented R2 account-id format: exactly 32 lowercase
 * hex characters. `resolveEndpoint` enforces this BEFORE interpolating
 * `accountId` into a URL (round 2 security review, MEDIUM) — a value
 * containing `/` (e.g. `evil.example.com/x`) would otherwise terminate
 * the URL's authority early, so `https://${accountId}.r2.
 * cloudflarestorage.com` would silently address `evil.example.com`, not
 * R2, while still carrying real SigV4 credentials. `S3Client` resolves
 * `endpoint` LAZILY, not at construction, so an unvalidated malformed
 * value would not even fail at boot — only on the first real write,
 * against the wrong host. Validating the shape here, at construction, is
 * what keeps this task's own design goal ("throw loud and immediate
 * instead of failing later with a confusing error") true for this branch
 * too.
 */
const R2_ACCOUNT_ID_FORMAT = /^[0-9a-f]{32}$/;

/**
 * Resolves the endpoint URL {@link createR2Client} passes to `S3Client`,
 * per the rule documented on `createR2Client` itself: verbatim `endpoint`
 * first, else derive from a WELL-FORMED `accountId`, else throw. Pulled
 * out as its own function (rather than inlined into the conditional
 * spread the previous version used) because the "nothing usable" branches
 * now need to THROW, not merely omit a key — a conditional spread has no
 * natural place to do that.
 *
 * `config.accountId` being OMITTED (an existing caller that predates this
 * field), being the EMPTY STRING (a caller that knows about the field and
 * has nothing to put in it), and being a non-empty but MALFORMED value
 * (round 2 security review) all end up in an error — an absent key, an
 * empty value, and a value that fails `R2_ACCOUNT_ID_FORMAT` are handled
 * as three DISTINCT cases below, not collapsed into one, because only the
 * first two mean "R2_ACCOUNT_ID wasn't set" — the third means "it was set
 * to something that is not actually an account id," which deserves its
 * own message naming the format problem, not a generic "both empty" one.
 *
 * Parameter typed via `Pick<R2ClientConfig, 'endpoint' | 'accountId'>` to
 * DOCUMENT what this function reads — it is not a runtime isolation
 * guarantee (round 2 security review, LOW): `createR2Client` calls this
 * with the FULL `config` object, which still carries
 * `accessKeyId`/`secretAccessKey` by reference underneath that narrower
 * static type. Nothing in this function's own body ever touches those
 * two fields, which is the actual guarantee — the `Pick` only narrows
 * what the type checker will let this function's CODE reference.
 */
function resolveEndpoint(config: Pick<R2ClientConfig, 'endpoint' | 'accountId'>): string {
  if (config.endpoint) return config.endpoint;

  if (config.accountId) {
    if (R2_ACCOUNT_ID_FORMAT.test(config.accountId)) {
      return `https://${config.accountId}.r2.cloudflarestorage.com`;
    }

    // [security] Names ONLY the env var key — never the malformed value
    // itself (R2_ACCOUNT_ID is SECRET_ENV_KEYS-classified, see
    // `R2ClientConfig.accountId`'s own doc comment) and never `config`,
    // which carries accessKeyId/secretAccessKey.
    throw new Error(
      'createR2Client: R2_ACCOUNT_ID is not a valid Cloudflare account id (expected 32 ' +
        'lowercase hex characters) — fix R2_ACCOUNT_ID, or set R2_ENDPOINT explicitly instead.',
    );
  }

  // [security] Names ONLY the two env var keys — never `config`, which
  // carries accessKeyId/secretAccessKey.
  throw new Error(
    'createR2Client: both R2_ENDPOINT and R2_ACCOUNT_ID are empty — set one of them. ' +
      'R2_ENDPOINT for local dev (MinIO), or leave it empty and set R2_ACCOUNT_ID for production R2.',
  );
}
