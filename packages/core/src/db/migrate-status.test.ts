import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDbClient, runDrizzleMigrations, type DbClient } from './client';
import {
  getMigrationStatus,
  hasPendingMigrations,
  loadDrizzleJournal,
  main,
  parseCreatedAtMs,
} from './migrate-status';
import { migrate } from './migrate';

// T1.5.2 — `pnpm migrate:status` reports both migration flavors in one
// table (filename, flavor, applied_at | PENDING) so CI (T1.5.4) can gate
// on `hasPendingMigrations()` directly instead of parsing printed output.
const CONTAINER_TEST_TIMEOUT_MS = 120_000;
const CONTAINER_POOL_MAX = 5;

describe('migrate-status (T1.5.2)', () => {
  let container: StartedPostgreSqlContainer;
  let client: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = createDbClient({ connectionString: container.getConnectionUri(), max: CONTAINER_POOL_MAX });
  }, CONTAINER_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await client.closeDb();
    await container.stop();
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a half-migrated database (drizzle applied, sql not yet) lists the sql files as PENDING', async () => {
    await runDrizzleMigrations(client.db);

    const rows = await getMigrationStatus(client.pool);

    const drizzleRows = rows.filter((row) => row.flavor === 'drizzle');
    const sqlRows = rows.filter((row) => row.flavor === 'sql');

    expect(drizzleRows.length).toBeGreaterThan(0);
    for (const row of drizzleRows) {
      expect(row.appliedAt).not.toBe('PENDING');
    }

    expect(sqlRows.length).toBeGreaterThan(0);
    for (const row of sqlRows) {
      expect(row.appliedAt).toBe('PENDING');
    }

    expect(hasPendingMigrations(rows)).toBe(true);
  });

  it('after pnpm migrate applies both flavors, nothing is pending', async () => {
    await migrate(client.pool, client.db);

    const rows = await getMigrationStatus(client.pool);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.appliedAt).not.toBe('PENDING');
    }
    expect(hasPendingMigrations(rows)).toBe(false);
  });
});

describe('loadDrizzleJournal (S1.5 review, typescript-reviewer HIGH)', () => {
  let tmpRoot: string;

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws naming the file when the journal is not valid JSON', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'posta-migrate-status-'));
    const metaDir = path.join(tmpRoot, 'meta');
    mkdirSync(metaDir, { recursive: true });
    const journalPath = path.join(metaDir, '_journal.json');
    writeFileSync(journalPath, '{ not valid json');

    expect(() => loadDrizzleJournal(journalPath)).toThrow(/not valid JSON/);
  });

  it('throws when the parsed journal has no entries array', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'posta-migrate-status-'));
    const metaDir = path.join(tmpRoot, 'meta');
    mkdirSync(metaDir, { recursive: true });
    const journalPath = path.join(metaDir, '_journal.json');
    writeFileSync(journalPath, JSON.stringify({ version: '7' }));

    expect(() => loadDrizzleJournal(journalPath)).toThrow(/does not have the expected/);
  });

  it('throws naming the missing file when the journal does not exist', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'posta-migrate-status-'));
    const journalPath = path.join(tmpRoot, 'meta', '_journal.json');

    expect(() => loadDrizzleJournal(journalPath)).toThrow(/failed to read the drizzle journal/);
  });
});

describe('parseCreatedAtMs (S1.5 review, code-reviewer HIGH / typescript-reviewer MEDIUM)', () => {
  it('parses a genuine bigint-as-string epoch value', () => {
    expect(parseCreatedAtMs('1784756682006')).toBe(1784756682006);
  });

  it('throws, naming the bad value, rather than silently producing NaN', () => {
    expect(() => parseCreatedAtMs('not-a-number')).toThrow(/was not a numeric epoch-ms value/);
  });
});

describe('main() — the real pnpm migrate:status CLI entrypoint (coverage, S1.5 review)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPoolMax = process.env.DB_POOL_MAX;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = originalPoolMax;
    vi.restoreAllMocks();
  });

  it('sets exitCode to 0 against a fully-migrated database and prints the table', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const client = createDbClient({ connectionString: container.getConnectionUri(), max: 5 });
    await migrate(client.pool, client.db);
    await client.closeDb();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DB_POOL_MAX = '5';
    const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => undefined);
    const originalExitCode = process.exitCode;

    try {
      await expect(main()).resolves.toBeUndefined();
      expect(tableSpy).toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = originalExitCode;
      await container.stop();
    }
  }, CONTAINER_TEST_TIMEOUT_MS);

  it('a real getMigrationStatus() failure (connecting to an already-stopped container) propagates', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const deadConnectionUri = container.getConnectionUri();
    await container.stop();

    process.env.DATABASE_URL = deadConnectionUri;
    process.env.DB_POOL_MAX = '5';

    await expect(main()).rejects.toThrow();
  }, CONTAINER_TEST_TIMEOUT_MS);
});
