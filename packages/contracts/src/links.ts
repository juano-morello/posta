import { z } from 'zod';
import { RESERVED_PATHS } from './reserved';

// T1.1.11 [security] — the schema boundary S1.1's acceptance criterion
// refers to. `destination` must be an absolute http(s) URL: javascript:,
// data:, file:, protocol-relative //host, and bare relative paths are
// all rejected here, before anything reaches the database (T1.1.5's
// CHECK constraint is defense in depth behind this, never the primary
// gate). `z.url()` alone is not enough — it is deliberately permissive
// (it accepts `mailto:`, `javascript:`, `data:`, anything the WHATWG URL
// parser calls valid) — the `protocol` regex is what actually restricts
// this to http(s).

const DESTINATION_PROTOCOL_PATTERN = /^https?$/;

// [security review, batch 1] Deliberately generous but finite: z.url()
// alone imposes no length ceiling (verified — a 5,000+ character
// hostname parses and validates successfully), and the destination
// column is an unbounded Postgres `text`. Without a bound here, a tenant
// could insert an arbitrarily large string repeatedly — this is the one
// place S1.1 already commits to being the primary validation gate ahead
// of the DB.
const DESTINATION_MAX_LENGTH = 2048;
const TITLE_MAX_LENGTH = 200;

const zDestination = z.url({ protocol: DESTINATION_PROTOCOL_PATTERN }).max(DESTINATION_MAX_LENGTH);

// Lowercase alnum + dash only ([a-z0-9-], no underscore — must match S5.3
// exactly), 1-64 chars, no leading or trailing hyphen. The optional
// middle group allows 0-62 hyphen-containing chars between two
// alphanumeric endpoints, so a 1-char slug (just the first alternative)
// and a 64-char slug (1 + 62 + 1) are both valid, 65 is not.
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** The slug length ceiling SLUG_PATTERN's own shape already encodes. */
export const SLUG_MAX_LENGTH = 64;

/**
 * T2.1.2 — the same slug rule zSlug enforces at creation time, exposed
 * as a plain predicate for the redirect hot path.
 *
 * The hot path needs to reject a structurally impossible slug (a 4 KB
 * path, an encoded traversal, an uppercase form) BEFORE spending a Redis
 * GET and a Postgres query discovering it could never have existed. Doing
 * that with a second copy of the pattern is exactly the drift this
 * module's other comments warn about — it would show up as a link E5
 * happily creates and the redirect path then refuses to serve. Sharing
 * SLUG_PATTERN and SLUG_MAX_LENGTH between the two is what makes
 * "creatable" and "reachable" the same predicate; slug-shape.test.ts
 * asserts the two agree over a table rather than trusting that by eye.
 */
export function isValidSlug(slug: string): boolean {
  if (slug.length < 1 || slug.length > SLUG_MAX_LENGTH) return false;
  if (!SLUG_PATTERN.test(slug)) return false;
  return !RESERVED_PATHS.includes(`/${slug}`);
}

// Reserved paths are checked by IMPORTING RESERVED_PATHS (T0.3.4), never
// by inlining a second copy of the forbidden list — a second copy is
// exactly the drift that lets a user claim a slug which then 404s
// against real infrastructure. RESERVED_PATHS is deliberately minimal
// today (just '/' — see reserved.ts), and a slug can never actually equal
// '' (the length check above already requires at least 1 char), so this
// check has no CURRENT test case that distinguishes it from a no-op —
// what it buys is that the exact same code path picks up a future
// RESERVED_PATHS addition with zero changes here.
const zSlug = z
  .string()
  .min(1, 'slug must be 1-64 characters')
  .max(64, 'slug must be 1-64 characters')
  .regex(
    SLUG_PATTERN,
    'slug must be lowercase letters, digits, and dashes only, with no leading or trailing dash',
  )
  .refine((slug) => !RESERVED_PATHS.includes(`/${slug}`), {
    message: 'slug collides with a reserved path',
  });

export const createLinkSchema = z.object({
  slug: zSlug,
  destination: zDestination,
  title: z.string().max(TITLE_MAX_LENGTH).optional(),
});

export const updateLinkSchema = createLinkSchema.partial();

export type CreateLinkInput = z.infer<typeof createLinkSchema>;
export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;
