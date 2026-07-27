import { getTableColumns } from 'drizzle-orm';
import type { CaptureEvent } from '@posta/contracts';
import { describe, expect, it } from 'vitest';
import type { EnrichmentResult } from '../enrichment';
import { events } from '../schema/events';
import { newId } from '../ulid';
import { serializeBatch, type LoggedEvent } from './ndjson';

// T3.4.2 (E3, S3.4) [INV-4][INV-6] — serializeBatch() is the R2 NDJSON
// writer for invariant 7 ("the R2 log is the source of truth for events;
// every event goes to both Postgres and R2"). Its allowlist is what makes
// invariant 6 (no raw IP ever stored or queued) and invariant 4 (the worker
// enriches, it never judges — no verdict column) hold even if some FUTURE
// bug upstream attaches an `ip` or a `classification`/`is_bot` field to the
// object that reaches this serializer: a spread would faithfully re-leak
// that field into a permanent, durable R2 object. These tests protect that
// property mechanically, not just by inspection.
//
// EXPECTED_EVENT_COLUMNS is derived from schema/events.ts's OWN column
// definitions at test-run time via drizzle-orm's getTableColumns(), the
// same "can't silently drift from a hand-copied list" discipline
// capture.test.ts's EXPECTED_KEYS applies (there, hand-copied WITH a
// comment justifying it because CaptureEventSchema has no comparable
// introspection helper for a Zod .strict() shape's own DB-column mapping;
// here, events.ts is a real Drizzle table, so deriving it directly is both
// practical and strictly safer than a 31-column hand-copy).
const EXPECTED_EVENT_COLUMNS = Object.values(getTableColumns(events))
  .map((column) => column.name)
  .sort();

/** A realistic, fully-populated capture (every §5.1 signal non-null). */
function buildCaptureEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    event_id: newId(),
    occurred_at: '2026-07-24T12:00:00.000Z',
    tenant_id: newId(),
    link_id: newId(),
    slug: 'promo',
    http_method: 'GET',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0',
    referer: 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com',
    accept: 'text/html,application/xhtml+xml',
    accept_language: 'es-AR,es;q=0.9',
    sec_fetch_site: 'cross-site',
    sec_fetch_mode: 'navigate',
    sec_fetch_dest: 'document',
    sec_fetch_user: '?1',
    sec_purpose: null,
    sec_ch_ua: '"Chromium";v="125", "Not.A/Brand";v="24"',
    sec_ch_ua_mobile: '?0',
    sec_ch_ua_platform: '"Windows"',
    purpose: null,
    x_purpose: null,
    x_moz: null,
    country: 'AR',
    asn: 7303,
    visitor_hash: 'a1b2c3d4e5f6a1b2c3d4e5f6',
    ...overrides,
  };
}

/** A realistic, fully-populated enrichment result. */
function buildEnrichmentResult(overrides: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    browser: 'Chrome',
    browser_version: '125.0.0.0',
    os: 'Windows',
    device_type: 'desktop',
    source_platform: 'instagram',
    is_in_app: false,
    dest_host: 'example.com',
    ...overrides,
  };
}

function buildLoggedEvent(overrides: Partial<LoggedEvent> = {}): LoggedEvent {
  return { ...buildCaptureEvent(), ...buildEnrichmentResult(), ...overrides };
}

/** Every §5.1 signal null AND every enrichment field null/false — the "we
 * never saw anything about this hit" shape enrich()'s own all-null case
 * (enrich.test.ts) produces. */
const ALL_NULL_LOGGED_EVENT: LoggedEvent = {
  ...buildCaptureEvent({
    http_method: null,
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
  }),
  browser: null,
  browser_version: null,
  os: null,
  device_type: null,
  source_platform: 'directo',
  is_in_app: false,
  dest_host: null,
};

/** Splits serializeBatch's output into its content lines, asserting the
 * trailing-newline convention along the way so every other test can just
 * use this instead of re-deriving lines from a raw split() each time. */
