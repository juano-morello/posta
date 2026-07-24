import { z } from 'zod';
import { zDestination } from './links';

// T2.2.1 [security] — S2.2's cache boundary. The value at
// `link:{tenant}:{slug}` (T2.1.3's linkKey, spec §9) is JSON written by
// this codebase today, but a Redis value is untrusted input the moment
// anything else can write to that instance — an unparsed `destination`
// read off the cache and handed straight to `res.redirect()` is an open
// redirect with a TTL. Every cache read must be PARSED, never cast.
//
// Field names are snake_case (`link_id`, `tenant_id`, `destination`),
// matching the BullMQ queue payload and the `events` table's column
// names — this is a wire format, not a Drizzle row, so it deliberately
// does not follow the camelCase the schema objects in packages/core use.
//
// `link_id` / `tenant_id` are validated as non-empty strings, not
// ULID-shape-checked: unlike `destination`, neither is ever handed to
// `res.redirect()` or otherwise interpreted — they are carried straight
// through to the enqueued event. The injection surface this schema
// exists to close is `destination`; a malformed id here still leaves the
// hot path safe, it just means whoever wrote this key wrote garbage.
//
// `.strict()`: an unexpected extra key in a cached payload means
// something else wrote to this Redis instance — exactly the situation
// this schema exists to catch, not silently ignore.
//
// `destination` reuses links.ts's zDestination object DIRECTLY (T1.1.11)
// rather than a second, hand-copied absolute-http(s) rule — two copies
// of this rule is precisely the drift that would let the write path
// reject `javascript:` while this, the cache-read path, accepted it.
export const CachedLinkSchema = z
  .object({
    link_id: z.string().min(1),
    tenant_id: z.string().min(1),
    destination: zDestination,
  })
  .strict();

export type CachedLink = z.infer<typeof CachedLinkSchema>;

/**
 * Parses a raw `GET link:{tenant}:{slug}` result into a typed
 * {@link CachedLink}, or `null` for every way that read can fail to be
 * trustworthy: a missing key (`GET` returns `null`), a value that is not
 * valid JSON, or JSON that does not conform to {@link CachedLinkSchema}
 * (a missing field, an extra field, or — the case this schema exists
 * for — a `destination` that is not an absolute http(s) URL).
 *
 * Never throws. A bare `Schema.parse()` throws on a failed parse, and
 * `JSON.parse()` throws on malformed input; this function owns both
 * steps and folds every failure mode into the same typed-absent `null`,
 * so every cache read in T2.2.3 can call it once and treat a corrupt
 * cache entry exactly like a cache miss.
 *
 * This module is packages/contracts — isomorphic, zero server
 * dependencies — so it does not log. A parse failure here is silent by
 * design: T2.2.3's caller owns the logger and is responsible for
 * emitting the `warn` the story calls for.
 */
export function parseCachedLink(raw: string | null): CachedLink | null {
  if (raw === null) return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = CachedLinkSchema.safeParse(candidate);
  return result.success ? result.data : null;
}
