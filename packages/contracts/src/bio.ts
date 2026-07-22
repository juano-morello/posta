import { z } from 'zod';
import { RESERVED_HANDLES } from './reserved';

// T1.1.12 [security] — `handle` rejects the reserved list from spec §3.1
// (app api www admin static assets cdn mail blog docs status): a
// claimable `api` handle would shadow the API host. Sourced by IMPORTING
// RESERVED_HANDLES (T0.3.4), never a second inlined copy — the same
// reasoning as T1.1.11's RESERVED_PATHS import.

// Lowercase alnum + dash, no leading or trailing dash — same charset
// shape as T1.1.11's slug, different length bound (3-30, not 1-64: a
// handle is a DNS subdomain label, not a link's path segment).
const HANDLE_CHARSET_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const zHandle = z
  .string()
  .min(3, 'handle must be 3-30 characters')
  .max(30, 'handle must be 3-30 characters')
  .regex(
    HANDLE_CHARSET_PATTERN,
    'handle must be lowercase letters, digits, and dashes only, with no leading or trailing dash',
  )
  .refine((handle) => !RESERVED_HANDLES.includes(handle), {
    message: 'handle is reserved',
  });
// [security review, batch 1] RESERVED_HANDLES is the frozen default list
// (T0.3.4) — it does NOT include an operator's POSTA_RESERVED_HANDLES
// override (resolveReservedHandles() merges that in, but only an app
// with access to env can call it; contracts is isomorphic and never
// reads process.env, see reserved.ts). This schema therefore enforces
// the fixed 11-word list only. Known, forward-compatible limitation, not
// a bug in this task's own scope (S1.1's acceptance criterion is exactly
// "rejects spec §3.1's list") — S5.3 (handle creation) is where an
// operator override, if ever used, needs its own enforcement path, e.g.
// by having the API layer re-check resolveReservedHandles() server-side
// rather than relying on this schema alone for that extended list.

// Bounds below are deliberately generous (well above anything a real
// display name/bio/avatar URL needs) but finite: an unbounded `text`
// column plus an unbounded Zod string is an unbounded-storage footgun —
// nothing stops a tenant from inserting an arbitrarily large string
// repeatedly. This is the one place S1.1 already commits to being the
// primary validation gate ahead of the DB (T1.1.11's destination CHECK
// constraint is defense in depth, not the primary gate, and the same
// reasoning applies here).
const DISPLAY_NAME_MAX_LENGTH = 100;
const BIO_MAX_LENGTH = 500;
const AVATAR_URL_MAX_LENGTH = 2048;
const THEME_ID_MAX_LENGTH = 50;

export const createBioPageSchema = z.object({
  handle: zHandle,
  displayName: z.string().max(DISPLAY_NAME_MAX_LENGTH).optional(),
  bio: z.string().max(BIO_MAX_LENGTH).optional(),
  avatarUrl: z.url().max(AVATAR_URL_MAX_LENGTH).optional(),
  themeId: z.string().max(THEME_ID_MAX_LENGTH).optional(),
});

export const updateBioPageSchema = createBioPageSchema.partial();

export type CreateBioPageInput = z.infer<typeof createBioPageSchema>;
export type UpdateBioPageInput = z.infer<typeof updateBioPageSchema>;

// A ULID shape-check duplicated from packages/core/src/ulid.ts's
// ULID_PATTERN — contracts cannot import core (the dependency-cruiser
// no-illegal-core-import rule; core is server-only). This is the public
// Crockford-base32 format spec, not business logic, so duplicating just
// the pattern (not the monotonic generator) doesn't create the "second
// copy of a list that can drift" problem RESERVED_PATHS/RESERVED_HANDLES
// guard against elsewhere in this file/T1.1.11 — there is nothing here
// to drift from, the format is fixed.
const ULID_SHAPE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// `bio_links` carries `linkId`, never a URL — mirrors T1.1.7's schema:
// the FK to `links.id` is what makes "every bio link is already tracked"
// true by construction, not by discipline. Validating linkId's shape
// here (rather than only at the DB's FK constraint) surfaces a malformed
// id as a 400 at the schema boundary instead of a 500 from a failed
// insert.
export const createBioLinkSchema = z.object({
  linkId: z.string().regex(ULID_SHAPE_PATTERN, 'linkId must be a valid ULID'),
  position: z.int().nonnegative(),
});

export const updateBioLinkSchema = createBioLinkSchema.partial();

export type CreateBioLinkInput = z.infer<typeof createBioLinkSchema>;
export type UpdateBioLinkInput = z.infer<typeof updateBioLinkSchema>;
