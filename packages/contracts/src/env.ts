import { z } from 'zod';

// Shared, isomorphic Zod primitives for validating environment-shaped
// string input (S0.3). These are schemas only — nothing here reads
// `process.env`. Each app's own env schema (T0.3.5–T0.3.7) applies these
// primitives to the keys it cares about, and `web` can reuse the exact
// same primitives for browser-side validation (e.g. NEXT_PUBLIC_*
// values) without pulling in anything server-only.
//
// This file also holds the pieces every app's fail-fast startup shares
// (T0.3.8): SECRET_ENV_KEYS (the one declared secret-name set),
// loadEnv (parses a schema against a raw record, collecting every
// failure), formatEnvFailures (a safe-to-print report), and
// redactSecrets (a safe-to-log copy of a parsed config). All four stay
// isomorphic on the same terms as the primitives above — no
// `process.env`, no `process.exit`, no logging; those side effects
// belong to each app's own main.ts.

/**
 * A TCP port: an integer between 1 and 65535, coerced from the string
 * env vars always arrive as.
 */
export const zPort = z.coerce
  .number()
  .int('Port must be an integer')
  .min(1, 'Port must be between 1 and 65535')
  .max(65535, 'Port must be between 1 and 65535');

/**
 * A fully-qualified URL string, e.g. `BETTER_AUTH_URL` or
 * `NEXT_PUBLIC_API_URL`.
 */
export const zUrl = z.url();

/** A string that must contain at least one non-whitespace character. */
export const zNonEmpty = z.string().trim().min(1, 'must not be empty');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * A boolean expressed as an env-friendly string — "true"/"false",
 * "1"/"0", "yes"/"no", "on"/"off", case-insensitive — parsed into a real
 * boolean.
 */
export const zBooleanish = z.string().transform((value, ctx) => {
  const normalized = value.trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  ctx.addIssue({
    code: 'custom',
    message: `Invalid boolean-ish value: "${value}"`,
  });
  return z.NEVER;
});

/**
 * A comma-separated list, e.g. `POSTA_RESERVED_HANDLES`. Splits on
 * commas, trims whitespace, and drops empty entries, so "a,b,c" and
 * "a, b, c," both parse to `["a", "b", "c"]`.
 */
export const zCsvList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/**
 * A URL that may also be the empty string — e.g. `R2_ENDPOINT`, which is
 * a URL in local dev (MinIO) but is explicitly left empty in production
 * to fall back to the R2 default (.env.example). Extracted here (batch 5
 * review) after apps/api and apps/worker's env schemas each carried an
 * identical inline copy for this exact field shape; a second consumer
 * appearing was the signal to promote it from "each app's own one-line
 * schema" to a shared primitive, per this file's own primitives above.
 */
export const zOptionalUrl = z
  .string()
  .refine((value) => value === '' || zUrl.safeParse(value).success, {
    message: 'must be empty or a valid URL',
  });

/**
 * The single declared set of secret-shaped env key names (S0.3 batch 5,
 * decision 3) — every key in .env.example whose value is a credential
 * (DB/Redis URLs are secret because they carry credentials, not because
 * of their own key name). This is the ONE source of truth two different
 * concerns read from, so they cannot drift into two lists that disagree:
 *   - web's schema (T0.3.7) asserts none of these ever appears under a
 *     NEXT_PUBLIC_ prefix, i.e. inlined into the browser bundle.
 *   - the fail-fast loader (T0.3.8) uses it to redact values before any
 *     parsed config is safe to log.
 * Declared here rather than per-app because both consumers above need
 * the exact same list, and contracts is the one package both an app
 * schema and the shared loader already import from.
 */
export const SECRET_ENV_KEYS: readonly string[] = Object.freeze([
  'DATABASE_URL',
  'DATABASE_URL_WORKER',
  'REDIS_URL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'BETTER_AUTH_SECRET',
  'SEED_USER_PASSWORD',
  'REVALIDATE_SECRET',
]);

/** One failing env key: its name and a generic (never value-derived) reason. */
export interface EnvFailure {
  readonly key: string;
  readonly reason: 'missing' | 'invalid';
}

export interface EnvLoadSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface EnvLoadFailure {
  readonly ok: false;
  readonly failures: readonly EnvFailure[];
}

