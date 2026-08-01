import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createR2Client,
  destHost,
  eventBatchKey,
  links,
  newId,
  runSqlMigrations,
  user,
  type DbClient,
  type R2ClientConfig,
} from '@posta/core';
import { startPgContainer, type PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';
import { createFlushBatch, type FlushBatch } from '../batch/flush';
import {
  main,
  parseReplayArgs,
  runReplayCli,
  replayEnvSchema,
  ReplayArgsError,
  type ReplayCliDeps,
  type ReplayCliResult,
} from './replay';

// T3.6.4 (E3, S3.6) [INV-6][INV-7][INV-8] — this suite proves the CLI
// wrapper's own three responsibilities (the plan's own verify text):
// (1) --from/--to parse as UTC instants and a bad pair (inverted,
// unparseable, or missing) fails LOUD, naming the offending flag — never
// "silently replays nothing" (the plan's own explicit anti-goal); (2)
// --tenant restricts which rows actually land in Postgres, proven against
// a REAL multi-tenant fixture (two tenants seeded, replay run scoped to
// one, the other's rows must be absent); (3) --dry-run counts without
// ever opening a write path to Postgres (row count stays 0) while still
// reporting a genuine non-zero matched count.
//
// This file deliberately does NOT re-derive its assertions from reading
// replay.ts's own implementation — every assertion below traces back to
// either the plan's verify text or an explicit, independently-derivable
// contract (e.g. "a bad --from must not exit 0"), not "whatever the
// current draft happens to do". Where the draft's own header documents a
// specific, non-obvious design decision (same-UTC-day --from/--to
// compared at raw-INSTANT granularity, not eventPrefixes' own
// day-granularity — see parseReplayArgs' own docstring), that decision is
// tested directly, because it is exactly the kind of behavior a
// transcribed-from-the-draft test would get right for the wrong reason
// (matching the code) rather than the right one (matching the documented
// contract).
//
// The dest_host-reuse invariant this whole story exists to protect
// (invariant 7) is proven the same way replay-driver.test.ts's own
// [INV-7] test proves it at the driver layer: seed a link, flush/log an
// event against its ORIGINAL destination, edit the link's destination,
// truncate Postgres, replay through this CLI, and assert the replayed
// row still carries the ORIGINAL dest_host — never the edited one. This
// file additionally proves, structurally (AST, not a text/regex scan —
// see replay-driver.test.ts's own rationale for why a real parse is
// required), that replay.ts itself never even IMPORTS enrich()/
// resolveDestinationsByLinkIds()/flushBatch — the mechanism that would
// make re-resolution possible in the first place.

const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const MIGRATIONS_DIR = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'migrations',
  'sql',
);

