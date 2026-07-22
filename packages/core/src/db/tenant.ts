import { and, eq, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { bioLinks, bioPages } from '../schema/bio';
import { domains } from '../schema/domains';
import { links } from '../schema/links';

// T1.1.9 — forTenant(tenantId) is what turns "every query path is
// tenant-scoped" from something a reviewer has to remember (and can
// forget) into something the type system expresses: every select/update/
// delete below has `tenant_id = $tenantId` ANDed in unconditionally, and
// every insert stamps `tenant_id` itself — there is no method on the
// returned object that skips it. All CRUD in E2 and E5 goes through this,
// never `db.select().from(links)` directly (T1.1.10 enforces that with a
// static scan).

/** ANDs the tenant scope onto an optional extra predicate. Shared by every
 * scoped table below so "every query is tenant-scoped" is one function's
 * job, not four near-identical copies of the same eq()/and() call. */
function tenantScope(tenantColumn: PgColumn, tenantId: string, extra?: SQL): SQL {
  const scoped = eq(tenantColumn, tenantId);
  return extra ? (and(scoped, extra) ?? scoped) : scoped;
}

function scopedLinks(db: NodePgDatabase, tenantId: string) {
  return {
    select(extra?: SQL) {
      return db
        .select()
        .from(links)
        .where(tenantScope(links.tenantId, tenantId, extra));
    },
    update(values: Partial<typeof links.$inferInsert>, extra?: SQL) {
      return db
        .update(links)
        .set(values)
        .where(tenantScope(links.tenantId, tenantId, extra));
    },
    delete(extra?: SQL) {
      return db.delete(links).where(tenantScope(links.tenantId, tenantId, extra));
    },
    insert(values: Omit<typeof links.$inferInsert, 'tenantId'>) {
      return db.insert(links).values({ ...values, tenantId });
    },
  };
}

function scopedBioPages(db: NodePgDatabase, tenantId: string) {
  return {
    select(extra?: SQL) {
      return db
        .select()
        .from(bioPages)
        .where(tenantScope(bioPages.tenantId, tenantId, extra));
    },
    update(values: Partial<typeof bioPages.$inferInsert>, extra?: SQL) {
      return db
        .update(bioPages)
        .set(values)
        .where(tenantScope(bioPages.tenantId, tenantId, extra));
    },
    delete(extra?: SQL) {
      return db.delete(bioPages).where(tenantScope(bioPages.tenantId, tenantId, extra));
    },
    insert(values: Omit<typeof bioPages.$inferInsert, 'tenantId'>) {
      return db.insert(bioPages).values({ ...values, tenantId });
    },
  };
}

function scopedBioLinks(db: NodePgDatabase, tenantId: string) {
  return {
    select(extra?: SQL) {
      return db
        .select()
        .from(bioLinks)
        .where(tenantScope(bioLinks.tenantId, tenantId, extra));
    },
    update(values: Partial<typeof bioLinks.$inferInsert>, extra?: SQL) {
      return db
        .update(bioLinks)
        .set(values)
        .where(tenantScope(bioLinks.tenantId, tenantId, extra));
    },
    delete(extra?: SQL) {
      return db.delete(bioLinks).where(tenantScope(bioLinks.tenantId, tenantId, extra));
    },
    insert(values: Omit<typeof bioLinks.$inferInsert, 'tenantId'>) {
      return db.insert(bioLinks).values({ ...values, tenantId });
    },
  };
}

function scopedDomains(db: NodePgDatabase, tenantId: string) {
  return {
    select(extra?: SQL) {
      return db
        .select()
        .from(domains)
        .where(tenantScope(domains.tenantId, tenantId, extra));
    },
    update(values: Partial<typeof domains.$inferInsert>, extra?: SQL) {
      return db
        .update(domains)
        .set(values)
        .where(tenantScope(domains.tenantId, tenantId, extra));
    },
    delete(extra?: SQL) {
      return db.delete(domains).where(tenantScope(domains.tenantId, tenantId, extra));
    },
    insert(values: Omit<typeof domains.$inferInsert, 'tenantId'>) {
      return db.insert(domains).values({ ...values, tenantId });
    },
  };
}

/**
 * Returns tenant-scoped query builders over `links`, `bio_pages`,
 * `bio_links`, and `domains`. Every select/update/delete has `tenant_id =
 * tenantId` ANDed in; every insert stamps `tenant_id` on the row. Callers
 * may still pass an extra predicate (e.g. `eq(links.id, someId)`) to
 * select/update/delete/, but it can only narrow the result further —
 * there is no way to construct a query through this object that escapes
 * its own tenant's rows.
 */
export function forTenant(db: NodePgDatabase, tenantId: string) {
  return {
    links: scopedLinks(db, tenantId),
    bioPages: scopedBioPages(db, tenantId),
    bioLinks: scopedBioLinks(db, tenantId),
    domains: scopedDomains(db, tenantId),
  };
}
