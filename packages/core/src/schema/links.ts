import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { user } from './auth';

// T1.1.5 — `links`: the tenant-owned table CRUD (E2) and the redirect hot
// path (E2's other epic) both read. `UNIQUE (tenant_id, slug)` is
// per-tenant, never global (invariant 9) — two tenants each owning
// `/promo` on their own subdomains is correct, not a collision.
//
// `destination` carries a CHECK as defense in depth BEHIND the contracts
// Zod validation (T1.1.11) — the DB is the last line, not the only one:
// a bug or a direct psql session bypassing the API can never insert a
// non-http(s) destination. `~*` is Postgres's case-insensitive regex
// match; `^https?://` mirrors T1.1.11's own absolute-URL rule.
//
// Index on `(tenant_id, created_at DESC)` for the links list query — the
// DESC direction matches how that query actually orders (newest first),
// so Postgres can walk the index in the query's own order instead of
// sorting after the scan.
//
// tenant_id is a plain `text` FK to user.id (invariant 9: tenant_id ==
// user_id for v1) — no separate tenants table. No explicit `onDelete`,
// so it defaults to Postgres's NO ACTION: deleting a user with existing
// links fails loudly rather than silently cascading tenant data away.
// Users are never deleted in v1 (no account-deletion flow exists), so
// this has no current code path. If v1.5+ adds account deletion, this FK
// must either cascade explicitly or a pre-delete handler must
// archive/redact tenant data first — recorded here so that decision
// isn't made by accident.
export const links = pgTable(
  'links',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => user.id),
    slug: text('slug').notNull(),
    destination: text('destination').notNull(),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    unique('links_tenant_id_slug_key').on(table.tenantId, table.slug),
    index('links_tenant_id_created_at_idx').on(table.tenantId, table.createdAt.desc()),
    check('links_destination_absolute_url_check', sql`${table.destination} ~* '^https?://'`),
  ],
);
