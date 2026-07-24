import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';
import { newId } from '../ulid';
import { user } from './auth';
import { bioLinks, bioPages } from './bio';
import { links } from './links';

// T1.1.7 — `bio_links` is a pure join table: the FK to `links.id` is what
// makes "every bio link is already tracked" true by construction, so there
// is deliberately no `url`/`destination`/`href` column to ever drift from
// that. All assertions run against a REAL testcontainers Postgres.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;

interface DrizzleQueryError extends Error {
  readonly cause?: { readonly code?: string };
}

function pgErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return (error as DrizzleQueryError).cause?.code;
}

async function seedTenant(handle: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await handle.db.insert(user).values({
    id: tenantId,
    name: 'Test Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

async function seedBioPage(handle: PgContainerHandle, tenantId: string): Promise<string> {
  const bioPageId = newId();
  await handle.db.insert(bioPages).values({
    id: bioPageId,
    tenantId,
    handle: `handle-${bioPageId.toLowerCase()}`,
  });
  return bioPageId;
}

async function seedLink(handle: PgContainerHandle, tenantId: string): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({
    id: linkId,
    tenantId,
    slug: `slug-${linkId.toLowerCase()}`,
    destination: 'https://example.com',
  });
  return linkId;
}

describe('bio_links schema (T1.1.7)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('has no url, destination, or href column — the FK to links.id is the only pointer', async () => {
    const result = await handle.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bio_links'
    `);

    const columnNames = result.rows.map((row) => row.column_name);
    const forbidden = columnNames.filter((name) => /url|destination|href/i.test(name));
    expect(forbidden).toEqual([]);
  });

  it('raises SQLSTATE 23503 for an unknown link_id', async () => {
    const tenantId = await seedTenant(handle);
    const bioPageId = await seedBioPage(handle, tenantId);

    let caughtCode: string | undefined;
    try {
      await handle.db.insert(bioLinks).values({
        id: newId(),
        tenantId,
        bioPageId,
        linkId: newId(), // no such link exists
        position: 0,
      });
    } catch (error) {
      caughtCode = pgErrorCode(error);
    }

    expect(caughtCode).toBe('23503');
  });

  it('raises SQLSTATE 23503 when deleting a link that is still referenced', async () => {
    const tenantId = await seedTenant(handle);
    const bioPageId = await seedBioPage(handle, tenantId);
    const linkId = await seedLink(handle, tenantId);

    await handle.db.insert(bioLinks).values({
      id: newId(),
      tenantId,
      bioPageId,
      linkId,
      position: 0,
    });

    let caughtCode: string | undefined;
    try {
      await handle.db.execute(sql`DELETE FROM links WHERE id = ${linkId}`);
    } catch (error) {
      caughtCode = pgErrorCode(error);
    }

    expect(caughtCode).toBe('23503');
  });

  it('deleting a bio_page cascades to its bio_links', async () => {
    const tenantId = await seedTenant(handle);
    const bioPageId = await seedBioPage(handle, tenantId);
    const linkId = await seedLink(handle, tenantId);

    await handle.db.insert(bioLinks).values({
      id: newId(),
      tenantId,
      bioPageId,
      linkId,
      position: 0,
    });

    await handle.db.execute(sql`DELETE FROM bio_pages WHERE id = ${bioPageId}`);

    const result = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM bio_links WHERE bio_page_id = ${bioPageId}
    `);
    expect(result.rows[0]?.count).toBe('0');
  });

  it('raises SQLSTATE 23505 for a duplicate (bio_page_id, position)', async () => {
    const tenantId = await seedTenant(handle);
    const bioPageId = await seedBioPage(handle, tenantId);
    const linkA = await seedLink(handle, tenantId);
    const linkB = await seedLink(handle, tenantId);

    await handle.db.insert(bioLinks).values({
      id: newId(),
      tenantId,
      bioPageId,
      linkId: linkA,
      position: 0,
    });

    let caughtCode: string | undefined;
    try {
      await handle.db.insert(bioLinks).values({
        id: newId(),
        tenantId,
        bioPageId,
        linkId: linkB,
        position: 0, // duplicate position on the same bio page
      });
    } catch (error) {
      caughtCode = pgErrorCode(error);
    }

    expect(caughtCode).toBe('23505');
  });
});
