import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth';

// T1.1.8 — `domains` ships EMPTY in v1: nothing reads or writes it. It
// exists so that Cloudflare-for-SaaS custom domains (v1.5) are an INSERT
// plus a read path against an already-live table, not a migration
// against a live partitioned database. `type` is the v1.5 seam: a CHECK
// restricts it to the two values the product will ever need
// ('subdomain' today, 'custom' once v1.5 lands) rather than leaving it a
// free-text column nothing enforces.
export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey(),
    // Same NO ACTION rationale as links.tenantId (schema/links.ts):
    // users are never deleted in v1, so a future account-deletion flow
    // must explicitly cascade or archive/redact tenant data first.
    tenantId: text('tenant_id')
      .notNull()
      .references(() => user.id),
    host: text('host').notNull().unique(),
    type: text('type').notNull().default('subdomain'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('domains_type_check', sql`${table.type} IN ('subdomain', 'custom')`),
  ],
);
