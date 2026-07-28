import fs from 'node:fs';
import path from 'node:path';
import { links, newId, user } from '@posta/core';
import type { PgContainerHandle } from '@posta/core/testing';
import type { CaptureEvent } from '@posta/contracts';

// T3.5.1 [E3, S3.5] — seeding the one tenant+link every push()-built
// event resolves its `dest_host` against (see pipeline-harness.ts's own
// header, judgment call 3, for why exactly one, and why the corpus's own
// `destination` field is not used), plus loading and cycling the T3.2.6
// UA corpus. Split out of pipeline-harness.ts purely to keep each file
// inside this repo's own 200-400 line/800 hard cap convention.

export const HARNESS_SLUG = 'pipeline-harness';
export const HARNESS_DESTINATION = 'https://example.com/pipeline-harness';

// The T3.2.6 UA corpus fixture lives under packages/core's own SOURCE
// tree (not its compiled `dist/`, and not re-exported through
// `@posta/core`'s barrel — it is a data file, not a TS module). Resolved
// via `require.resolve('@posta/core/package.json')`'s own directory,
// which is a sibling of `src/` regardless of whether `dist/` has been
// built yet — the same technique apps/worker/src/consumer/
// sigterm-flush.test.ts already uses to locate `packages/core/migrations/
// sql`.
const CORPUS_PATH = path.join(
  path.dirname(require.resolve('@posta/core/package.json')),
  'src',
  'enrichment',
  'fixtures',
  'ua-corpus.json',
);

export async function seedTenant(pg: PgContainerHandle): Promise<string> {
  const tenantId = newId();
  await pg.db.insert(user).values({
    id: tenantId,
    name: 'Pipeline Harness Tenant',
    email: `${tenantId.toLowerCase()}@example.test`,
  });
  return tenantId;
}

export async function seedLink(
  pg: PgContainerHandle,
  tenantId: string,
  slug: string,
  destination: string,
): Promise<string> {
  const linkId = newId();
  await pg.db.insert(links).values({ id: linkId, tenantId, slug, destination });
  return linkId;
}

interface CorpusEntryInput {
  readonly user_agent: string | null;
  readonly referer: string | null;
}

interface CorpusEntry {
  readonly input: CorpusEntryInput;
}

let cachedCorpus: readonly CorpusEntry[] | undefined;

/** Reads and parses `ua-corpus.json` (T3.2.6) once per process, memoized
 * — the fixture is small (~40 entries) and read-only, so re-parsing it on
 * every `push()` call would be pure waste for a harness explicitly meant
 * to be called many times across a suite. */
export function loadCorpus(): readonly CorpusEntry[] {
  if (cachedCorpus === undefined) {
    const raw = fs.readFileSync(CORPUS_PATH, 'utf8');
    cachedCorpus = JSON.parse(raw) as readonly CorpusEntry[];
  }
  return cachedCorpus;
}

export interface BuildCaptureEventContext {
  readonly tenantId: string;
  readonly linkId: string;
  readonly slug: string;
  readonly occurredAt: string;
}

/** A fully-signalled `CaptureEvent`, every header field defaulted to
 * `null` except the required identity/context frame and the two fields
 * the UA corpus actually varies (`user_agent`/`referer`) — same shape
 * discipline every other `buildCaptureEvent` in this codebase already
 * follows (sigterm-flush.test.ts, coupled-writes.test.ts,
 * reconciliation.test.ts). */
export function buildCaptureEventFromCorpus(entry: CorpusEntry, context: BuildCaptureEventContext): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: context.occurredAt,
    tenant_id: context.tenantId,
    link_id: context.linkId,
    slug: context.slug,
    http_method: 'GET',
    user_agent: entry.input.user_agent,
    referer: entry.input.referer,
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
  };
}
