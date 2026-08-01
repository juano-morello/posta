import type { Pool } from 'pg';
import type { Fixture, FixtureSignals } from './schema';

// T4.4.2 [E4, S4.4] — the golden corpus RUNNER: replays a fixture's raw
// `signals` through a real `events` row and reads the verdict back through
// `events_classified` (T4.1.1, packages/core/migrations/sql/
// 006_events_classified.sql) — never asserting against the view's CASE
// logic in isolation, the same "real Postgres, never a mock" discipline
// events-classified.test.ts (T4.1.1's own suite) already established for
// the view itself. This file is deliberately mechanism-only: it ships with
// no opinion about WHICH fixtures exist. golden.test.ts's own tests supply
// a handful of throwaway ones to prove the runner works; the real seed
// data (corpus/browsers.json, unfurlers.json, ...) is T4.4.3-T4.4.8's job,
// and every one of those tasks calls this SAME `runGoldenCorpus` —
// changing its reporting shape later is a cross-cutting change, not a
// local one.
//
// A single tenant/link namespace is enough here: fixtures assert a
// classification verdict over request signals, never over tenant
// isolation, so every fixture shares one synthetic tenant_id/link_id and
// gets its own slug/event_id derived from its fixture id.
const CORPUS_TENANT_ID = 'tenant-golden-corpus';
const CORPUS_LINK_ID = 'link-golden-corpus';

function eventIdFor(fixture: Fixture): string {
  return `evt-${fixture.id}`;
}

function slugFor(fixture: Fixture): string {
  return `slug-${fixture.id}`;
}

/**
 * Inserts (or re-inserts) exactly one `events` row for `fixture`, deriving
 * event_id/slug from its id and leaving tenant_id/link_id fixed (see
 * above). DELETEs any pre-existing row for this event_id first, rather
 * than relying on `ON CONFLICT (event_id, occurred_at)`: occurred_at is
 * `now()`, which differs on every call, so a naive upsert would never
 * actually hit that conflict target and would instead accumulate a second,
 * stale row every time a fixture with the same id is replayed (e.g. a
 * caller that runs the same corpus twice in one process, or a test that
 * flips a fixture's `expect` and re-runs it) — leaving `events_classified`
 * ambiguous about which of two rows for the same event_id is "the" answer.
 * Delete-then-insert makes every replay of a given fixture id start from a
 * clean slate, however many times it runs.
 */
async function insertFixtureEvent(pool: Pool, fixture: Fixture, eventId: string): Promise<void> {
  const s: FixtureSignals = fixture.signals;

  await pool.query(`DELETE FROM events WHERE event_id = $1`, [eventId]);

  await pool.query(
    `INSERT INTO events (
       event_id, occurred_at, tenant_id, link_id, slug,
       http_method, user_agent, referer, accept, accept_language,
       sec_fetch_site, sec_fetch_mode, sec_fetch_dest, sec_fetch_user, sec_purpose,
       sec_ch_ua, sec_ch_ua_mobile, sec_ch_ua_platform,
       purpose, x_purpose, x_moz, country, asn
     ) VALUES (
       $1, now(), $2, $3, $4,
       $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17,
       $18, $19, $20, $21, $22
     )`,
    [
      eventId,
      CORPUS_TENANT_ID,
      CORPUS_LINK_ID,
      slugFor(fixture),
      s.http_method,
      s.user_agent,
      s.referer,
      s.accept,
      s.accept_language,
      s.sec_fetch_site,
      s.sec_fetch_mode,
      s.sec_fetch_dest,
      s.sec_fetch_user,
      s.sec_purpose,
      s.sec_ch_ua,
      s.sec_ch_ua_mobile,
      s.sec_ch_ua_platform,
      s.purpose,
      s.x_purpose,
      s.x_moz,
      s.country,
      s.asn,
    ],
  );
}

interface ClassifiedRow {
  readonly classification: string;
  readonly why: string;
}

