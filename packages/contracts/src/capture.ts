import { z } from 'zod';

// T2.3.1 [INV-6][INV-8] — CaptureEventSchema is both the BullMQ queue
// payload the redirect hot path enqueues and the row shape the worker
// writes into `events` (packages/core/src/schema/events.ts), MINUS that
// table's enrichment columns (`browser`, `browser_version`, `os`,
// `device_type`, `source_platform`, `is_in_app`, `dest_host`). Those are
// written later, by the worker — which enriches but never judges
// (invariant 4) — so they have no place in what capture produces.
//
// Field names are snake_case, matching the wire format and the `events`
// column names — the same precedent packages/contracts/src/cache.ts
// (T2.2.1) set, deliberately unlike the camelCase Drizzle objects
// packages/core uses internally.
//
// Every signal is `string | null`, NEVER optional. A missing header is
// itself evidence ("we did not see this header") that the classification
// view (E4) reasons over, so its absence must serialise as an explicit
// `null` — an omitted key would be indistinguishable from one lost in
// transit between capture and the worker.
//
// `.strict()` is invariant 6's enforcement mechanism: it is what turns
// adding an `ip` field (or `x-forwarded-for`, a cookie, ...) into a
// FAILING TEST instead of a silent widening. See capture.test.ts's
// key-set and ip-pattern assertions, which are derived from this
// schema's actual keys at runtime rather than a hand-written list that
// could drift out of sync with it.

// Crockford base32 — 0-9 and A-Z minus the visually ambiguous I, L, O, U
// — 26 chars. The identical pattern packages/core/src/ulid.ts encodes,
// duplicated rather than imported: packages/contracts is isomorphic with
// ZERO server dependencies, and packages/core is server-only, so this
// package cannot import ulid.ts. This only needs the external format's
// shape (a public spec, not an internal convention), so a second literal
// of the same regex is the correct boundary here rather than drift
// waiting to happen.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A §5.1 signal: present when observed, an explicit `null` when not. */
const zNullableSignal = z.string().nullable();

export const CaptureEventSchema = z
  .object({
    // Identity/context — the queue payload's required frame, not part of
    // spec §5.1's signal list itself.
    event_id: z.string().regex(ULID_PATTERN, 'event_id must be a 26-char Crockford ULID'),
    // ISO 8601, e.g. `new Date().toISOString()` — a `Date` value would not
    // survive a BullMQ round-trip through Redis intact.
    occurred_at: z.iso.datetime(),
    tenant_id: z.string().min(1),
    link_id: z.string().min(1),
    slug: z.string().min(1),

    // Request (spec §5.1)
    http_method: zNullableSignal,
    user_agent: zNullableSignal,
    referer: zNullableSignal,
    accept: zNullableSignal,
    accept_language: zNullableSignal,

    // Fetch metadata (spec §5.1)
    sec_fetch_site: zNullableSignal,
    sec_fetch_mode: zNullableSignal,
    sec_fetch_dest: zNullableSignal,
    sec_fetch_user: zNullableSignal,
    sec_purpose: zNullableSignal,

    // Client hints (spec §5.1)
    sec_ch_ua: zNullableSignal,
    sec_ch_ua_mobile: zNullableSignal,
    sec_ch_ua_platform: zNullableSignal,

    // Prefetch tells (spec §5.1)
    purpose: zNullableSignal,
    x_purpose: zNullableSignal,
    x_moz: zNullableSignal,

    // Network (spec §5.1)
    country: zNullableSignal,
    asn: z.number().nullable(),

    // Identity (spec §5.1)
    visitor_hash: zNullableSignal,
  })
  .strict();

export type CaptureEvent = z.infer<typeof CaptureEventSchema>;
