import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventsClassified } from '../schema/events-classified';
import {
  HUMANO_CLASSIFICATION,
  MAX_PAGE_SIZE,
  MAX_ROWS,
  humansOnlyPredicate,
  resolveRange,
  tenantScopePredicate,
  type AnalyticsQueryOptions,
} from './base';

// T4.3.1 [E4, S4.3][INV-9][INV-10] — unit-level only, no testcontainers
// Postgres: every assertion below is either pure (resolveRange) or a
// `.toSQL()` COMPILE of a query builder, which never issues a query over
// the wire (the pg driver connects lazily on the first `.then()`/execute
// call, never at `new Pool(...)` construction or at `.toSQL()`). The Pool
// below is constructed with a connection string nothing ever dials.

describe('resolveRange (T4.3.1)', () => {
  const NOW = new Date('2026-01-15T12:00:00.000Z');
  const LINK_CREATED_AT = new Date('2025-11-01T03:30:00.000Z');

  it("'todo' resolves a closed interval whose `from` is EXACTLY the link's createdAt — never null/-infinity/open", () => {
    const { from, to } = resolveRange('todo', LINK_CREATED_AT, NOW);

    expect(from).toEqual(LINK_CREATED_AT);
    expect(from.getTime()).toBe(LINK_CREATED_AT.getTime());
    expect(to).toEqual(NOW);
  });

  it("'todo' never hands back the caller's own createdAt reference — mutating the result must not corrupt the link row", () => {
    const { from } = resolveRange('todo', LINK_CREATED_AT, NOW);

    from.setFullYear(1999);

    expect(LINK_CREATED_AT.getFullYear()).toBe(2025);
  });

  it("'7d' resolves to [now - 7 days, now]", () => {
    const { from, to } = resolveRange('7d', LINK_CREATED_AT, NOW);

    expect(to).toEqual(NOW);
    expect(from).toEqual(new Date('2026-01-08T12:00:00.000Z'));
  });

  it("'30d' resolves to [now - 30 days, now]", () => {
    const { from, to } = resolveRange('30d', LINK_CREATED_AT, NOW);

    expect(to).toEqual(NOW);
    expect(from).toEqual(new Date('2025-12-16T12:00:00.000Z'));
  });

  it('defaults `now` to the current instant when omitted', () => {
    const before = Date.now();
    const { to } = resolveRange('7d', LINK_CREATED_AT);
    const after = Date.now();

    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime()).toBeLessThanOrEqual(after);
  });

  it('an unrecognized range value throws rather than silently producing an invalid interval', () => {
    // Cast past the union on purpose — this is the shape an unchecked
    // value crossing a process boundary (e.g. a not-yet-validated HTTP
    // query param, before T4.5.1's zod schema exists) would take.
    expect(() => resolveRange('90d' as unknown as '7d', LINK_CREATED_AT, NOW)).toThrow(
      /unsupported AnalyticsRange/,
    );
  });
});

