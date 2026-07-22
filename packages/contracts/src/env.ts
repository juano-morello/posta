import { z } from 'zod';

// Shared, isomorphic Zod primitives for validating environment-shaped
// string input (S0.3). These are schemas only — nothing here reads
// `process.env`. Each app's own env schema (T0.3.5–T0.3.7, next batch)
// applies these primitives to the keys it cares about, and `web` can
// reuse the exact same primitives for browser-side validation (e.g.
// NEXT_PUBLIC_* values) without pulling in anything server-only.

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
