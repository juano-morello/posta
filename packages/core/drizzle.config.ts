import { defineConfig } from 'drizzle-kit';

// T1.1.1 — drizzle-kit config for packages/core. `schema` covers every
// table file under src/schema/ (added starting T1.1.4); `out` is where
// `db:generate` writes versioned migration SQL, and where the programmatic
// migrator (createDbClient's runDrizzleMigrations, in src/db/client.ts)
// reads from at runtime.
//
// The extglob `!(*.test).ts` (T1.1.4), not a bare `*.ts`: schema tests
// live BESIDE their source under src/schema/ (auth.test.ts next to
// auth.ts), matching this repo's own convention of tests beside source
// rather than under tests/ — but a bare `*.ts` glob would hand
// drizzle-kit auth.test.ts too, and it tries to `require()` every file it
// resolves. auth.test.ts imports 'vitest', which is ESM-only and throws
// immediately under drizzle-kit's CJS require() — this pattern excludes
// it instead of relying on drizzle-kit to skip non-schema exports.
//
// Deliberately excludes src/schema/events.ts (added S1.2): the events
// table is partitioned (`PARTITION BY RANGE`), which drizzle-kit's
// generator cannot emit — that table is a hand-written SQL migration
// instead (packages/core/migrations/manual/), applied by a separate
// runner (T1.2.1), never by drizzle-kit. Keeping events.ts out of this
// glob is what keeps `db:generate` from ever trying and failing on it.
export default defineConfig({
  schema: './src/schema/!(*.test).ts',
  out: './migrations/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
