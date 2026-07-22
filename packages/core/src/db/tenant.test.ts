import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { newId } from '../ulid';
import { user } from '../schema/auth';
import { bioLinks, bioPages } from '../schema/bio';
import { domains } from '../schema/domains';
import { links } from '../schema/links';
import { forTenant } from './tenant';

// T1.1.9 — forTenant(tenantId) is what turns "every query path is
// tenant-scoped" from something a reviewer has to remember into something
// the type system (and this test) enforces. All assertions run against a
// REAL testcontainers Postgres.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

describe('forTenant (T1.1.9)', () => {
  let handle: PgContainerHandle;
  let tenantA: string;
  let tenantB: string;
  let linkA: string;
  let linkB: string;

  beforeAll(async () => {
    handle = await startPgContainer();
    tenantA = await seedTenant(handle);
    tenantB = await seedTenant(handle);

    linkA = newId();
    await handle.db.insert(links).values({
      id: linkA,
      tenantId: tenantA,
      slug: 'tenant-a-link',
      destination: 'https://example.com/a',
    });

    linkB = newId();
    await handle.db.insert(links).values({
      id: linkB,
      tenantId: tenantB,
      slug: 'tenant-b-link',
      destination: 'https://example.com/b',
      title: 'original-title',
    });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it("tenant A's scoped select reads zero of tenant B's links", async () => {
    const repoA = forTenant(handle.db, tenantA);

    const rows = await repoA.links.select();
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(linkA);
    expect(ids).not.toContain(linkB);
  });

  it("an update scoped to tenant A does not touch tenant B's row, even when targeted by id", async () => {
    const repoA = forTenant(handle.db, tenantA);

    // Attempt to update tenant B's link while scoped to tenant A — the
    // tenant condition is ANDed onto whatever extra predicate the caller
    // supplies, so targeting tenant B's row by id must still affect zero
    // rows.
    const updated = await repoA.links
      .update({ title: 'hijacked' }, eq(links.id, linkB))
      .returning({ id: links.id });

    expect(updated).toEqual([]);

    const [rowB] = await handle.db
      .select({ title: links.title })
      .from(links)
      .where(eq(links.id, linkB));

    expect(rowB?.title).toBe('original-title');
  });

  it.each([
    ['links', () => forTenant(handle.db, tenantA).links.select()],
    ['bioPages', () => forTenant(handle.db, tenantA).bioPages.select()],
    ['bioLinks', () => forTenant(handle.db, tenantA).bioLinks.select()],
    ['domains', () => forTenant(handle.db, tenantA).domains.select()],
  ] as const)('%s: .toSQL() contains "tenant_id" = $1', (_name, buildQuery) => {
    const query = buildQuery();
    const { sql } = query.toSQL();

    expect(sql).toContain('"tenant_id" = $1');
  });

  it("insert() stamps tenant_id on every table, without the caller passing it", async () => {
    const repoA = forTenant(handle.db, tenantA);

    const linkId = newId();
    await repoA.links.insert({ id: linkId, slug: 'stamped-link', destination: 'https://x.test' });

    const bioPageId = newId();
    await repoA.bioPages.insert({ id: bioPageId, handle: `stamped-${bioPageId.toLowerCase()}` });

    const bioLinkId = newId();
    await repoA.bioLinks.insert({ id: bioLinkId, bioPageId, linkId, position: 0 });

    const domainId = newId();
    await repoA.domains.insert({ id: domainId, host: `stamped-${domainId.toLowerCase()}.test` });

    const [insertedLink] = await handle.db.select().from(links).where(eq(links.id, linkId));
    const [insertedBioPage] = await handle.db
      .select()
      .from(bioPages)
      .where(eq(bioPages.id, bioPageId));
    const [insertedBioLink] = await handle.db
      .select()
      .from(bioLinks)
      .where(eq(bioLinks.id, bioLinkId));
    const [insertedDomain] = await handle.db.select().from(domains).where(eq(domains.id, domainId));

    expect(insertedLink?.tenantId).toBe(tenantA);
    expect(insertedBioPage?.tenantId).toBe(tenantA);
    expect(insertedBioLink?.tenantId).toBe(tenantA);
    expect(insertedDomain?.tenantId).toBe(tenantA);
  });

  it("delete() scoped to tenant A does not remove tenant B's row, even when targeted by id", async () => {
    const repoA = forTenant(handle.db, tenantA);

    const deleted = await repoA.links.delete(eq(links.id, linkB)).returning({ id: links.id });
    expect(deleted).toEqual([]);

    const [stillThere] = await handle.db.select().from(links).where(eq(links.id, linkB));
    expect(stillThere?.id).toBe(linkB);
  });

  it("select()/update()/delete() on bioPages, bioLinks and domains are genuinely scoped to tenant A", async () => {
    const repoA = forTenant(handle.db, tenantA);
    const repoB = forTenant(handle.db, tenantB);

    const bioPageBId = newId();
    await repoB.bioPages.insert({
      id: bioPageBId,
      handle: `tenant-b-${bioPageBId.toLowerCase()}`,
    });

    const domainBId = newId();
    await repoB.domains.insert({ id: domainBId, host: `tenant-b-${domainBId.toLowerCase()}.test` });

    const bioPagesForA = await repoA.bioPages.select();
    expect(bioPagesForA.map((row) => row.id)).not.toContain(bioPageBId);

    const domainsForA = await repoA.domains.select();
    expect(domainsForA.map((row) => row.id)).not.toContain(domainBId);

    const bioPageUpdate = await repoA.bioPages
      .update({ displayName: 'hijacked' }, eq(bioPages.id, bioPageBId))
      .returning({ id: bioPages.id });
    expect(bioPageUpdate).toEqual([]);

    const domainDelete = await repoA.domains
      .delete(eq(domains.id, domainBId))
      .returning({ id: domains.id });
    expect(domainDelete).toEqual([]);
  });
});
