import { z } from 'zod';
import { zClasificacion } from '@posta/contracts';

// T4.4.1 [E4, S4.4] — the classification corpus fixture FORMAT: one golden
// test case in what the build plan calls "the most valuable artifact in the
// repo". Its whole value proposition is that "improving a classification
// rule" (editing the CASE expressions in
// packages/core/migrations/sql/006_events_classified.sql, T4.1.1) becomes
// falsifiable against a fixed set of real requests with independently-known
// answers, rather than a vibes-based judgment call. This file defines the
// SHAPE only — the loader (load.ts) and the actual golden-test runner over a
// populated corpus/*.json are separate, later tasks (T4.4.2+).
//
// `signals` enumerates every §5.1 capture column a real request carries —
// deliberately the SAME set CaptureEventSchema (@posta/contracts,
// packages/contracts/src/capture.ts) captures at the redirect hot path,
// minus that schema's identity/context frame (event_id, occurred_at,
// tenant_id, link_id, slug, visitor_hash) and its enrichment-adjacent
// fields, since a corpus fixture asserts a classification verdict over raw
// request signals, not the queue envelope around them. Every signal is
// `string | null`, matching `events`' own nullable text columns
// (packages/core/migrations/sql/001_events.sql) and CaptureEventSchema's
// convention that an absent header is itself evidence, serialized as an
// explicit `null` rather than an omitted key.
//
// `http_method` is the one deliberate exception to "nullable": a real HTTP
// request always carries a method (GET, HEAD, ...) — there is no such thing
// as a request with no method the way there can be a request with no
// `Accept-Language` header — so it is typed as a bare, required `string`.
//
// `expect.classification` reuses zClasificacion (@posta/contracts, T6.4.1)
// rather than re-declaring the four-value enum here: one vocabulary shared
// with the SQL view's CASE branches and the UI's honesty primitives, so a
// fixture can never assert a verdict the view itself could never emit — a
// typo like `"human"` (missing accent, wrong language) or `"maybe"` fails
// Zod validation instead of silently becoming a new, undocumented verdict.
//
// `provenance` is REQUIRED, not optional: a fixture with no stated origin —
// a real captured event id + date, or "hand-authored, spec §7.1 rule N" —
// is a guess wearing a golden test's clothes. The corpus's credibility rests
// on every entry being traceable back to something real or an explicitly
// named rule, so an empty/missing provenance is rejected at the schema
// level, not left as a convention someone can forget.
const zSignal = z.string().nullable();

export const FixtureSignalsSchema = z
  .object({
    http_method: z.string(),
    user_agent: zSignal,
    referer: zSignal,
    accept: zSignal,
    accept_language: zSignal,
    sec_fetch_site: zSignal,
    sec_fetch_mode: zSignal,
    sec_fetch_dest: zSignal,
    sec_fetch_user: zSignal,
    sec_purpose: zSignal,
    sec_ch_ua: zSignal,
    sec_ch_ua_mobile: zSignal,
    sec_ch_ua_platform: zSignal,
    purpose: zSignal,
    x_purpose: zSignal,
    x_moz: zSignal,
    country: zSignal,
    asn: z.number().nullable(),
  })
  .strict();

export const FixtureExpectSchema = z
  .object({
    classification: zClasificacion,
    why: z.string().min(1, 'expect.why must not be empty'),
  })
  .strict();

export const FixtureSchema = z
  .object({
    id: z.string().min(1, 'id must not be empty'),
    signals: FixtureSignalsSchema,
    expect: FixtureExpectSchema,
    // A real event id + date ("event_id 01J... captured 2026-06-03") or a
    // named rule ("hand-authored, spec §7.1 rule 4") — never blank.
    provenance: z.string().min(1, 'provenance is required — a fixture with no stated origin is a guess, not a golden test'),
    note: z.string().optional(),
  })
  .strict();

export type FixtureSignals = z.infer<typeof FixtureSignalsSchema>;
export type FixtureExpect = z.infer<typeof FixtureExpectSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;
