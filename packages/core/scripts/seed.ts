#!/usr/bin/env node
// T1.5.5 [INV-9][security] — `pnpm seed` creates the SINGLE v1 account:
// one Better Auth user (tenant_id == user.id, invariant 9), its bio page
// (handle from env), and one example link so E2's redirect path has
// something to resolve. There is no public signup route in v1 — not
// hidden, absent — so this script is the only way an account is ever
// created. Idempotent by email: safe to run on every deploy.
import { hashPassword } from 'better-auth/crypto';
import { createBioPageSchema, createLinkSchema } from '@posta/contracts';
// Imported from the COMPILED barrel (../dist/index.js), not a relative
// '../src/...' path and not the '@posta/core' package name. Neither of
// those two alternatives works from here: '../src/schema/auth.ts' is
// governed by packages/core/package.json's "commonjs" declaration while
// written in ESM import/export syntax (fails at runtime with "Cannot
// use import statement outside a module" — that mismatch only
// disappears once tsc has compiled it); '@posta/core' as a bare
// specifier requires a node_modules/@posta/core entry, which pnpm's
// strict per-package isolation never creates for a package importing
// itself. A plain relative import of the already-built dist/ output
// sidesteps both — this package must be built before this script runs
// (`pnpm --filter @posta/core run build`, same requirement migrate.ts /
// migrate-status.ts / migrate-down.ts already have for their own
// `dist/db/*.js` invocations), which `pnpm seed` (root package.json)
// does before running this.
import { account, bioPages, createDbClient, links, newId, user } from '../dist/index.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

export interface SeedEnv {
  readonly email: string;
  readonly password: string;
  readonly handle: string;
}

function assertSet(value: string, envKey: string): void {
  if (!value) {
    throw new Error(`seed: ${envKey} is not set — see .env.example.`);
  }
}

// Never logs env.password anywhere in this file — SEED_USER_PASSWORD is
// already in packages/contracts/src/env.ts's SECRET_ENV_KEYS, and the
// task's own requirement ("never logged") is honored by construction:
// the raw value is read once, passed straight into hashPassword(), and
// never otherwise touched.
function loadSeedEnvFromProcessEnv(): SeedEnv {
  return {
    email: process.env.SEED_USER_EMAIL ?? '',
    password: process.env.SEED_USER_PASSWORD ?? '',
    handle: process.env.SEED_USER_HANDLE ?? '',
  };
}

export interface SeedResult {
  readonly userId: string;
  readonly bioPageId: string;
  readonly linkId: string;
}

// The one example link (S1.5's acceptance: "so the redirect path in E2
// has something to resolve") — a fixed, generic destination, never a
// Posta domain literal (tests/conventions/no-literal-domain.test.ts).
const EXAMPLE_LINK_SLUG = 'welcome';
const EXAMPLE_LINK_DESTINATION = 'https://example.com/welcome-to-posta';
const EXAMPLE_LINK_TITLE = 'Welcome to Posta';

export async function seed(pool: Pool, env: SeedEnv = loadSeedEnvFromProcessEnv()): Promise<SeedResult> {
  assertSet(env.email, 'SEED_USER_EMAIL');
  assertSet(env.password, 'SEED_USER_PASSWORD');
  assertSet(env.handle, 'SEED_USER_HANDLE');

  // Reuses contracts' own validation (handle charset + reserved-handle
  // list, slug charset + reserved-path list) rather than a second,
  // driftable copy — core→contracts is an allowed dependency arrow
  // (CLAUDE.md).
  createBioPageSchema.shape.handle.parse(env.handle);
  createLinkSchema.shape.slug.parse(EXAMPLE_LINK_SLUG);
  createLinkSchema.shape.destination.parse(EXAMPLE_LINK_DESTINATION);

  const db = drizzle(pool);

  const existingUser = await db.select().from(user).where(eq(user.email, env.email)).limit(1);
  if (existingUser[0]) {
    return findExistingSeedResult(db, existingUser[0].id);
  }

  // [S1.5 review, security-reviewer MEDIUM][INV-9] Idempotency keyed on
  // email alone would let a stale/misconfigured SEED_USER_EMAIL (a
  // different value than whatever created the first account) silently
  // create a SECOND tenant — quietly violating "seed one account" rather
  // than erroring. v1 seeds exactly one account, globally, not just one
  // per distinct email.
  const anyExistingUser = await db.select().from(user).limit(1);
  if (anyExistingUser[0]) {
    throw new Error(
      `seed: a different account already exists (${anyExistingUser[0].email}), but ` +
        `SEED_USER_EMAIL is "${env.email}" — v1 seeds exactly one account. If rotating the ` +
        `seed account is intentional, remove the existing user first.`,
    );
  }

  const userId = newId();
  const hashedPassword = await hashPassword(env.password);

  await db.insert(user).values({
    id: userId,
    name: env.handle,
    email: env.email,
    emailVerified: false,
  });
  await db.insert(account).values({
    id: newId(),
    accountId: userId,
    providerId: 'credential',
    userId,
    password: hashedPassword,
  });

  const bioPageId = newId();
  await db.insert(bioPages).values({
    id: bioPageId,
    tenantId: userId,
    handle: env.handle,
  });

  const linkId = newId();
  await db.insert(links).values({
    id: linkId,
    tenantId: userId,
    slug: EXAMPLE_LINK_SLUG,
    destination: EXAMPLE_LINK_DESTINATION,
    title: EXAMPLE_LINK_TITLE,
  });

  return { userId, bioPageId, linkId };
}

/**
 * Idempotent-by-email path: a user with this email already exists, so
 * this looks up (never re-creates) its bio page and example link.
 * Throws rather than partially re-seeding if either is unexpectedly
 * missing — a user that exists without its bio page/link is a state
 * this script never itself produces, so silently patching it back
 * together would paper over whatever left it that way.
 */
async function findExistingSeedResult(
  db: ReturnType<typeof drizzle>,
  userId: string,
): Promise<SeedResult> {
  const existingBioPage = await db.select().from(bioPages).where(eq(bioPages.tenantId, userId)).limit(1);
  const existingLink = await db
    .select()
    .from(links)
    .where(eq(links.tenantId, userId))
    .limit(1);

  const bioPage = existingBioPage[0];
  const link = existingLink[0];
  if (!bioPage || !link) {
    throw new Error(
      `seed: a user (${userId}) for SEED_USER_EMAIL already exists but is missing its bio page ` +
        `or example link — refusing to partially re-seed.`,
    );
  }

  return { userId, bioPageId: bioPage.id, linkId: link.id };
}

async function main(): Promise<void> {
  const client = createDbClient();

  // Capture-both-combine-if-both-fail, same pattern as seed-asn.ts's and
  // migrate-down.ts's main() — a pool close failure must never replace a
  // real seed() error.
  let seedError: unknown;
  let result: SeedResult | undefined;
  try {
    result = await seed(client.pool);
  } catch (error) {
    seedError = error;
  }

  let closeError: unknown;
  try {
    await client.closeDb();
  } catch (error) {
    closeError = error;
  }

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  if (seedError && closeError) {
    throw new Error(
      `seed: failed with "${describe(seedError)}", then closing the db pool also failed with ` +
        `"${describe(closeError)}".`,
    );
  }
  if (seedError) throw seedError;
  if (closeError) throw closeError;

  console.log(`seed: user ${result?.userId} ready (bio page ${result?.bioPageId}, link ${result?.linkId})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('seed: failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