async function readClassification(pool: Pool, fixture: Fixture, eventId: string): Promise<ClassifiedRow> {
  const result = await pool.query<ClassifiedRow>(
    `SELECT classification, why FROM events_classified WHERE event_id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  if (!row) {
    // An infrastructure failure (the insert above didn't land, or
    // events_classified itself is missing), not a classification mismatch
    // — thrown immediately rather than folded into the mismatch list,
    // since there is no "expected vs actual verdict" to report when there
    // is no row at all.
    throw new Error(
      `Golden corpus runner: events_classified returned no row for fixture "${fixture.id}" ` +
        `(event_id "${eventId}") after inserting it — check the events insert above landed.`,
    );
  }
  return row;
}

/**
 * The signals actually worth printing in a mismatch report: `http_method`
 * always (every rule 1-8 implicitly depends on SOME request having
 * happened, and rule 3 keys on it directly), plus every OTHER signal that
 * is non-null. A corpus fixture's own convention (schema.ts's header
 * comment) is that an absent header is itself evidence — so the null
 * fields are the uninteresting default, and the non-null ones are exactly
 * the candidates for whichever rule fired. This deliberately does NOT
 * re-derive "which rule fired" by re-implementing the view's CASE
 * expressions in TypeScript: a second copy of that logic here would itself
 * need to be kept in sync with 006_events_classified.sql, which is the
 * exact drift risk the golden corpus exists to catch in the FIRST place.
 */
function relevantSignals(signals: FixtureSignals): Readonly<Record<string, string | number | null>> {
  const entries = Object.entries(signals).filter(([key, value]) => key === 'http_method' || value !== null);
  return Object.fromEntries(entries);
}

export interface GoldenExpectedOrActual {
  readonly classification: string;
  readonly why: string;
}

export interface GoldenMismatch {
  readonly fixtureId: string;
  readonly userAgent: string | null;
  /** Non-null signals (plus http_method always) — the ones a maintainer needs to read to see why a rule fired or didn't. */
  readonly relevantSignals: Readonly<Record<string, string | number | null>>;
  readonly expected: GoldenExpectedOrActual;
  readonly actual: GoldenExpectedOrActual;
}

export interface GoldenRunResult {
  readonly total: number;
  readonly passed: number;
  readonly mismatches: readonly GoldenMismatch[];
}

/**
 * Replays every fixture in `fixtures` through a real `events` insert and
 * compares `events_classified`'s verdict against `fixture.expect`. Never
 * throws on a classification mismatch — it collects EVERY mismatch and
 * returns them all in `result.mismatches`, rather than failing fast on the
 * first one, so a maintainer running the golden corpus sees the full
 * breakdown in one run instead of playing fix-one-rerun whack-a-mole.
 * (It DOES throw on a genuine infrastructure failure — see
 * readClassification above — since there is nothing meaningful to report
 * as "expected vs actual" when the row never made it into the view at
 * all.)
 */
export async function runGoldenCorpus(fixtures: readonly Fixture[], pool: Pool): Promise<GoldenRunResult> {
  // Pairing each fixture with its derived event_id up front (rather than
  // indexing a parallel array by position later) sidesteps
  // noUncheckedIndexedAccess entirely — `fixtures[i]` types as possibly
  // `undefined` under that flag, `.map`/`for...of` over this pairing does
  // not.
  const withEventIds = fixtures.map((fixture) => ({ fixture, eventId: eventIdFor(fixture) }));

  for (const { fixture, eventId } of withEventIds) {
    await insertFixtureEvent(pool, fixture, eventId);
  }

  const mismatches: GoldenMismatch[] = [];

  for (const { fixture, eventId } of withEventIds) {
    const actual = await readClassification(pool, fixture, eventId);
    const expected = fixture.expect;

    if (actual.classification !== expected.classification || actual.why !== expected.why) {
      mismatches.push({
        fixtureId: fixture.id,
        userAgent: fixture.signals.user_agent,
        relevantSignals: relevantSignals(fixture.signals),
        expected: { classification: expected.classification, why: expected.why },
        actual,
      });
    }
  }

  return { total: fixtures.length, passed: fixtures.length - mismatches.length, mismatches };
}

/**
 * Renders every mismatch as a numbered, per-fixture block — id, UA, the
 * signals that mattered, and expected-vs-actual for BOTH classification
 * and why — so a maintainer can read a golden-test failure in under a
 * minute (the plan's own acceptance bar for this corpus) without re-running
 * anything or cross-referencing a separate fixture file by hand.
 */
export function formatGoldenMismatches(mismatches: readonly GoldenMismatch[]): string {
  return mismatches
    .map((mismatch, index) => {
      const lines = [
        `${index + 1}) fixture "${mismatch.fixtureId}"`,
        `   user-agent: ${mismatch.userAgent ?? '(null)'}`,
        `   relevant signals: ${JSON.stringify(mismatch.relevantSignals)}`,
        `   classification: expected "${mismatch.expected.classification}", got "${mismatch.actual.classification}"`,
        `   why:            expected "${mismatch.expected.why}", got "${mismatch.actual.why}"`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Throws a single aggregated error naming every mismatched fixture when
 * `result.mismatches` is non-empty; does nothing when the corpus is clean.
 * Exists so a real golden-corpus test (this file's own, and every T4.4.3+
 * production-corpus test) can write `assertGoldenCorpusPasses(await
 * runGoldenCorpus(fixtures, pool))` as its one assertion, with vitest's own
 * failure output showing the full per-fixture breakdown rather than just
 * "expected [] to equal [ {...} ]".
 */
export function assertGoldenCorpusPasses(result: GoldenRunResult): void {
  if (result.mismatches.length === 0) return;

  throw new Error(
    `Golden corpus: ${result.mismatches.length}/${result.total} fixture(s) disagree with ` +
      `events_classified's verdict:\n\n${formatGoldenMismatches(result.mismatches)}`,
  );
}
