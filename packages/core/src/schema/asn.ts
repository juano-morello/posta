import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// T1.4.1 — global reference data: a datacenter ASN is a fact about the
// internet, not about a tenant, so this table deliberately carries no
// tenant_id (unlike links/bio-pages/bio-links/domains, T1.1.5-8). Adding
// an ASN being a plain INSERT (T1.4.3's seed script) — not a migration
// against a live partitioned events table — is the whole point: E4's
// classification view joins this table (S1.4's acceptance criterion)
// rather than hardcoding a list that can only grow via a deploy.
export const asnDatacenter = pgTable('asn_datacenter', {
  asn: integer('asn').primaryKey(),
  name: text('name').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
});