export type EnvLoadResult<T> = EnvLoadSuccess<T> | EnvLoadFailure;

/**
 * The shared fail-fast env loader (S0.3, T0.3.8). Isomorphic like
 * everything else in this file: it takes the raw record as an argument
 * (an app's own main.ts passes `process.env`) and never reads
 * `process.env` itself, never calls `process.exit`, never logs — those
 * are the calling app's job, not this module's.
 *
 * On success, returns the fully parsed/coerced config. On failure,
 * returns EVERY failing key at once (Zod's `.safeParse` plus a walk over
 * `error.issues`, not a throw-on-first-error path), each reduced to just
 * its key name and a `'missing' | 'invalid'` reason — never the value
 * that failed, and never anything derived from Zod's own issue message
 * (a custom `.refine`/`.transform` message, e.g. zBooleanish's, can
 * legally echo its input; this function never surfaces that string, for
 * ANY key, not only ones in SECRET_ENV_KEYS — the failing key's raw
 * presence/absence in `rawEnv` is checked independently instead, which
 * is what makes "missing" vs "invalid" safe to compute without ever
 * touching the value itself in the returned failure).
 */
export function loadEnv<T>(
  schema: z.ZodType<T>,
  rawEnv: Readonly<Record<string, string | undefined>>,
): EnvLoadResult<T> {
  const parsed = schema.safeParse(rawEnv);

  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  const seenKeys = new Set<string>();
  const failures: EnvFailure[] = [];

  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
    if (seenKeys.has(key)) continue; // one entry per key, even if it fails multiple checks
    seenKeys.add(key);

    const rawValue = rawEnv[key];
    failures.push({
      key,
      reason: rawValue === undefined || rawValue === '' ? 'missing' : 'invalid',
    });
  }

  return { ok: false, failures };
}

/**
 * Renders a list of env failures into a human-readable report, safe to
 * print to stderr and exit(1) on. Confined to EnvFailure's `{key,
 * reason}` shape — there is no value anywhere in the input type for this
 * function to accidentally interpolate.
 */
export function formatEnvFailures(failures: readonly EnvFailure[]): string {
  const lines = failures.map((failure) => `  - ${failure.key}: ${failure.reason}`);

  return [
    'Invalid environment configuration. Fix these variables before starting:',
    ...lines,
  ].join('\n');
}

export const SECRET_REDACTION_PLACEHOLDER = '[REDACTED]' as const;

/**
 * Returns a shallow copy of a parsed config object with every
 * `secretKeys` entry replaced by a fixed placeholder — never mutates
 * `values`. Meant for the one legitimate reason to ever print a parsed
 * env object (a startup debug log of "here is the config I loaded"):
 * logging `values` directly would leak DATABASE_URL/REDIS_URL/R2
 * credentials/BETTER_AUTH_SECRET/etc. in plaintext; logging
 * `redactSecrets(values)` instead does not. Defaults to SECRET_ENV_KEYS
 * — the same declared set web's NEXT_PUBLIC_ leak test (T0.3.7) checks
 * against — so there is one list, not two.
 *
 * The return type is a mapped type over `T` (each field is either its
 * original type or the redaction placeholder), not a widened
 * `Record<string, unknown>` (code review, batch 5) — that preserves
 * type information for non-secret fields for any future caller, without
 * dishonestly claiming the result is still exactly `T` (a secret field
 * typed as something other than `string` would no longer match its
 * original type after redaction, so an `as T` cast would be unsound in
 * general, even though every current SECRET_ENV_KEYS field happens to be
 * a string).
 */
export function redactSecrets<T extends Record<string, unknown>>(
  values: T,
  secretKeys: readonly string[] = SECRET_ENV_KEYS,
): { [K in keyof T]: T[K] | typeof SECRET_REDACTION_PLACEHOLDER } {
  const secretKeySet = new Set(secretKeys);
  const redacted = {} as { [K in keyof T]: T[K] | typeof SECRET_REDACTION_PLACEHOLDER };

  for (const [key, value] of Object.entries(values) as [keyof T, T[keyof T]][]) {
    redacted[key] = secretKeySet.has(key as string) ? SECRET_REDACTION_PLACEHOLDER : value;
  }

  return redacted;
}
