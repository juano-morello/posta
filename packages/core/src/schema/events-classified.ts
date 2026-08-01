import { boolean, integer, pgView, text, timestamp } from 'drizzle-orm/pg-core';

// T4.1.3 — READ-ONLY Drizzle typing for `events_classified` (the hand-written
// SQL view from T4.1.1, packages/core/migrations/sql/006_events_classified.sql),
// mirroring events.ts's (T1.2.4) `.existing()` pattern exactly: drizzle-kit
// cannot emit `CREATE VIEW` for a view whose columns are enumerated by hand
// over a partitioned table it doesn't own the DDL for, so this file is
// deliberately EXCLUDED from drizzle.config.ts's schema glob the same way
// events.ts is. `.existing()` is what stops drizzle-kit from ever proposing a
// `CREATE VIEW` for something that's already hand-migrated — without it,
// drizzle-kit would treat this as a view it owns and try to "fix" it into
// existence.
//
// Column set is every `events` column (same shape as events.ts's `events`
// table, T1.2.4) plus the two computed columns the view appends:
// `classification` and `why`. Both are always non-null in practice — the
// view's CASE expressions end in an unconditional ELSE (rule 8, spec §7.1) —
// so both carry `.notNull()`. `classification` is further narrowed with
// `$type<...>()` to the exact four literals the view's CASE can ever produce;
// `why` stays plain `text` since it is free-text (spec §7.1 rule explanations
// are human-readable Spanish strings, not a closed enum).
//
// [INV-5]: this is a read-time verdict view, never written to. `pgView`
// exposes no insert/update query builder to begin with, so there is nothing
// here that could accidentally model write capability.
export const eventsClassified = pgView('events_classified', {
  eventId: text('event_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  tenantId: text('tenant_id').notNull(),
  linkId: text('link_id').notNull(),
  slug: text('slug').notNull(),
  visitorHash: text('visitor_hash'),
  httpMethod: text('http_method'),
  userAgent: text('user_agent'),
  referer: text('referer'),
  accept: text('accept'),
  acceptLanguage: text('accept_language'),
  secFetchSite: text('sec_fetch_site'),
  secFetchMode: text('sec_fetch_mode'),
  secFetchDest: text('sec_fetch_dest'),
  secFetchUser: text('sec_fetch_user'),
  secPurpose: text('sec_purpose'),
  secChUa: text('sec_ch_ua'),
  secChUaMobile: text('sec_ch_ua_mobile'),
  secChUaPlatform: text('sec_ch_ua_platform'),
  purpose: text('purpose'),
  xPurpose: text('x_purpose'),
  xMoz: text('x_moz'),
  country: text('country'),
  asn: integer('asn'),
  // enrichment — written by the worker, never at capture
  browser: text('browser'),
  browserVersion: text('browser_version'),
  os: text('os'),
  deviceType: text('device_type'),
  sourcePlatform: text('source_platform'),
  isInApp: boolean('is_in_app'),
  destHost: text('dest_host'),
  // computed by the view's CASE expressions — never stored on `events` [INV-4]
  classification: text('classification')
    .notNull()
    .$type<'humano' | 'bot' | 'unfurler' | 'prefetch'>(),
  why: text('why').notNull(),
}).existing();

/** A row as read back from `events_classified`. Read-only [INV-5]. */
export type ClassifiedEventRow = typeof eventsClassified.$inferSelect;
