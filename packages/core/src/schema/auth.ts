import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// T1.1.4 — Drizzle definitions for Better Auth's core tables, matching
// exactly what `npx better-auth generate --adapter drizzle --dialect
// postgresql` emits for this stack (singular table names, snake_case
// columns) — so wiring up Better Auth in E5 is configuration
// (`drizzleAdapter(db, { schema, provider: 'pg' })`), not a shim.
//
// ONE deliberate departure from that generated output: every timestamp
// column here is `timestamp(..., { withTimezone: true })`, not drizzle's
// plain (naive) `timestamp(...)`, which is what the generator defaults
// to. CLAUDE.md: "Timestamps are timestamptz, never naive." Better Auth
// itself only ever reads/writes a JS Date through these columns — a
// tz-aware column is a strict superset its adapter neither notices nor
// cares about.
//
// user.id doubles as tenant_id for v1 (invariant 9): every tenant-owned
// table's own tenant_id (links, bio_pages, domains, ...) is a plain text
// FK to user.id, never a separate tenants table. session/account/
// verification are auth-owned, not tenant-owned, and deliberately carry
// no tenant_id of their own.
//
// No column here has a database-generated default for `id` — ids are
// ULIDs generated in application code (packages/core/src/ulid.ts) and
// passed in on insert, never left to the database.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // [security review, batch 1] Better Auth's own generated column,
    // kept unchanged — standard practice for session/auth audit trails
    // (detecting session hijacking, listing "signed in from" devices).
    // This is NOT in tension with invariant 6 ("the raw IP is never
    // stored or queued"): that invariant's context is click-analytics
    // capture (the redirect hot path, S2.3/S3.x), where visitor_hash
    // replaces the IP specifically because millions of anonymous
    // visitors' IPs would otherwise be retained indefinitely. This
    // column stores the IP of an authenticated user's OWN login session
    // (today: the single seeded v1 account, invariant 9) — a
    // fundamentally different retention/consent context, not a second,
    // undocumented place invariant 6 is being violated.
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);
