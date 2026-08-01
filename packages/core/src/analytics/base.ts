import { and, eq, sql, type SQL } from 'drizzle-orm';
import { eventsClassified } from '../schema/events-classified';

// T4.3.1 [E4, S4.3][INV-9][INV-10] — the seam every analytics query built in
// the rest of S4.3 (summary T4.3.2, timeseries T4.3.3, breakdowns T4.3.4,
// recibos T4.3.5, overview T4.3.6, sparklines T4.3.7) imports and composes.
// Three primitives, matching this task's own title:
//
//   1. AnalyticsRange + resolveRange() — an explicit CLOSED `timestamptz`
//      interval, never an open/unbounded lower bound. An unbounded range
//      (e.g. `occurred_at <= now()` with no lower bound) defeats the whole
//      point of `events`' monthly partitioning (T1.2.3): Postgres cannot
//      prune to a subset of partitions when it cannot prove which ones the
//      predicate excludes, so every query would scan every partition ever
//      created. `resolveRange('todo', ...)` is the one case that is easy to
//      get wrong here — the naive "everything since the link existed" reads
//      like "no lower bound", but it has one: the link's OWN `created_at`.
//   2. tenantScopePredicate() — the read-only-view analogue of
//      db/tenant.ts's `forTenant()`. `forTenant()` cannot cover
//      `events_classified` itself: it is a `pgView(...).existing()`
//      (schema/events-classified.ts, T4.1.3), never one of the four
//      writable tables `forTenant()` wraps (links/bioPages/bioLinks/
//      domains), and every analytics query here is a bespoke SELECT
//      (aggregates, generate_series joins, keyset pagination) rather than
//      the plain select/update/delete/insert shape `forTenant()`'s
//      per-table builders assume. Same defensive shape as `tenantScope()`
//      there, on purpose: a hand-written `extra` predicate is wrapped in
//      its own parens before being ANDed with the tenant condition, so a
//      caller-supplied predicate containing a top-level OR cannot invert
//      the tenant boundary via SQL's AND-before-OR precedence. See that
//      function's own comment for the fuller worked example; the
//      regression test in base.test.ts below proves the identical shape
//      here.
//   3. humansOnlyPredicate() + AnalyticsQueryOptions — [INV-10]'s
//      structural home. Every later query function threads
//      `AnalyticsQueryOptions` through (or a superset of it), and because
//      `tenantId` is a required — not optional — field on that interface,
//      a query function that forgets to accept a tenant scope is a
//      compile error, not a code-review nit (base.test.ts's own
//      `@ts-expect-error` case proves this). `includeNonHumans` defaults
//      to falsy, so calling `humansOnlyPredicate({ tenantId })` with
//      nothing else restricts to real humans UNLESS the caller explicitly
//      opts out — the one deliberate exception in this whole story is
//      `recibos` (T4.3.5), which defaults to every classification because
//      an audit log that silently hid the bots would defeat its own
//      purpose; every other query in this file's siblings keeps this
//      default.
//
// `MAX_ROWS` / `MAX_PAGE_SIZE` round out the seam: every later query's own
// `.limit(...)` call reads one of these two constants, never a bare
// integer literal repeated at each call site — see each constant's own
// comment for why its specific value was chosen.

/**
 * `'todo'` reads as the Spanish "all" (`todo el período` — the whole
 * period), matching this repo's Spanish-first UI language (CLAUDE.md) —
 * the dashboard's own range picker will render "7d" / "30d" / "Todo".
 */
export type AnalyticsRange = '7d' | '30d' | 'todo';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Day span for every range EXCEPT `'todo'`, which has no fixed span — its
 * lower bound is the link's own `created_at` (see {@link resolveRange}). */
function rangeDaySpan(range: Exclude<AnalyticsRange, 'todo'>): number {
  switch (range) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    default: {
      // Exhaustiveness check: if AnalyticsRange ever grows a third
      // non-'todo' member, this stops compiling instead of silently
      // falling through to a runtime error only a caller would hit.
      const exhaustiveCheck: never = range;
      throw new Error(`resolveRange: unsupported AnalyticsRange "${String(exhaustiveCheck)}"`);
    }
  }
}

/** An explicit, CLOSED `[from, to]` interval — never an open/unbounded
 * lower bound. Every field is a genuine `Date`, ready to bind straight
 * into a `between(eventsClassified.occurredAt, from, to)` predicate. */
