import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { CachedLink } from '@posta/contracts';
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

/**
 * ANDs the tenant scope onto an optional extra predicate. Shared by every
 * scoped table below so "every query is tenant-scoped" is one function's
 * job, not four near-identical copies of the same eq()/and() call.
 *
 * [security] `extra` is wrapped in its OWN parens — `sql\`(${extra})\`` —
 * before being ANDed with the tenant condition, and this is load-bearing,
 * not decoration. drizzle's `and(a, b)` wraps the WHOLE "a and b"
 * expression in one set of outer parens, but does not parenthesize each
 * operand individually. If `extra` were ever a hand-written `sql`
 * template containing a top-level, unparenthesized `OR` — e.g.
 * `sql\`${links.id} = ${x} or ${links.tenantId} != ${tenantId}\`` —
 * `and(scoped, extra)` compiles to
 * `(tenant_id = $1 and id = $2 or tenant_id != $3)`, which SQL's
 * AND-before-OR precedence parses as
 * `(tenant_id = $1 and id = $2) or (tenant_id != $3)` — true for every
 * OTHER tenant's rows, a complete inversion of the tenant boundary this
 * whole module exists to enforce. Wrapping `extra` in its own parens
 * makes it an atomic unit regardless of what it contains internally, so
 * no possible `extra` can escape the tenant condition. Verified with a
 * regression test in tenant.test.ts that builds exactly this shape.
 */
function tenantScope(tenantColumn: PgColumn, tenantId: string, extra?: SQL): SQL {
  const scoped = eq(tenantColumn, tenantId);
  if (!extra) return scoped;
  return and(scoped, sql`(${extra})`)!;
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

// T2.2.2 — resolveTenantByHandle is the ONE tenant-owned-table query in
// this module that does NOT go through forTenant(), and deliberately so:
// forTenant(tenantId) requires already KNOWING the tenant, and this is
// how the redirect hot path (apps/api/src/redirect/resolve.ts)
// discovers it in the first place, from a request's Host header. There
// is no tenant to scope this query BY — "which tenant owns this handle"
// is definitionally a lookup across every tenant's bio_pages rows, keyed
// on the one column (`handle`) that is GLOBALLY unique (T1.1.6), unlike
// `links.slug`, which is only unique per tenant. It is the
// chicken-and-egg case tenant-scope.test.ts's own header comment
// anticipates: "the ONE legitimate place a tenant-owned table is queried
// directly" is forTenant() for every OTHER access pattern, and this
// function for the one query that cannot possibly be tenant-scoped.
// T1.1.10's static scanner excludes this file by path for exactly this
// reason — everywhere else, `db.select().from(bioPages)` is a bypass;
// here, it is the only shape this query could ever take.
//
// Deliberately thin: no caching, no memoization, no error translation.
// apps/api/src/redirect/resolve.ts layers a process-local memo and a
// Redis cache in FRONT of this — this function is the plain, uncached
// Postgres tier at the bottom of that ladder, called only on a miss in
// both of the faster tiers.
/**
 * Resolves the `tenant_id` that owns `handle`, or `null` if no
 * `bio_pages` row has that exact handle. Exact match only — `handle` is
 * compared as-is, with no case-folding — so a request for a handle that
 * differs only by case from a real one correctly misses rather than
 * silently resolving to the wrong tenant.
 */
export async function resolveTenantByHandle(
  db: NodePgDatabase,
  handle: string,
): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: bioPages.tenantId })
    .from(bioPages)
    .where(eq(bioPages.handle, handle));

  return row?.tenantId ?? null;
}

// T2.2.4 — the redirect hot path's Postgres fallback tier for the LINK
// cache: apps/api/src/redirect/resolve.ts's lookupCachedLink (T2.2.3)
// checks Redis first; this is what it falls back to on a miss. Placed
// here, next to resolveTenantByHandle, for the same reason that function
// is: `apps/api` has no direct dependency on `drizzle-orm` (only
// `@posta/core` does — see resolveTenantByHandle's own decisions, and
// T2.2.2's report), so the query itself — unlike the caching ladder
// wrapped around it — cannot be built in resolve.ts. This function stays
// the plain, uncached Postgres tier; resolve.ts's own
// `resolveLinkFromDb` wraps it in this file's dependency-injection shape.
//
// Unlike resolveTenantByHandle, this query IS tenant-scoped — the
// tenant_id is already known by the time this tier runs (T2.2.2's
// resolveTenant already resolved it from the handle) — so it goes
// through forTenant(), never a hand-written `eq(links.tenantId, ...)`.
// Two tenants can each own the slug `promo` on their own subdomains
// (invariant 9's per-tenant UNIQUE constraint), so forgetting the tenant
// scope here would serve one tenant's destination under another's
// handle — forTenant() makes that scope unconditional, not something a
// reviewer has to remember.
//
// `archived_at IS NULL` is part of the WHERE clause, not a filter
// applied to the fetched row in JS: a user who archives a link has
// revoked it, and "resolves to nothing" has to be a property of the
// query itself, not of code a later refactor could drop.
export async function resolveLinkBySlug(
  db: NodePgDatabase,
  tenantId: string,
  slug: string,
): Promise<CachedLink | null> {
  const [row] = await forTenant(db, tenantId).links.select(
    and(eq(links.slug, slug), isNull(links.archivedAt)),
  );

  if (!row) return null;

  // Narrowed to exactly the three fields the redirect hot path (and
  // T2.2.5's Redis backfill after it) needs — the CachedLink wire shape
  // (@posta/contracts), the SAME shape lookupCachedLink returns on a
  // cache HIT, so a caller layering "cache, then this" never has to
  // reshape one tier's result to match the other's. `title`,
  // `createdAt`, `updatedAt` and `archivedAt` are never copied out:
  // forTenant().links.select() has no column-projection parameter today
  // (only `links`'s two other consumers — T1.1.9's own tests — read the
  // full row), so the fetch itself is unavoidably `SELECT *`, but
  // nothing beyond `id`/`tenantId`/`destination` ever leaves this
  // function.
  return {
    link_id: row.id,
    tenant_id: row.tenantId,
    destination: row.destination,
  };
}
