import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSqlMigrations } from '../db/sql-migrate';
import { startPgContainer, type PgContainerHandle } from '../test/pg-container';

// T4.1.6 [E4, S4.1][INV-5] — events_classified (T4.1.1,
// packages/core/migrations/sql/006_events_classified.sql) enumerates every
// raw `events` column BY NAME, deliberately never `e.*` (Postgres freezes a
// `*` at CREATE VIEW time — see that file's own header). This test is the
// drift guard for that enumeration: it queries information_schema.columns
// for the base table and the view directly against a real testcontainers
// Postgres (never a mock, never a unit test against the SQL text in
// isolation), and asserts the view's column set equals the table's column
// set plus exactly {classification, why}. A later migration that adds a raw
// signal column to `events` without also adding it to 006's SELECT list
// would be captured and stored at insert time, then silently unqueryable
// through the view everyone is supposed to use (INV-5) — this test turns
// that silent gap into a failing CI run that names the missing column.
//
// The nested describe block below proves the guard itself is real, not a
// tautology: it adds a column to `events` inside a transaction that is
// ALWAYS rolled back (same shape as ../schema/events-forbidden-columns.test.ts,
// T1.2.5), re-runs the IDENTICAL parity logic against that broken schema,
// asserts it fails and names the drifted column, then rolls back and
// re-verifies the schema is exactly as it was — so this test can never leak
// the extra column into another test file sharing the same container.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'sql');

const BASE_TABLE = 'events';
const VIEW_NAME = 'events_classified';

// The only two columns 006_events_classified.sql appends beyond a straight
// passthrough of every raw `events` column (see that file's own CASE
// expressions producing `classification` and `why`).
const EXTRA_VIEW_COLUMNS = ['classification', 'why'] as const;

type QueryableClient = Pool | PoolClient;

async function getColumnNames(client: QueryableClient, tableName: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY column_name
    `,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

interface ViewParityResult {
  readonly missingFromView: readonly string[];
  readonly unexpectedInView: readonly string[];
}

/**
 * Pure comparison, no DB access — same shape as the other analytics guards
 * in this directory (findRawEventsAccess in ./no-raw-events.test.ts): a
 * small pure function both the "real" parity test and the drift-detection
 * test below drive directly, so the drift test exercises the EXACT SAME
 * logic path as production, never a hand-rolled duplicate assertion.
 */
function checkViewParity(
  tableColumns: readonly string[],
  viewColumns: readonly string[],
  extraExpectedColumns: readonly string[],
): ViewParityResult {
  const viewColumnSet = new Set(viewColumns);
  const missingFromView = tableColumns.filter((column) => !viewColumnSet.has(column));

  const tableColumnSet = new Set(tableColumns);
  const extraExpectedSet = new Set(extraExpectedColumns);
  const unexpectedInView = viewColumns.filter(
    (column) => !tableColumnSet.has(column) && !extraExpectedSet.has(column),
  );

  return { missingFromView, unexpectedInView };
}

/**
 * Throws, naming every drifted column by name, unless the view covers every
 * table column plus exactly the expected extras — no more, no less.
 */
function assertViewCoversEveryColumn(result: ViewParityResult): void {
  if (result.missingFromView.length === 0 && result.unexpectedInView.length === 0) return;

  const parts: string[] = [];
  if (result.missingFromView.length > 0) {
    parts.push(
      `present in "${BASE_TABLE}" but missing from "${VIEW_NAME}": ${result.missingFromView.join(', ')}`,
    );
  }
  if (result.unexpectedInView.length > 0) {
    parts.push(
      `present in "${VIEW_NAME}" but not in "${BASE_TABLE}" (and not one of the expected extra ` +
        `columns ${EXTRA_VIEW_COLUMNS.join(', ')}): ${result.unexpectedInView.join(', ')}`,
    );
  }

  throw new Error(`${VIEW_NAME} column parity check failed — column(s) ${parts.join('; ')}`);
}

describe('events_classified column parity (T4.1.6, INV-5)', () => {
  let handle: PgContainerHandle;

  beforeAll(async () => {
    handle = await startPgContainer();
    await runSqlMigrations(handle.pool, { migrationsDir: MIGRATIONS_DIR });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await handle.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('the view column set equals the table column set plus exactly classification and why', async () => {
    const tableColumns = await getColumnNames(handle.pool, BASE_TABLE);
    const viewColumns = await getColumnNames(handle.pool, VIEW_NAME);

    // Sanity check on the fixture itself — if this were ever 0, every
    // assertion below would trivially pass for the wrong reason.
    expect(tableColumns.length).toBeGreaterThan(0);

    const result = checkViewParity(tableColumns, viewColumns, EXTRA_VIEW_COLUMNS);
    expect(() => assertViewCoversEveryColumn(result)).not.toThrow();
    expect(result.missingFromView).toEqual([]);
    expect(result.unexpectedInView).toEqual([]);

    // Belt-and-suspenders: a direct sorted-array equality assertion, for a
    // readable diff straight from `expect` if this ever regresses. Both
    // sides re-sorted in JS (not relying on the SQL ORDER BY collation
    // matching JS's default sort) so this can never flake on locale-specific
    // string ordering.
    expect([...viewColumns].sort()).toEqual([...tableColumns, ...EXTRA_VIEW_COLUMNS].sort());
  });

  describe('drift detection: an events column added without a matching view update', () => {
    const DRIFT_COLUMN = 'sec_ch_ua_arch';

    it('is caught by the parity check, which names the exact column, inside a transaction that is always rolled back', async () => {
      const client = await handle.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE ${BASE_TABLE} ADD COLUMN ${DRIFT_COLUMN} text`);

        const tableColumns = await getColumnNames(client, BASE_TABLE);
        const viewColumns = await getColumnNames(client, VIEW_NAME);

        expect(tableColumns).toContain(DRIFT_COLUMN);
        expect(viewColumns).not.toContain(DRIFT_COLUMN);

        const result = checkViewParity(tableColumns, viewColumns, EXTRA_VIEW_COLUMNS);
        expect(result.missingFromView).toEqual([DRIFT_COLUMN]);
        expect(result.unexpectedInView).toEqual([]);

        expect(() => assertViewCoversEveryColumn(result)).toThrowError(
          new RegExp(`present in "${BASE_TABLE}" but missing from "${VIEW_NAME}": ${DRIFT_COLUMN}`),
        );
      } finally {
        // Always rolled back, whether or not the assertions above threw —
        // this transaction must never leave the drifted column in place for
        // another test file sharing this container to inherit.
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('left no trace — events and events_classified are exactly as they were before the drift test ran', async () => {
      const tableColumns = await getColumnNames(handle.pool, BASE_TABLE);
      const viewColumns = await getColumnNames(handle.pool, VIEW_NAME);

      expect(tableColumns).not.toContain(DRIFT_COLUMN);
      expect(viewColumns).not.toContain(DRIFT_COLUMN);

      const result = checkViewParity(tableColumns, viewColumns, EXTRA_VIEW_COLUMNS);
      expect(() => assertViewCoversEveryColumn(result)).not.toThrow();
      expect([...viewColumns].sort()).toEqual([...tableColumns, ...EXTRA_VIEW_COLUMNS].sort());
    });
  });
});