export interface ResolvedRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Resolves `range` into a closed `[from, to]` interval.
 *
 * - `'7d'`   → `[now - 7 days, now]`
 * - `'30d'`  → `[now - 30 days, now]`
 * - `'todo'` → `[linkCreatedAt, now]` — the link's OWN creation instant,
 *   never `-infinity`/`null`/an open bound. See this file's own header
 *   comment for why an open bound would be a partition-pruning bug, not
 *   just a style nit.
 *
 * Takes `linkCreatedAt: Date` directly rather than a whole `link` object —
 * every caller in S4.3 already has a specific link row in hand by the time
 * it needs a range (summary/timeseries/breakdowns/overview all take a
 * `linkId`), and a bare `Date` keeps this function trivially unit-testable
 * with no schema-shaped fixture required.
 *
 * `now` defaults to `new Date()` but is accepted explicitly so a test can
 * pass a fixed instant directly — no `vi.useFakeTimers()` global-clock
 * mutation required for a function this pure. Returns FRESH `Date`
 * instances (`new Date(x.getTime())`), never the caller's own
 * `linkCreatedAt`/`now` references back — a caller that later mutates a
 * `ResolvedRange` field in place (Date is a mutable object) must never be
 * able to reach back and corrupt the link row's own `createdAt`.
 */
export function resolveRange(
  range: AnalyticsRange,
  linkCreatedAt: Date,
  now: Date = new Date(),
): ResolvedRange {
  const to = new Date(now.getTime());

  if (range === 'todo') {
    return { from: new Date(linkCreatedAt.getTime()), to };
  }

  const days = rangeDaySpan(range);
  const from = new Date(now.getTime() - days * MS_PER_DAY);
  return { from, to };
}

/** The one classification value {@link humansOnlyPredicate} restricts to
 * by default — kept as a named constant rather than a repeated literal
 * so every call site and every test reads the same word. */
export const HUMANO_CLASSIFICATION = 'humano' as const;

/**
 * The options bag every analytics query function in S4.3 accepts (or
 * extends). `tenantId` is a genuinely required field at the TYPE level —
 * not a runtime-checked optional — so a query function signature that
 * omits a tenant scope fails to compile [INV-9]; base.test.ts's
 * `@ts-expect-error` case proves omitting it is rejected, not merely
 * discouraged. `includeNonHumans` is the one opt-in escape hatch from
 * [INV-10]'s humans-only default, and defaults to `false`/absent — never
 * the reverse.
 */
export interface AnalyticsQueryOptions {
  readonly tenantId: string;
  readonly includeNonHumans?: boolean;
}

/**
 * Builds the humans-only restriction [INV-10]: `classification = 'humano'`
 * unless `options.includeNonHumans` is `true`, in which case this returns
 * `undefined` — Drizzle's own `.where(predicate?: SQL)` treats `undefined`
 * as "no additional restriction", which is exactly the opt-in shape this
 * needs (the caller ANDs this in only when it compiles to something).
 *
 * Takes the FULL {@link AnalyticsQueryOptions} bag, not just
 * `includeNonHumans`, even though `tenantId` itself is unused inside this
 * function — every downstream query threads ONE options shape through
 * end to end, so this helper's own signature mirrors the shape every
 * query function will actually receive, rather than a narrower ad hoc
 * type only this file recognizes.
 */
export function humansOnlyPredicate(options: AnalyticsQueryOptions): SQL | undefined {
  if (options.includeNonHumans) return undefined;
  return eq(eventsClassified.classification, HUMANO_CLASSIFICATION);
}

/**
 * ANDs `tenant_id = tenantId` onto an optional extra predicate, scoped to
 * `events_classified` — the read-only-view analogue of db/tenant.ts's
 * `tenantScope()` for the four writable tables `forTenant()` wraps.
 *
 * [security] `extra` is wrapped in its OWN parens — `sql\`(${extra})\`` —
 * before being ANDed with the tenant condition, load-bearing for the exact
 * reason `tenantScope()`'s own comment documents: `and(a, b)` parenthesizes
 * the WHOLE expression but not each operand, so a hand-written `extra`
 * containing a top-level, unparenthesized `OR` would otherwise invert the
 * tenant boundary via SQL's AND-before-OR precedence. Verified by the
 * identical regression shape in base.test.ts.
 */
export function tenantScopePredicate(tenantId: string, extra?: SQL): SQL {
  const scoped = eq(eventsClassified.tenantId, tenantId);
  if (!extra) return scoped;
  return and(scoped, sql`(${extra})`)!;
}

/**
 * Ceiling for any single non-paginated analytics query's `.limit(...)`
 * (e.g. a breakdown's `GROUP BY`, or a batched sparkline query across N
 * links) — high enough that no realistic per-tenant result set approaches
 * it, low enough that a query that accidentally drops its range/tenant
 * predicate and starts scanning everything fails fast (an empty-looking
 * dashboard that's obviously wrong) rather than silently returning an
 * unbounded response.
 */
export const MAX_ROWS = 10_000;

/**
 * Per-page cap for the paginated `recibos` feed (T4.3.5) — the dashboard
 * renders one page of the receipts table at a time, so 100 keeps a single
 * page's render and payload small; `packages/contracts`' T4.5.1 zod
 * request schema will reject any client-requested page size above this.
 */
export const MAX_PAGE_SIZE = 100;