describe('humansOnlyPredicate / tenantScopePredicate — compiled SQL (T4.3.1, INV-9, INV-10)', () => {
  let pool: Pool;
  let db: NodePgDatabase;

  beforeAll(() => {
    pool = new Pool({ connectionString: 'postgres://user:pass@127.0.0.1:1/unused' });
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('omitting includeNonHumans compiles a WHERE containing the humans-only restriction', () => {
    const query = db
      .select()
      .from(eventsClassified)
      .where(humansOnlyPredicate({ tenantId: 'tenant-1' }));

    const { sql: compiledSql, params } = query.toSQL();

    // Asserted against BOTH forms so this test can never pass vacuously
    // regardless of which one Drizzle's pg dialect actually emits for a
    // literal string equality — a bound parameter ($1 in the text, the
    // literal value in `params`) or inline SQL text.
    const containsInlineLiteral = compiledSql.includes(`'${HUMANO_CLASSIFICATION}'`);
    const containsBoundParam = params.includes(HUMANO_CLASSIFICATION);
    expect(containsInlineLiteral || containsBoundParam).toBe(true);
    expect(compiledSql).toContain('"classification"');
  });

  it('includeNonHumans: true returns undefined — no restriction is compiled at all', () => {
    const predicate = humansOnlyPredicate({ tenantId: 'tenant-1', includeNonHumans: true });

    expect(predicate).toBeUndefined();

    // Drizzle's own `.where(undefined)` contract: no WHERE clause at all,
    // never a vacuous "WHERE true" — proving the opt-out is a genuine
    // absence, not a predicate that happens to match everything.
    const { sql: compiledSql } = db.select().from(eventsClassified).where(predicate).toSQL();
    expect(compiledSql).not.toContain('where');
  });

  it("tenantScopePredicate compiles a WHERE scoping to tenant_id", () => {
    const query = db.select().from(eventsClassified).where(tenantScopePredicate('tenant-1'));
    const { sql: compiledSql, params } = query.toSQL();

    expect(compiledSql).toContain('"tenant_id"');
    expect(params).toContain('tenant-1');
  });

  it('[security] a hand-written extra predicate containing a top-level OR cannot escape tenantScopePredicate\'s own parens', () => {
    // The identical injection shape db/tenant.test.ts's own regression
    // case guards against, applied here to events_classified instead of
    // links: without tenantScopePredicate's defensive `sql\`(${extra})\`\`
    // wrapping, `and(scoped, extra)` would compile to
    // `tenant_id = $1 and link_id = $2 or tenant_id != $3`, which SQL's
    // AND-before-OR precedence parses as
    // `(tenant_id = $1 and link_id = $2) or (tenant_id != $3)` — true for
    // every OTHER tenant's rows.
    const maliciousExtra = sql`${eventsClassified.linkId} = ${'link-a'} or ${eventsClassified.tenantId} != ${'tenant-a'}`;

    const { sql: compiledSql } = db
      .select()
      .from(eventsClassified)
      .where(tenantScopePredicate('tenant-a', maliciousExtra))
      .toSQL();

    // The extra predicate's own OR must appear strictly inside a
    // parenthesized group that the outer `tenant_id = $1 and (...)` wraps
    // — i.e. there is an opening paren between "and" and the OR text.
    const andIndex = compiledSql.indexOf(' and ');
    const orIndex = compiledSql.indexOf(' or ');
    const openParenBeforeOr = compiledSql.lastIndexOf('(', orIndex);

    expect(andIndex).toBeGreaterThan(-1);
    expect(orIndex).toBeGreaterThan(andIndex);
    expect(openParenBeforeOr).toBeGreaterThan(andIndex);
  });

  it('combining tenantScopePredicate and humansOnlyPredicate scopes both tenant and classification at once', () => {
    const options: AnalyticsQueryOptions = { tenantId: 'tenant-1' };
    const combined = db
      .select()
      .from(eventsClassified)
      .where(
        (() => {
          const scoped = tenantScopePredicate(options.tenantId);
          const humansOnly = humansOnlyPredicate(options);
          return humansOnly ? sql`${scoped} and ${humansOnly}` : scoped;
        })(),
      )
      .toSQL();

    expect(combined.sql).toContain('"tenant_id"');
    expect(combined.sql).toContain('"classification"');
    expect(combined.params).toContain('tenant-1');
    expect(combined.params).toContain(HUMANO_CLASSIFICATION);
  });
});

describe('AnalyticsQueryOptions — tenantId is required at the type level (T4.3.1, INV-9)', () => {
  it('compiles with tenantId present', () => {
    const options: AnalyticsQueryOptions = { tenantId: 'tenant-1' };
    expect(() => humansOnlyPredicate(options)).not.toThrow();
  });

  it('rejects an options object missing tenantId at COMPILE TIME', () => {
    // @ts-expect-error — AnalyticsQueryOptions.tenantId is required, not
    // optional; an object literal missing it is not assignable. Checked
    // by `pnpm typecheck:tests` (tsconfig.test.json), which type-checks
    // every *.test.ts file — NOT by `vitest run`, which transpiles test
    // files with esbuild and never type-checks them. Verified by hand:
    // widening `tenantId` to optional (`tenantId?: string`) in base.ts
    // makes `pnpm typecheck:tests` fail here with "Unused '@ts-expect-error'
    // directive" — the object literal then satisfies the (now-optional)
    // shape with no error left to suppress, proving this line genuinely
    // depends on `tenantId` being required rather than passing vacuously.
    const options: AnalyticsQueryOptions = { includeNonHumans: true };
    humansOnlyPredicate(options);
  });

  it('includeNonHumans remains genuinely optional — omitting it compiles fine', () => {
    const options: AnalyticsQueryOptions = { tenantId: 'tenant-1' };
    expect(options.includeNonHumans).toBeUndefined();
  });
});

describe('MAX_ROWS / MAX_PAGE_SIZE (T4.3.1)', () => {
  it('are positive integers, with MAX_PAGE_SIZE well under MAX_ROWS', () => {
    expect(Number.isInteger(MAX_ROWS)).toBe(true);
    expect(Number.isInteger(MAX_PAGE_SIZE)).toBe(true);
    expect(MAX_ROWS).toBeGreaterThan(0);
    expect(MAX_PAGE_SIZE).toBeGreaterThan(0);
    expect(MAX_PAGE_SIZE).toBeLessThan(MAX_ROWS);
  });

  it('match the documented values (10,000 / 100) — a change here is a deliberate API change, not an accidental edit', () => {
    expect(MAX_ROWS).toBe(10_000);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});
