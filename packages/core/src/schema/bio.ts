import { integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { links } from './links';

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

// T1.1.7 — `bio_links`: a pure join between a bio page and a link, in
// ordered `position`. Deliberately NO `url`/`destination`/`href` column —
// the FK to `links.id` is what makes "every bio link is already tracked"
// true by construction, not by discipline (a second copy of the URL here
// would be exactly the drift that claim depends on not existing).
//
// `bioPageId` cascades: deleting a bio page takes its bio_links with it,
// since they have no meaning without their page. `linkId` restricts:
// deleting a link that a bio page still points to must fail loudly
// instead of silently leaving a dangling reference or silently
// removing it from someone's public page.
//
// `UNIQUE (bio_page_id, position)` keeps ordering unambiguous — two links
// can never claim the same slot on the same page.
export const bioLinks = pgTable(
  'bio_links',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => user.id),
    bioPageId: text('bio_page_id')
      .notNull()
      .references(() => bioPages.id, { onDelete: 'cascade' }),
    linkId: text('link_id')
      .notNull()
      .references(() => links.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('bio_links_bio_page_id_position_key').on(table.bioPageId, table.position)],
);