const REAL_R2_CONFIG: R2ClientConfig = {
  endpoint: 'http://localhost:9000',
  accessKeyId: 'posta-local-dev',
  secretAccessKey: 'posta-local-dev-secret',
  bucket: 'posta-events',
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// A random UTC day in a window no other test in this repo uses (checked:
// flush.test.ts/coupled-writes.test.ts use 2026, default-partition.test.ts
// uses 2031, stream-read.test.ts uses ~2033±8y, reconciliation.test.ts
// uses 2050-2057, replay-driver.test.ts (this file's own sibling) uses
// 2090-2098) — this worktree's MinIO bucket is shared with concurrent
// sibling agents/tests, so a random, wide, previously-unused window keeps
// a same-day collision vanishingly unlikely, same precedent those files
// already establish. Every Postgres row-count assertion below is scoped
// to this suite's OWN tenant ids (never a raw table-wide total, except
// where the whole point of the assertion IS "the table is empty right
// after TRUNCATE" — safe because startPgContainer() gives this file its
// own private container, so nothing else in this process ever shares it).
const FIXTURE_DAY_MS = Date.UTC(2110, 0, 1) + Math.floor(Math.random() * 2920) * ONE_DAY_MS;
const FIXTURE_HOUR_OFFSET = 9;
const FIXTURE_OCCURRED_AT = new Date(FIXTURE_DAY_MS + FIXTURE_HOUR_OFFSET * ONE_HOUR_MS).toISOString();
const DAY_INSTANT = new Date(FIXTURE_DAY_MS).toISOString();

// A SEPARATE random window (2119-2126, deliberately non-overlapping with
// FIXTURE_DAY_MS's own 2110-2118 range above) for the main()-entrypoint
// describe block below — it boots its OWN Postgres testcontainer (main()
// has no DI seam, so it must construct a real DbClient from env vars) but
// writes into the SAME shared MinIO bucket as the rest of this file, so it
// gets its own collision-avoidance window for the same reason the comment
// above already explains.
const MAIN_FIXTURE_DAY_MS = Date.UTC(2119, 0, 1) + Math.floor(Math.random() * 2920) * ONE_DAY_MS;
const MAIN_FIXTURE_HOUR_OFFSET = 10;
const MAIN_FIXTURE_OCCURRED_AT = new Date(
  MAIN_FIXTURE_DAY_MS + MAIN_FIXTURE_HOUR_OFFSET * ONE_HOUR_MS,
).toISOString();
const MAIN_DAY_INSTANT = new Date(MAIN_FIXTURE_DAY_MS).toISOString();

const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const PIXEL_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.0.0 Mobile Safari/537.36';

function buildCaptureEvent(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: FIXTURE_OCCURRED_AT,
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: null,
    referer: null,
    accept: null,
    accept_language: null,
    sec_fetch_site: null,
    sec_fetch_mode: null,
    sec_fetch_dest: null,
    sec_fetch_user: null,
    sec_purpose: null,
    sec_ch_ua: null,
    sec_ch_ua_mobile: null,
    sec_ch_ua_platform: null,
    purpose: null,
    x_purpose: null,
    x_moz: null,
    country: null,
    asn: null,
    visitor_hash: null,
    ...overrides,
  };
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

async function seedLink(
  handle: PgContainerHandle,
  tenantId: string,
  slug: string,
  destination: string,
): Promise<string> {
  const linkId = newId();
  await handle.db.insert(links).values({ id: linkId, tenantId, slug, destination });
  return linkId;
}

async function updateLinkDestination(
  handle: PgContainerHandle,
  linkId: string,
  destination: string,
): Promise<void> {
  await handle.pool.query('UPDATE links SET destination = $1 WHERE id = $2', [destination, linkId]);
}

interface PgTenantRow {
  readonly event_id: string;
  readonly dest_host: string | null;
}

async function fetchTenantRows(handle: PgContainerHandle, tenantId: string): Promise<PgTenantRow[]> {
  const result = await handle.pool.query(
    'SELECT event_id, dest_host FROM events WHERE tenant_id = $1 ORDER BY event_id',
    [tenantId],
  );
  return result.rows;
}

async function countAllEventRows(handle: PgContainerHandle): Promise<number> {
  const result = await handle.pool.query('SELECT event_id FROM events');
  return result.rows.length;
}

// ---------------------------------------------------------------------
// parseReplayArgs — pure, no containers. Fast, exhaustive coverage of the
// plan's own anti-goal ("rejected loudly, naming the flag, rather than
// silently replaying nothing").
// ---------------------------------------------------------------------
describe('parseReplayArgs (T3.6.4) — fails loudly, naming the offending flag [plan anti-goal: never silently replay nothing]', () => {
  it('throws ReplayArgsError naming --from when --from is missing', () => {
    expect(() => parseReplayArgs(['--to', '2026-01-02T00:00:00Z'])).toThrow(ReplayArgsError);
    expect(() => parseReplayArgs(['--to', '2026-01-02T00:00:00Z'])).toThrow(/--from/);
  });

  it('throws ReplayArgsError naming --to when --to is missing', () => {
    expect(() => parseReplayArgs(['--from', '2026-01-01T00:00:00Z'])).toThrow(/--to/);
  });

  it('throws ReplayArgsError naming --from when --from does not parse as an ISO-8601 instant', () => {
    expect(() =>
      parseReplayArgs(['--from', 'not-a-date', '--to', '2026-01-02T00:00:00Z']),
    ).toThrow(/--from/);
  });

  it('throws ReplayArgsError naming --to when --to does not parse as an ISO-8601 instant', () => {
    expect(() =>
      parseReplayArgs(['--from', '2026-01-01T00:00:00Z', '--to', 'also-not-a-date']),
    ).toThrow(/--to/);
  });

  it('throws ReplayArgsError naming both flags when --from is after --to across days', () => {
    let caught: unknown;
    try {
      parseReplayArgs(['--from', '2026-01-05T00:00:00Z', '--to', '2026-01-01T00:00:00Z']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReplayArgsError);
    expect((caught as Error).message).toMatch(/--from/);
    expect((caught as Error).message).toMatch(/--to/);
  });

  it('throws even for a SAME UTC calendar day when --from is chronologically after --to (a swapped-flags typo, not just a cross-day one)', () => {
    // eventPrefixes() itself only compares calendar DAYS and would treat
    // this pair as valid (same-day inputs always produce identical
    // output there, by design) — parseReplayArgs' own docstring names
    // this as the strictly stronger, instant-level check that exists
    // specifically to catch this case before it ever reaches eventPrefixes.
    expect(() =>
      parseReplayArgs(['--from', '2026-01-01T23:00:00Z', '--to', '2026-01-01T05:00:00Z']),
    ).toThrow(ReplayArgsError);
  });

  it('accepts a same-UTC-day pair when --from is not chronologically after --to', () => {
    expect(() =>
      parseReplayArgs(['--from', '2026-01-01T05:00:00Z', '--to', '2026-01-01T23:00:00Z']),
    ).not.toThrow();
  });

  it('rejects an unrecognized flag rather than silently ignoring it', () => {
    expect(() =>
      parseReplayArgs([
        '--from',
        '2026-01-01T00:00:00Z',
        '--to',
        '2026-01-02T00:00:00Z',
        '--bogus',
        'x',
      ]),
    ).toThrow(ReplayArgsError);
  });

  it('rejects a non-positive --batch-size, naming the flag', () => {
    expect(() =>
      parseReplayArgs([
        '--from',
        '2026-01-01T00:00:00Z',
        '--to',
        '2026-01-02T00:00:00Z',
        '--batch-size',
        '0',
      ]),
    ).toThrow(/--batch-size/);
  });

  it('rejects a --batch-size above the 500-row ceiling, naming the flag [review round 1, database-reviewer finding: a 3000+ batch size would otherwise sail past parsing and only fail as an opaque Postgres "too many parameters" error]', () => {
    expect(() =>
      parseReplayArgs([
        '--from',
        '2026-01-01T00:00:00Z',
        '--to',
        '2026-01-02T00:00:00Z',
        '--batch-size',
        '501',
      ]),
    ).toThrow(/--batch-size/);

    expect(() =>
      parseReplayArgs([
        '--from',
        '2026-01-01T00:00:00Z',
        '--to',
        '2026-01-02T00:00:00Z',
        '--batch-size',
        '3000',
      ]),
    ).toThrow(/--batch-size/);
  });

  it('accepts --batch-size exactly at the 500-row ceiling (the boundary itself is valid, not just anything below it)', () => {
    const options = parseReplayArgs([
      '--from',
      '2026-01-01T00:00:00Z',
      '--to',
      '2026-01-02T00:00:00Z',
      '--batch-size',
      '500',
    ]);
    expect(options.batchSize).toBe(500);
  });

  it('rejects --batch-size trailing garbage, naming the flag [review round 2, database-reviewer finding: Number.parseInt("500abc", 10) stops at the first non-digit and silently returns 500, contradicting this file\'s own "fail loudly, name the flag" discipline]', () => {
    expect(() =>
      parseReplayArgs([
        '--from',
        '2026-01-01T00:00:00Z',
        '--to',
        '2026-01-02T00:00:00Z',
        '--batch-size',
        '500abc',
      ]),
    ).toThrow(/--batch-size/);
  });

  it('parses a minimal valid invocation, omitting tenantId/batchSize when not given', () => {
    const options = parseReplayArgs(['--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z']);
    expect(options).toEqual({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      dryRun: false,
    });
  });

  it('parses --tenant, --dry-run, and --batch-size when given', () => {
    const options = parseReplayArgs([
      '--from',
      '2026-01-01T00:00:00Z',
      '--to',
      '2026-01-02T00:00:00Z',
      '--tenant',
      'abc123',
      '--dry-run',
      '--batch-size',
      '250',
    ]);
    expect(options).toEqual({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      dryRun: true,
      tenantId: 'abc123',
      batchSize: 250,
    });
  });
});

// ---------------------------------------------------------------------
// runReplayCli — argument-error path. No real Postgres/R2 needed: a bad
// argv must fail before either is ever touched, so a cast-through-unknown
// fake stands in for both (never dereferenced by this code path).
// ---------------------------------------------------------------------
describe('runReplayCli (T3.6.4) — bad arguments exit non-zero and never proceed to a bogus "replay" [plan anti-goal]', () => {
  function fakeDeps(): ReplayCliDeps & { readonly stdoutLines: string[]; readonly stderrLines: string[] } {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    return {
      db: {} as unknown as DbClient['db'],
      r2Client: {} as unknown as S3Client,
      r2Bucket: 'unused-bucket',
      stdout: (line: string) => stdoutLines.push(line),
      stderr: (line: string) => stderrLines.push(line),
      stdoutLines,
      stderrLines,
    };
  }

  it('exits 1 and reports --from/--to in stderr when --from is after --to, with no stdout "success" line', async () => {
    const deps = fakeDeps();
    const result = await runReplayCli(
      ['--from', '2026-01-05T00:00:00Z', '--to', '2026-01-01T00:00:00Z'],
      deps,
    );

    expect(result.exitCode).toBe(1);
    expect(result.matchedCount).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(deps.stderrLines.join('\n')).toMatch(/--from/);
    expect(deps.stderrLines.join('\n')).toMatch(/--to/);
    expect(deps.stdoutLines).toHaveLength(0);
  });

  it('exits 1 and names --from when --from is missing', async () => {
    const deps = fakeDeps();
    const result = await runReplayCli(['--to', '2026-01-01T00:00:00Z'], deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/--from/);
  });

  it('exits 1 and names --to when --to is unparseable', async () => {
    const deps = fakeDeps();
    const result = await runReplayCli(['--from', '2026-01-01T00:00:00Z', '--to', 'nope'], deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/--to/);
  });

  it('exits 1 and names --batch-size when it exceeds the 500-row ceiling, never proceeding to touch db/r2Client', async () => {
    const deps = fakeDeps();
    const result = await runReplayCli(
      ['--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z', '--batch-size', '501'],
      deps,
    );

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join('\n')).toMatch(/--batch-size/);
  });
});

// ---------------------------------------------------------------------
// runReplayCli — the real thing: real Postgres (testcontainers), real
// MinIO at localhost:9000. Two tenants seeded so --tenant's restriction
// is proven against genuine cross-tenant data, not a single-tenant
// fixture that could pass by accident.
// ---------------------------------------------------------------------
describe('runReplayCli (T3.6.4) — real replay against Postgres + MinIO [INV-6][INV-7][INV-8]', () => {
  let pg: PgContainerHandle;
  let r2Client: ReturnType<typeof createR2Client>;
  const r2CreatedKeys: string[] = [];

  let tenantA: string;
  let tenantB: string;
  let linkA: string;
  let linkB: string;
  const ORIGINAL_DEST_A = 'https://Shop.Example.com/promo-a';
  const EDITED_DEST_A = 'https://Edited.Example.net/promo-a-new';
  const ORIGINAL_DEST_B = 'https://Shop.Example.org/promo-b';

  const TOTAL_A = 4;
  const TOTAL_B = 3;
  const bogusTenantId = newId();

  let dryRunAllResult: ReplayCliResult;
  let rowCountAfterDryRunAll: number;
  let dryRunTenantAResult: ReplayCliResult;
  let rowCountAfterDryRunTenantA: number;

  let replayTenantAResult: ReplayCliResult;
  let rowsForAAfterFirstReplay: PgTenantRow[];
  let rowsForBAfterFirstReplay: PgTenantRow[];

  let replayFullResult: ReplayCliResult;
  let rowsForAAfterFullReplay: PgTenantRow[];
  let rowsForBAfterFullReplay: PgTenantRow[];

  let bogusTenantReplayResult: ReplayCliResult;
  let rowsForBogusTenant: PgTenantRow[];
  let stderrLines: string[];

  beforeAll(async () => {
    pg = await startPgContainer();
    await runSqlMigrations(pg.pool, { migrationsDir: MIGRATIONS_DIR });
    r2Client = createR2Client(REAL_R2_CONFIG);

    tenantA = await seedTenant(pg);
    tenantB = await seedTenant(pg);
    linkA = await seedLink(pg, tenantA, 'promo-a', ORIGINAL_DEST_A);
    linkB = await seedLink(pg, tenantB, 'promo-b', ORIGINAL_DEST_B);

    const eventsA: CaptureEvent[] = Array.from({ length: TOTAL_A }, (_, index) =>
      buildCaptureEvent({
        tenant_id: tenantA,
        link_id: linkA,
        slug: 'promo-a',
        user_agent: index % 2 === 0 ? DESKTOP_CHROME_UA : PIXEL_CHROME_UA,
      }),
    );
    const eventsB: CaptureEvent[] = Array.from({ length: TOTAL_B }, () =>
      buildCaptureEvent({
        tenant_id: tenantB,
        link_id: linkB,
        slug: 'promo-b',
        user_agent: DESKTOP_CHROME_UA,
      }),
    );

    // --- REAL LIVE PATH: seed both R2 (the log this CLI replays) AND
    // Postgres (about to be truncated) via the SAME flushBatch the live
    // path uses — dest_host for linkA is resolved and logged HERE,
    // against linkA's destination as it stands at flush time. That is
    // the value invariant 7 says a later replay must never change.
    const flushBatch: FlushBatch = createFlushBatch({
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });
    const batchIdA = newId();
    const batchIdB = newId();
    r2CreatedKeys.push(eventBatchKey(batchIdA, FIXTURE_OCCURRED_AT));
    r2CreatedKeys.push(eventBatchKey(batchIdB, FIXTURE_OCCURRED_AT));
    await flushBatch(eventsA, batchIdA);
    await flushBatch(eventsB, batchIdB);

    // --- ANTI-STALENESS SETUP: edit linkA's destination AFTER
    // capture/flush already happened (invariant 3 — a redirect's
    // destination legitimately changes between capture and replay). A
    // replay that re-resolves destinations at REPLAY time would now
    // record the EDITED host against old history.
    await updateLinkDestination(pg, linkA, EDITED_DEST_A);

    // --- TRUNCATE: a private, per-test Postgres testcontainer makes a
    // full TRUNCATE safe here — nothing else in this process shares it.
    await pg.pool.query('TRUNCATE TABLE events');
    expect(await countAllEventRows(pg)).toBe(0); // sanity: truncation genuinely happened

    stderrLines = [];
    const deps: ReplayCliDeps = {
      db: pg.db,
      r2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
      stdout: () => undefined,
      stderr: (line: string) => stderrLines.push(line),
    };

    // (d) --dry-run, no --tenant: counts everyone in range, inserts
    // nothing.
    dryRunAllResult = await runReplayCli(['--from', DAY_INSTANT, '--to', DAY_INSTANT, '--dry-run'], deps);
    rowCountAfterDryRunAll = await countAllEventRows(pg);

    // (c)+(d) --dry-run scoped to tenantA: counts ONLY tenantA's
    // records, still inserts nothing.
    dryRunTenantAResult = await runReplayCli(
      ['--from', DAY_INSTANT, '--to', DAY_INSTANT, '--tenant', tenantA, '--dry-run'],
      deps,
    );
    rowCountAfterDryRunTenantA = await countAllEventRows(pg);

    // (c) real replay scoped to tenantA: only tenantA's rows should
    // land.
    replayTenantAResult = await runReplayCli(
      ['--from', DAY_INSTANT, '--to', DAY_INSTANT, '--tenant', tenantA],
      deps,
    );
    rowsForAAfterFirstReplay = await fetchTenantRows(pg, tenantA);
    rowsForBAfterFirstReplay = await fetchTenantRows(pg, tenantB);

    // Default (no --tenant): replays everyone. tenantA's rows are
    // already present (ON CONFLICT DO NOTHING — no duplication);
    // tenantB's rows are new.
    replayFullResult = await runReplayCli(['--from', DAY_INSTANT, '--to', DAY_INSTANT], deps);
    rowsForAAfterFullReplay = await fetchTenantRows(pg, tenantA);
    rowsForBAfterFullReplay = await fetchTenantRows(pg, tenantB);

    // A --tenant that matches nothing in range: recordsRead still
    // reflects everything streamEventLog read, but nothing for this
    // tenant is ever buffered/inserted.
    bogusTenantReplayResult = await runReplayCli(
      ['--from', DAY_INSTANT, '--to', DAY_INSTANT, '--tenant', bogusTenantId],
      deps,
    );
    rowsForBogusTenant = await fetchTenantRows(pg, bogusTenantId);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (r2CreatedKeys.length > 0) {
      await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: REAL_R2_CONFIG.bucket,
          Delete: { Objects: r2CreatedKeys.map((key) => ({ Key: key })) },
        }),
      );
    }
    r2Client.destroy();
    await pg.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('[d] --dry-run reports a non-zero matched count across all tenants when real data is in range', () => {
    expect(dryRunAllResult.exitCode).toBe(0);
    expect(dryRunAllResult.matchedCount).toBe(TOTAL_A + TOTAL_B);
    expect(dryRunAllResult.summary).toBeUndefined();
  });

  it('[d] --dry-run inserts NOTHING into Postgres', () => {
    expect(rowCountAfterDryRunAll).toBe(0);
  });

  it('[c]+[d] --dry-run --tenant restricts the MATCHED count to that tenant only, and still inserts nothing', () => {
    expect(dryRunTenantAResult.exitCode).toBe(0);
    expect(dryRunTenantAResult.matchedCount).toBe(TOTAL_A);
    expect(rowCountAfterDryRunTenantA).toBe(0);
  });

  it('[c] a real replay scoped to --tenant tenantA inserts ONLY tenantA rows, not tenantB\'s', () => {
    expect(replayTenantAResult.exitCode).toBe(0);
    expect(rowsForAAfterFirstReplay).toHaveLength(TOTAL_A);
    expect(rowsForBAfterFirstReplay).toHaveLength(0);
  });

  it('[e][INV-7] the replayed row for the edited link keeps the ORIGINALLY-logged dest_host, never the link\'s current (edited) destination', () => {
    for (const row of rowsForAAfterFirstReplay) {
      expect(row.dest_host).toBe(destHost(ORIGINAL_DEST_A));
      expect(row.dest_host).not.toBe(destHost(EDITED_DEST_A));
    }
  });

  it('a subsequent replay with no --tenant fills in the previously-filtered-out tenantB rows, without touching tenantA\'s already-replayed rows', () => {
    expect(replayFullResult.exitCode).toBe(0);
    expect(rowsForAAfterFullReplay).toHaveLength(TOTAL_A);
    expect(rowsForAAfterFullReplay).toEqual(rowsForAAfterFirstReplay);
    expect(rowsForBAfterFullReplay).toHaveLength(TOTAL_B);
  });

  it('[c] --tenant for an id matching nothing in range reads real records but inserts none for that tenant', () => {
    expect(bogusTenantReplayResult.exitCode).toBe(0);
    expect(bogusTenantReplayResult.summary?.recordsRead).toBeGreaterThanOrEqual(TOTAL_A + TOTAL_B);
    expect(bogusTenantReplayResult.summary?.batchesWritten).toBe(0);
    expect(rowsForBogusTenant).toHaveLength(0);
  });

  it('[review round 1, silent-failure-hunter finding] a --tenant matching nothing still exits 0 (not an error) but warns on stderr, naming the tenant id, so an operator can tell "empty" apart from "typo"', () => {
    expect(bogusTenantReplayResult.exitCode).toBe(0);
    const warning = stderrLines.find((line) => line.includes(bogusTenantId));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/--tenant/);
    expect(warning).toMatch(/matched 0/);
  });
});

