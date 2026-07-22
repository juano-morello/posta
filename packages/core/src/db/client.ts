import { join } from 'node:path';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// T1.1.1 — the db seam every later E1 task builds on: a `pg` Pool, a
// `drizzle(pool)` wrapper, a `closeDb()` for test teardown, and a
// programmatic drizzle migrator. Deliberately NOT a module-level singleton:
// T1.1.2's testcontainers harness needs a fresh pool per booted container
// (a different, dynamically-assigned port each time), and a singleton
// created at import time would bind to whatever DATABASE_URL happened to be
// set first and never let a test point it elsewhere.

/**
 * Config for {@link createDbClient}. Both fields default to env
 * (`DATABASE_URL` / `DB_POOL_MAX`) when omitted, but callers that need a
 * different target — the testcontainers harness (T1.1.2), a future
 * DATABASE_URL_WORKER connection — pass them explicitly instead.
 */
export interface DbClientOptions {
  readonly connectionString?: string;
  readonly max?: number;
}

export interface DbClient {
  readonly pool: Pool;
  readonly db: NodePgDatabase;
  closeDb(): Promise<void>;
}

function resolveConnectionString(options: DbClientOptions): string {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL must be set (or pass connectionString explicitly to createDbClient).',
    );
  }

  return connectionString;
}

/**
 * Pool `max` is explicit and env-supplied, never left to the pg driver
 * default (10) — see CLAUDE.md / plan T1.1.1. Under Kubernetes the api
 * scales horizontally, so total connections are `pool.max × replicas +
 * worker + migration Job`, and that product has to stay under the managed
 * tier's connection cap. Left implicit, the HPA scaling up under load is
 * what exhausts the database: the autoscaler succeeding *is* the outage.
 */
function resolvePoolMax(options: DbClientOptions): number {
  if (options.max !== undefined) {
    return options.max;
  }

  const rawMax = process.env.DB_POOL_MAX;
  if (!rawMax) {
    throw new Error(
      'DB_POOL_MAX must be set (or pass max explicitly to createDbClient). Pool max is ' +
        'explicit and env-supplied on purpose, never left to the driver default — see ' +
        'CLAUDE.md / plan T1.1.1.',
    );
  }

  const max = Number.parseInt(rawMax, 10);
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`DB_POOL_MAX must be a positive integer, got "${rawMax}".`);
  }

  return max;
}

/**
 * Builds the db seam: a `pg` Pool with an explicit `max`, wrapped by
 * `drizzle(pool)`. `closeDb()` ends the pool — every test that calls this
 * must call it in `afterAll`, or the process hangs on open sockets.
 */
export function createDbClient(options: DbClientOptions = {}): DbClient {
  const connectionString = resolveConnectionString(options);
  const max = resolvePoolMax(options);

  const pool = new Pool({ connectionString, max });
  const db = drizzle(pool);

  return {
    pool,
    db,
    async closeDb(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * The programmatic drizzle migrator: applies every SQL file under
 * `migrationsFolder` (drizzle-kit's own generated migrations, see
 * drizzle.config.ts) that has not already run, tracked in drizzle's own
 * `__drizzle_migrations` table. Defaults to `migrations/drizzle` — the same
 * `out` drizzle.config.ts points at — resolved relative to this file so it
 * works the same whether called from source (ts-node/vitest) or from
 * `dist/db/client.js` after a build.
 */
export async function runDrizzleMigrations(
  db: NodePgDatabase,
  migrationsFolder: string = join(__dirname, '../../migrations/drizzle'),
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
