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

export const createBioPageSchema = z.object({
  handle: zHandle,
  displayName: z.string().optional(),
  bio: z.string().optional(),
  avatarUrl: z.url().optional(),
  themeId: z.string().optional(),
});

export const updateBioPageSchema = createBioPageSchema.partial();

export type CreateBioPageInput = z.infer<typeof createBioPageSchema>;
export type UpdateBioPageInput = z.infer<typeof updateBioPageSchema>;

// `bio_links` carries `linkId`, never a URL — mirrors T1.1.7's schema:
// the FK to `links.id` is what makes "every bio link is already tracked"
// true by construction, not by discipline.
export const createBioLinkSchema = z.object({
  linkId: z.string().min(1, 'linkId is required'),
  position: z.int().nonnegative(),
});

export const updateBioLinkSchema = createBioLinkSchema.partial();

export type CreateBioLinkInput = z.infer<typeof createBioLinkSchema>;
export type UpdateBioLinkInput = z.infer<typeof updateBioLinkSchema>;