function linesOf(output: string): string[] {
  const parts = output.split('\n');
  expect(parts[parts.length - 1]).toBe('');
  return parts.slice(0, -1);
}

describe('serializeBatch (T3.4.2)', () => {
  it('returns the empty string for an empty batch (no dangling newline)', () => {
    expect(serializeBatch([])).toBe('');
  });

  it('emits exactly one line per event, every line newline-terminated, no trailing blank line', () => {
    const batch = [buildLoggedEvent(), buildLoggedEvent(), buildLoggedEvent()];
    const output = serializeBatch(batch);

    expect(output.endsWith('\n')).toBe(true);
    expect(linesOf(output)).toHaveLength(batch.length);
  });

  it('every line round-trips through JSON.parse to a plain object', () => {
    const batch = [buildLoggedEvent(), buildLoggedEvent()];
    const output = serializeBatch(batch);

    for (const line of linesOf(output)) {
      const parsed: unknown = JSON.parse(line);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    }
  });

  it('the emitted key set equals the events table column list exactly', () => {
    const output = serializeBatch([buildLoggedEvent()]);
    const parsed = JSON.parse(linesOf(output)[0]!) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(EXPECTED_EVENT_COLUMNS);
  });

  it('the key set is unchanged for the all-null/never-seen-anything shape (nulls still get their key)', () => {
    const output = serializeBatch([ALL_NULL_LOGGED_EVENT]);
    const parsed = JSON.parse(linesOf(output)[0]!) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(EXPECTED_EVENT_COLUMNS);
    expect(parsed.user_agent).toBeNull();
    expect(parsed.dest_host).toBeNull();
    expect(parsed.device_type).toBeNull();
    expect(parsed.source_platform).toBe('directo');
    expect(parsed.is_in_app).toBe(false);
  });

  it('preserves real field values through serialization, per event, in batch order', () => {
    const first = buildLoggedEvent({ visitor_hash: 'first-hash', country: 'UY' });
    const second = buildLoggedEvent({ visitor_hash: 'second-hash', country: 'BR' });
    const output = serializeBatch([first, second]);
    const [firstLine, secondLine] = linesOf(output);

    const firstParsed = JSON.parse(firstLine!) as Record<string, unknown>;
    const secondParsed = JSON.parse(secondLine!) as Record<string, unknown>;

    expect(firstParsed.event_id).toBe(first.event_id);
    expect(firstParsed.visitor_hash).toBe('first-hash');
    expect(firstParsed.country).toBe('UY');
    expect(secondParsed.event_id).toBe(second.event_id);
    expect(secondParsed.visitor_hash).toBe('second-hash');
    expect(secondParsed.country).toBe('BR');
  });

  it('escapes an embedded literal newline in a field value instead of fragmenting the line', () => {
    const withEmbeddedNewline = buildLoggedEvent({ referer: 'https://example.com/a\nb\tc' });
    const batch = [withEmbeddedNewline, buildLoggedEvent()];
    const output = serializeBatch(batch);
    const contentLines = linesOf(output);

    expect(contentLines).toHaveLength(batch.length);
    const parsed = JSON.parse(contentLines[0]!) as Record<string, unknown>;
    expect(parsed.referer).toBe('https://example.com/a\nb\tc');
  });

  it('round-trips unicode and emoji field values unchanged, and stays valid UTF-8', () => {
    const withUnicode = buildLoggedEvent({
      referer: 'https://ejemplo.lat/día-vení-😀',
      user_agent: 'MobileSafari café 日本語',
    });
    const output = serializeBatch([withUnicode]);

    // Round-trips through a real UTF-8 byte buffer, not just JS string
    // identity — proves the output is safe to hand straight to a
    // Buffer.from(output, 'utf-8')-based PutObjectCommand Body.
    const viaUtf8Bytes = Buffer.from(output, 'utf-8').toString('utf-8');
    expect(viaUtf8Bytes).toBe(output);

    const parsed = JSON.parse(linesOf(output)[0]!) as Record<string, unknown>;
    expect(parsed.referer).toBe('https://ejemplo.lat/día-vení-😀');
    expect(parsed.user_agent).toBe('MobileSafari café 日本語');
  });

  it('handles a larger batch (500 events) with no line-count drift', () => {
    const batch = Array.from({ length: 500 }, () => buildLoggedEvent());
    const output = serializeBatch(batch);

    expect(linesOf(output)).toHaveLength(500);
  });

  describe('a genuinely unserializable field throws a diagnosable, whole-batch error', () => {
    it('identifies the failing event_id in the thrown error, with the original TypeError as cause, rather than a bare JSON.stringify error', () => {
      // A BigInt is the most realistic thing JSON.stringify actually
      // chokes on here: none of EventLogLine's 31 fields can naturally
      // produce a circular reference, but nothing at runtime stops a
      // caller from violating LoggedEvent's own type. Unlike the
      // planted-EXTRA-key test below (a strict widening, so `as
      // LoggedEvent` alone compiles), swapping `asn`'s type from `number`
      // to `bigint` is an incompatible narrowing — TS's overlap check
      // correctly rejects a direct `as LoggedEvent` here, so this goes
      // through `unknown` first, same as any other deliberate
      // runtime-only type violation.
      const poisonedEventId = newId();
      const poisonedEvent = {
        ...buildLoggedEvent({ event_id: poisonedEventId }),
        asn: 123n,
      } as unknown as LoggedEvent;
      const goodEvent = buildLoggedEvent();

      let caught: unknown;
      try {
        serializeBatch([goodEvent, poisonedEvent]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error;
      expect(error.message).toContain(poisonedEventId);
      expect(error.cause).toBeInstanceOf(TypeError);
    });

    it('the whole batch fails — a good event earlier in the batch does not partially succeed', () => {
      const poisonedEvent = { ...buildLoggedEvent(), asn: 123n } as unknown as LoggedEvent;

      expect(() => serializeBatch([buildLoggedEvent(), poisonedEvent])).toThrow();
    });
  });

  describe('[INV-4][INV-6] the allowlist — an extra ip/classification field on the input never reaches the output', () => {
    it('a payload with planted ip and classification keys serializes WITHOUT them, anywhere', () => {
      const secretMarker = `do-not-leak-me-${newId()}`;
      const classificationMarker = `bot-verdict-should-never-appear-${newId()}`;

      // A future upstream bug (a sink implementation, an enrichment step)
      // could attach extra keys to the object that reaches this
      // serializer. `as LoggedEvent` simulates exactly that: bypassing the
      // excess-property check an object LITERAL assigned to LoggedEvent
      // would otherwise trigger, the same way a real accidental widening
      // upstream would not be caught by this function's own input type
      // either (LoggedEvent describes the fields this function READS, not
      // an exhaustive runtime guarantee about what the object also has).
      const plantedEvent = {
        ...buildLoggedEvent(),
        ip: secretMarker,
        classification: classificationMarker,
      } as LoggedEvent;

      const output = serializeBatch([plantedEvent]);
      const parsed = JSON.parse(linesOf(output)[0]!) as Record<string, unknown>;

      // Parsed-object assertion: the keys structurally aren't there.
      expect(Object.keys(parsed)).not.toContain('ip');
      expect(Object.keys(parsed)).not.toContain('classification');
      expect(parsed).not.toHaveProperty('ip');
      expect(parsed).not.toHaveProperty('classification');

      // Raw-string assertion: give it real teeth — the marker values don't
      // appear ANYWHERE in the serialized output, not just under expected
      // key names.
      expect(output).not.toContain(secretMarker);
      expect(output).not.toContain(classificationMarker);
      expect(output).not.toContain('"ip"');
      expect(output).not.toContain('"classification"');
    });
  });
});
