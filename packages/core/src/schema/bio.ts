import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth';

// T1.1.6 — `bio_pages`: unlike `links.slug` (T1.1.5, per-tenant unique),
// `handle` is GLOBALLY unique — it is a DNS subdomain of
// POSTA_LINK_DOMAIN (see .env.example; no literal domain belongs here or
// anywhere else in code — an E0 grep test enforces it), and two tenants
// can never share a subdomain the way they can each own their own
// `/promo`. `theme_id` stays a plain text key naming a React theme
// component (spec §11 deleted the `contracts/themes` indirection) — no
// FK, no themes table.
export const bioPages = pgTable('bio_pages', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => user.id),
  handle: text('handle').notNull().unique(),
  displayName: text('display_name'),
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  themeId: text('theme_id').notNull().default('default'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
