import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// T1.2.4 — READ-ONLY Drizzle typing for `events` (the hand-written SQL
// table from T1.2.2/T1.2.3, packages/core/migrations/sql/001_events.sql).
// This mirrors the DDL exactly so app code gets types (EventRow for
// reads, NewEvent for the worker's batch insert) without drizzle-kit
// owning the DDL — drizzle-kit cannot emit `PARTITION BY`, so this file
// is deliberately EXCLUDED from drizzle.config.ts's schema glob
// (`!(*.test|events).ts`). If it were included, the next `db:generate`
// would see a table with no matching migration history and try to
// "fix" the partitioning away with a plain CREATE TABLE, which would
// either fail against the real partitioned table or silently propose
// dropping the partitioning entirely.
//
// No `.primaryKey()`/`.notNull()`-driven constraints beyond column
// nullability are declared as DDL-owning here on purpose — this is a
// shape mirror, not a second source of truth for the table's DDL. The
// worker's batch insert instead passes ON CONFLICT's target columns
// explicitly: `.onConflictDoNothing({ target: [events.eventId,
// events.occurredAt] })` [INV-8], which needs no schema-level
// declaration either.
export const events = pgTable('events', {
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
});

/** A row as read back from `events`. */
export type EventRow = typeof events.$inferSelect;

/** The worker's batch insert shape. */
export type NewEvent = typeof events.$inferInsert;