// ---------------------------------------------------------------------
// replayEnvSchema (T3.7.6) — mirrors apps/worker/src/env.ts's own
// "at least one of R2_ENDPOINT / R2_ACCOUNT_ID" cross-field rule
// (env.test.ts's own describe block for workerEnvSchema is this block's
// direct precedent, same assertions, same reasoning). Pure schema-level
// tests, no containers: this CLI is a disaster-recovery tool that has to
// reach the SAME production R2 bucket, addressed the SAME way, as the
// live worker — so a `.env` with only R2_ACCOUNT_ID set (production's
// own shape, R2_ENDPOINT left empty) must parse, and a `.env` with
// NEITHER set must fail loudly, naming both keys, before this CLI ever
// touches Postgres or R2.
// ---------------------------------------------------------------------
describe('replayEnvSchema (T3.7.6) — the R2_ENDPOINT / R2_ACCOUNT_ID at-least-one-of rule', () => {
  const VALID_REPLAY_ENV: Record<string, string> = {
    DATABASE_URL_WORKER: 'postgresql://posta:posta@localhost:5432/posta',
    R2_ACCESS_KEY_ID: 'test-access-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
    R2_BUCKET_EVENTS: 'posta-events',
    R2_ENDPOINT: 'http://localhost:9000',
  };

  it('parses a fully populated, valid env — the existing MinIO-backed shape (R2_ACCOUNT_ID omitted, R2_ENDPOINT set) stays valid', () => {
    const result = replayEnvSchema.safeParse(VALID_REPLAY_ENV);

    expect(result.success).toBe(true);
  });

  it('parses when R2_ACCOUNT_ID is set alone and R2_ENDPOINT is empty — production\'s own documented shape', () => {
    const result = replayEnvSchema.safeParse({
      ...VALID_REPLAY_ENV,
      R2_ENDPOINT: '',
      R2_ACCOUNT_ID: 'a'.repeat(32),
    });

    expect(result.success).toBe(true);
  });

  it('rejects when both R2_ENDPOINT and R2_ACCOUNT_ID are empty, naming BOTH keys', () => {
    const result = replayEnvSchema.safeParse({
      ...VALID_REPLAY_ENV,
      R2_ENDPOINT: '',
      R2_ACCOUNT_ID: '',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(failingPaths).toContain('R2_ENDPOINT');
      expect(failingPaths).toContain('R2_ACCOUNT_ID');

      const messages = result.error.issues.map((issue) => issue.message).join(' ');
      expect(messages).toContain('R2_ENDPOINT');
      expect(messages).toContain('R2_ACCOUNT_ID');
    }
  });

  it('rejects when both R2_ENDPOINT and R2_ACCOUNT_ID are omitted entirely', () => {
    const { R2_ENDPOINT: _R2_ENDPOINT, ...rest } = VALID_REPLAY_ENV;
    void _R2_ENDPOINT;
    const result = replayEnvSchema.safeParse(rest);

    expect(result.success).toBe(false);
  });

  // [T3.7.5's own security review, MEDIUM — mirrored here because this
  // schema mirrors that one's exact validation shape] A whitespace-only
  // R2_ACCOUNT_ID (a plausible copy/paste or trailing-newline artifact in
  // a `.env` file or k8s Secret) must NOT read as "set" — the field's own
  // bare `z.string().optional()` does no trimming, so this has to be
  // asserted explicitly rather than assumed to fall out of the '' case
  // above.
  it('rejects a whitespace-only R2_ACCOUNT_ID with an empty R2_ENDPOINT, naming BOTH keys', () => {
    const result = replayEnvSchema.safeParse({
      ...VALID_REPLAY_ENV,
      R2_ENDPOINT: '',
      R2_ACCOUNT_ID: '   ',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const failingPaths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(failingPaths).toContain('R2_ENDPOINT');
      expect(failingPaths).toContain('R2_ACCOUNT_ID');

      const messages = result.error.issues.map((issue) => issue.message).join(' ');
      expect(messages).toContain('R2_ENDPOINT');
      expect(messages).toContain('R2_ACCOUNT_ID');
    }
  });

  it('parses when R2_ACCOUNT_ID is omitted entirely and R2_ENDPOINT is set (non-regression: every existing MinIO-backed replay run in this file)', () => {
    // VALID_REPLAY_ENV never carries an R2_ACCOUNT_ID key to begin with —
    // this is the exact shape every MinIO-backed test elsewhere in this
    // file already sets, restated here as its own explicit assertion.
    expect(VALID_REPLAY_ENV).not.toHaveProperty('R2_ACCOUNT_ID');
    const result = replayEnvSchema.safeParse(VALID_REPLAY_ENV);

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------
// main() — the real, env-driven CLI entrypoint. [review round 2,
// database-reviewer finding] main() had ZERO test coverage despite its
// own docstring's claim of "the same 'main() itself is fully covered
// above' pattern migrate.test.ts already establishes" — measured at
// 71.95% lines / 66.15% branches on this file before this block existed,
// with lines 385-431 (essentially all of main()) never once executed.
// This block follows migrate.test.ts's own `describe('main() — the real
// pnpm migrate CLI entrypoint (coverage, S1.5 review)')` precedent
// (packages/core/src/db/migrate.test.ts:90-131): real env vars, a real
// Postgres, `main()` called directly, asserting on `process.exitCode`/
// rejection — never a mock of `runReplayCli` itself (main() has no DI
// seam for that; see the runError v8-ignore comment in replay.ts's own
// main() for why).
//
// Boots its OWN Postgres testcontainer (`mainPg`), not the outer
// describe's `pg` — same "a fresh container per describe" precedent
// migrate.test.ts's own main() block already establishes, and the only
// option here anyway: main() builds its own DbClient/S3Client internally
// from process.env, with no seam to hand it an already-open handle. Still
// reuses this file's own `startPgContainer`/`createR2Client` imports and
// the SAME real MinIO instance (REAL_R2_CONFIG) as every other describe
// in this file — MinIO is shared docker-compose infra, not a per-test
// testcontainer, so there is nothing to boot fresh there.
// ---------------------------------------------------------------------
describe('main() — the real posta replay CLI entrypoint (coverage, review round 2 findings)', () => {
  const ENV_KEYS = [
    'DATABASE_URL_WORKER',
    'DATABASE_URL',
    'DB_POOL_MAX',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_EVENTS',
    'R2_ENDPOINT',
  ] as const;
  type MainEnvKey = (typeof ENV_KEYS)[number];

  let mainPg: PgContainerHandle;
  let mainR2Client: S3Client;
  const mainR2CreatedKeys: string[] = [];
  const originalEnv: Partial<Record<MainEnvKey, string | undefined>> = {};
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeAll(async () => {
    mainPg = await startPgContainer();
    // startPgContainer() only applies drizzle-kit's own migrations — the
    // partitioned `events` table (and its partitions) come from the
    // hand-written SQL migrations, same as the outer describe's own `pg`
    // setup above.
    await runSqlMigrations(mainPg.pool, { migrationsDir: MIGRATIONS_DIR });
    mainR2Client = createR2Client(REAL_R2_CONFIG);
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (mainR2CreatedKeys.length > 0) {
      await mainR2Client.send(
        new DeleteObjectsCommand({
          Bucket: REAL_R2_CONFIG.bucket,
          Delete: { Objects: mainR2CreatedKeys.map((key) => ({ Key: key })) },
        }),
      );
    }
    mainR2Client.destroy();
    await mainPg.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  /** Points every env var main() reads at the real test Postgres/MinIO.
   * `DATABASE_URL` (no `_WORKER` suffix) is deliberately left UNSET —
   * `createDbClient`'s own default fallback reads exactly that var when
   * no `connectionString` is passed, so if main() ever silently used the
   * wrong one instead of `DATABASE_URL_WORKER`, that fallback would find
   * nothing and throw `"DATABASE_URL must be set"` (packages/core/src/db/
   * client.ts). A test below succeeding at all is therefore already part
   * of the proof that `DATABASE_URL_WORKER` specifically is what drives
   * the client, not a coincidence. */
  function setRealEnv(overrides: Partial<Record<MainEnvKey, string>> = {}): void {
    delete process.env.DATABASE_URL;
    process.env.DATABASE_URL_WORKER = overrides.DATABASE_URL_WORKER ?? mainPg.url;
    process.env.DB_POOL_MAX = overrides.DB_POOL_MAX ?? '5';
    process.env.R2_ACCESS_KEY_ID = overrides.R2_ACCESS_KEY_ID ?? REAL_R2_CONFIG.accessKeyId;
    process.env.R2_SECRET_ACCESS_KEY = overrides.R2_SECRET_ACCESS_KEY ?? REAL_R2_CONFIG.secretAccessKey;
    process.env.R2_BUCKET_EVENTS = overrides.R2_BUCKET_EVENTS ?? REAL_R2_CONFIG.bucket;
    process.env.R2_ENDPOINT = overrides.R2_ENDPOINT ?? REAL_R2_CONFIG.endpoint;
    // REAL_R2_CONFIG (MinIO) carries no accountId — this stays UNSET by
    // default, same "existing MinIO-backed run" shape every other test in
    // this describe already relies on, unless a test overrides it.
    if (overrides.R2_ACCOUNT_ID === undefined) delete process.env.R2_ACCOUNT_ID;
    else process.env.R2_ACCOUNT_ID = overrides.R2_ACCOUNT_ID;
  }

  it('fails fast with exitCode 1 (never throwing) when required env vars are missing, before touching Postgres or R2', async () => {
    delete process.env.DATABASE_URL_WORKER;
    delete process.env.DATABASE_URL;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET_EVENTS;
    delete process.env.R2_ENDPOINT;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    await expect(main()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  // [T3.7.6] main() itself — not just replayEnvSchema in isolation — must
  // fail loudly, naming BOTH R2_ENDPOINT and R2_ACCOUNT_ID, when neither
  // addresses R2. loadEnv (packages/contracts/src/env.ts) never echoes a
  // custom .superRefine message text into its EnvFailure list — it
  // reduces every failing Zod issue down to `{key, reason}`, one line per
  // distinct `issue.path[0]` — so the two variable NAMES are what must
  // show up in main()'s own formatEnvFailures() report, one line each,
  // never the refine's own prose.
  it('[T3.7.6] exits 1 naming BOTH R2_ENDPOINT and R2_ACCOUNT_ID when both are empty, before touching Postgres or R2', async () => {
    setRealEnv({ R2_ENDPOINT: '' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    await expect(main()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toMatch(/R2_ENDPOINT/);
    expect(output).toMatch(/R2_ACCOUNT_ID/);
  });

  it('[T3.7.6] exits 1 naming BOTH R2_ENDPOINT and R2_ACCOUNT_ID when R2_ENDPOINT is empty and R2_ACCOUNT_ID is whitespace-only', async () => {
    setRealEnv({ R2_ENDPOINT: '', R2_ACCOUNT_ID: '   ' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    await expect(main()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toMatch(/R2_ENDPOINT/);
    expect(output).toMatch(/R2_ACCOUNT_ID/);
  });

  it('[a][b] happy path: replays a real seeded event through completion using DATABASE_URL_WORKER/R2_* env vars, exitCode 0 — the row only reappears because THOSE env vars drove main()\'s own DB/R2 clients', async () => {
    const tenantId = newId();
    const linkId = newId();
    await mainPg.db.insert(user).values({
      id: tenantId,
      name: 'main() coverage tenant',
      email: `${tenantId.toLowerCase()}@example.test`,
    });
    await mainPg.db.insert(links).values({
      id: linkId,
      tenantId,
      slug: 'main-entrypoint',
      destination: 'https://Example.test/main-entrypoint',
    });

    const flushBatch: FlushBatch = createFlushBatch({
      db: mainPg.db,
      r2Client: mainR2Client,
      r2Bucket: REAL_R2_CONFIG.bucket,
    });
    const batchId = newId();
    mainR2CreatedKeys.push(eventBatchKey(batchId, MAIN_FIXTURE_OCCURRED_AT));
    await flushBatch(
      [
        buildCaptureEvent({
          tenant_id: tenantId,
          link_id: linkId,
          slug: 'main-entrypoint',
          occurred_at: MAIN_FIXTURE_OCCURRED_AT,
          user_agent: DESKTOP_CHROME_UA,
        }),
      ],
      batchId,
    );

    // flushBatch above already inserted this row into Postgres directly
    // (the live path) — delete it so the row main() finds afterward can
    // ONLY have come from main()'s OWN replay, never a leftover.
    await mainPg.pool.query('DELETE FROM events WHERE tenant_id = $1', [tenantId]);

    setRealEnv();
    process.argv = [
      'node',
      'replay',
      '--from',
      MAIN_DAY_INSTANT,
      '--to',
      MAIN_DAY_INSTANT,
      '--tenant',
      tenantId,
    ];
    process.exitCode = undefined;

    await expect(main()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);

    const rows = await mainPg.pool.query('SELECT event_id FROM events WHERE tenant_id = $1', [tenantId]);
    expect(rows.rows).toHaveLength(1);
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('[b] R2_BUCKET_EVENTS genuinely drives the R2 client — a nonexistent bucket surfaces as a real runtime failure (exitCode 2), never silently ignored', async () => {
    setRealEnv({ R2_BUCKET_EVENTS: `posta-events-does-not-exist-${newId().toLowerCase()}` });
    process.argv = [
      'node',
      'replay',
      '--from',
      MAIN_DAY_INSTANT,
      '--to',
      MAIN_DAY_INSTANT,
      '--dry-run',
    ];
    process.exitCode = undefined;

    await expect(main()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(2);
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('[Finding 1, silent-failure-hunter] r2Client.destroy() throwing does NOT skip dbClient.closeDb() — the two resource cleanups are independent', async () => {
    setRealEnv();
    process.argv = [
      'node',
      'replay',
      '--from',
      MAIN_DAY_INSTANT,
      '--to',
      MAIN_DAY_INSTANT,
      '--dry-run',
    ];
    process.exitCode = undefined;

    // main() constructs its own r2Client/dbClient internally — no DI
    // seam — so a scoped prototype spy is the only realistic way to
    // force ONE resource's own close call to fail without fighting the
    // real AWS SDK or pg driver. Restored by this describe's own
    // `afterEach` (`vi.restoreAllMocks()`).
    const destroySpy = vi.spyOn(S3Client.prototype, 'destroy').mockImplementation(() => {
      throw new Error('forced r2Client.destroy() failure for Finding 1 coverage');
    });
    const poolEndSpy = vi.spyOn(Pool.prototype, 'end');

    await expect(main()).rejects.toThrow(/forced r2Client\.destroy\(\) failure/);

    expect(destroySpy).toHaveBeenCalled();
    // The pre-fix bug: a shared try/catch meant destroy() throwing
    // aborted BEFORE `await dbClient.closeDb()` (-> `pool.end()`) ever
    // ran, leaking the Postgres pool silently. This assertion is the
    // one that would have failed against that code.
    expect(poolEndSpy).toHaveBeenCalled();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('[Finding 1] dbClient.closeDb() throwing does NOT prevent r2Client.destroy() from having already run, and is still surfaced (never silently dropped)', async () => {
    setRealEnv();
    process.argv = [
      'node',
      'replay',
      '--from',
      MAIN_DAY_INSTANT,
      '--to',
      MAIN_DAY_INSTANT,
      '--dry-run',
    ];
    process.exitCode = undefined;

    const destroySpy = vi.spyOn(S3Client.prototype, 'destroy');
    const poolEndSpy = vi
      .spyOn(Pool.prototype, 'end')
      .mockRejectedValue(new Error('forced dbClient.closeDb() failure for Finding 1 coverage'));

    await expect(main()).rejects.toThrow(/forced dbClient\.closeDb\(\) failure/);

    expect(destroySpy).toHaveBeenCalled();
    expect(poolEndSpy).toHaveBeenCalled();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('[Finding 1] BOTH r2Client.destroy() and dbClient.closeDb() failing in the same run combines both messages, never silently dropping either', async () => {
    setRealEnv();
    process.argv = [
      'node',
      'replay',
      '--from',
      MAIN_DAY_INSTANT,
      '--to',
      MAIN_DAY_INSTANT,
      '--dry-run',
    ];
    process.exitCode = undefined;

    vi.spyOn(S3Client.prototype, 'destroy').mockImplementation(() => {
      throw new Error('r2 destroy boom');
    });
    vi.spyOn(Pool.prototype, 'end').mockRejectedValue(new Error('db close boom'));

    let caught: unknown;
    try {
      await main();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/r2 destroy boom/);
    expect((caught as Error).message).toMatch(/db close boom/);
  }, CONTAINER_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------
// Structural guard: replay.ts must never even be ABLE to re-resolve a
// destination or route through the live flush path — see this file's
// own header for why the AST (not text/regex) discipline matters (a
// comment mentioning these names, like this file's own header does
// repeatedly, must never trip the check).
// ---------------------------------------------------------------------
function containsBareCallTo(sourceText: string, fileName: string, functionName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === functionName) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

describe('replay.ts never re-derives destination or enrichment — the CLI wrapper stays a thin caller of replayEventLog/streamEventLog only [T3.6.4]', () => {
  it('calls neither enrich(), resolveDestinationsByLinkIds(), nor flushBatch()', () => {
    const filePath = 'apps/worker/src/cli/replay.ts';
    const source = readFileSync(path.join(process.cwd(), filePath), 'utf8');

    expect(containsBareCallTo(source, filePath, 'enrich')).toBe(false);
    expect(containsBareCallTo(source, filePath, 'resolveDestinationsByLinkIds')).toBe(false);
    expect(containsBareCallTo(source, filePath, 'flushBatch')).toBe(false);
  });
});
