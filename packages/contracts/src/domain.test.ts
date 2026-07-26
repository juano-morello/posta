import { describe, expect, it } from 'vitest';
import { makeUrlBuilders, type DomainConfig } from './domain';

// Deliberately NOT the real production link domain — packages/contracts
// must never contain a literal domain (CLAUDE.md), and using the real
// domain in these tests would let a hardcoded literal in the
// implementation pass unnoticed.
// T0.3.9's grep test is the enforcement; this file is the proof the
// helpers themselves take the domain as data, not as a constant.
const config: DomainConfig = {
  domain: 'example.test',
  protocol: 'https',
  appSubdomain: 'app',
  apiSubdomain: 'api',
};

describe('makeUrlBuilders', () => {
  const { buildLinkUrl, buildBioUrl, buildAppUrl, buildApiUrl, parseHandleFromHost } =
    makeUrlBuilders(config);

  describe('buildLinkUrl', () => {
    it('builds <handle>.<domain>/<slug>', () => {
      expect(buildLinkUrl('juano', 'promo')).toBe('https://juano.example.test/promo');
    });

    it('lowercases the handle', () => {
      expect(buildLinkUrl('Juano', 'promo')).toBe('https://juano.example.test/promo');
    });

    it('leaves slug casing untouched', () => {
      expect(buildLinkUrl('juano', 'Promo-2026')).toBe(
        'https://juano.example.test/Promo-2026',
      );
    });

    it('throws on the app subdomain as a handle', () => {
      expect(() => buildLinkUrl('app', 'promo')).toThrow();
    });

    it('throws on the api subdomain as a handle', () => {
      expect(() => buildLinkUrl('api', 'promo')).toThrow();
    });

    it('throws on an empty handle', () => {
      expect(() => buildLinkUrl('', 'promo')).toThrow();
    });

    it('throws on a handle containing a dot', () => {
      expect(() => buildLinkUrl('juano.evil', 'promo')).toThrow();
    });

    it('throws on an empty slug', () => {
      expect(() => buildLinkUrl('juano', '')).toThrow();
    });
  });

  describe('buildBioUrl', () => {
    it('builds <handle>.<domain>/', () => {
      expect(buildBioUrl('juano')).toBe('https://juano.example.test/');
    });

    it('lowercases the handle', () => {
      expect(buildBioUrl('Juano')).toBe('https://juano.example.test/');
    });

    it('throws on a reserved handle', () => {
      expect(() => buildBioUrl('app')).toThrow();
      expect(() => buildBioUrl('api')).toThrow();
    });
  });

  describe('buildAppUrl', () => {
    it('builds the dashboard origin with no path', () => {
      expect(buildAppUrl()).toBe('https://app.example.test');
    });

    it('builds a dashboard path', () => {
      expect(buildAppUrl('/links')).toBe('https://app.example.test/links');
    });

    it('adds a leading slash when the caller omits it', () => {
      expect(buildAppUrl('links')).toBe('https://app.example.test/links');
    });
  });

  describe('buildApiUrl', () => {
    it('builds the API origin with no path', () => {
      expect(buildApiUrl()).toBe('https://api.example.test');
    });

    it('builds a versioned API path', () => {
      expect(buildApiUrl('/v1/links')).toBe('https://api.example.test/v1/links');
    });
  });

  describe('parseHandleFromHost', () => {
    it('extracts the handle from <handle>.<domain>', () => {
      expect(parseHandleFromHost('juano.example.test')).toBe('juano');
    });

    it('is case-insensitive', () => {
      expect(parseHandleFromHost('Juano.Example.Test')).toBe('juano');
    });

    it('round-trips with buildBioUrl', () => {
      const url = buildBioUrl('juano');
      const host = new URL(url).host;
      expect(parseHandleFromHost(host)).toBe('juano');
    });

    it('round-trips with buildLinkUrl', () => {
      const url = buildLinkUrl('juano', 'promo');
      const host = new URL(url).host;
      expect(parseHandleFromHost(host)).toBe('juano');
    });

    it('returns undefined for the bare apex domain', () => {
      expect(parseHandleFromHost('example.test')).toBeUndefined();
    });

    it('returns undefined for the app subdomain', () => {
      expect(parseHandleFromHost('app.example.test')).toBeUndefined();
    });

    it('returns undefined for the api subdomain', () => {
      expect(parseHandleFromHost('api.example.test')).toBeUndefined();
    });

    it('strips a dev port before parsing', () => {
      expect(parseHandleFromHost('juano.example.test:3000')).toBe('juano');
    });

    it('returns undefined when the apex domain carries a dev port', () => {
      expect(parseHandleFromHost('example.test:3000')).toBeUndefined();
    });

    it('returns undefined for a host outside our domain', () => {
      expect(parseHandleFromHost('evil.com')).toBeUndefined();
    });

    it('returns undefined for a host that merely ends with the domain string', () => {
      // "notexample.test" ends with "example.test" as a raw substring but
      // is not a subdomain of it — must not falsely match.
      expect(parseHandleFromHost('notexample.test')).toBeUndefined();
    });

    it('returns undefined for an empty handle label', () => {
      expect(parseHandleFromHost('.example.test')).toBeUndefined();
    });

    it('returns undefined for a multi-level subdomain', () => {
      expect(parseHandleFromHost('a.b.example.test')).toBeUndefined();
    });

    it('returns undefined for an empty string', () => {
      expect(parseHandleFromHost('')).toBeUndefined();
    });

    it('resolves a trailing-dot FQDN host to the same handle', () => {
      // A single trailing dot is the DNS root label — "example.test."
      // and "example.test" are the same host, and some clients do send
      // the FQDN form in a Host header. This is the redirect hot path's
      // first step, so a real link 404ing over a trailing dot would be
      // exactly the kind of silent failure Posta exists to catch, not
      // commit.
      expect(parseHandleFromHost('juano.example.test.')).toBe('juano');
    });

    it('returns undefined for a double-trailing-dot host', () => {
      // Only one trailing dot is stripped — "juano.example.test.." is
      // malformed (a double-rooted name), not a valid FQDN, and must
      // still fall through to undefined rather than being treated the
      // same as a single trailing dot.
      expect(parseHandleFromHost('juano.example.test..')).toBeUndefined();
    });

    it('returns undefined for the apex domain with a trailing dot', () => {
      // Normalizes to the bare apex ("example.test"), which correctly
      // has no handle — same as the no-dot apex case above.
      expect(parseHandleFromHost('example.test.')).toBeUndefined();
    });

    describe('charset and length bound [security, S2.1 story-review batch]', () => {
      // Before this fix, parseHandleFromHost applied NO charset or length
      // check at all — only "non-empty" and "single label". Since this
      // function runs on an unauthenticated public endpoint's Host header,
      // that meant an attacker fully controlled the returned "handle"
      // string: any charset, any length up to Node's own header ceiling.
      // These cases pin the fix; every one of them was previously accepted.

      it('returns undefined for a label over the 63-char DNS label limit', () => {
        // RFC 1035 §3.1. 64 chars — one over the ceiling.
        const tooLong = 'a'.repeat(64);
        expect(parseHandleFromHost(`${tooLong}.example.test`)).toBeUndefined();
      });

      it('accepts a label at exactly the 63-char DNS label limit', () => {
        // The boundary itself must still work — this is a ceiling, not an
        // off-by-one trap for a legitimate 63-char handle.
        const atLimit = `a${'b'.repeat(61)}c`; // 63 chars, valid charset
        expect(atLimit).toHaveLength(63);
        expect(parseHandleFromHost(`${atLimit}.example.test`)).toBe(atLimit);
      });

      it('returns undefined for a label containing a colon outside the port position', () => {
        // stripPort only strips a trailing `:<digits>` suffix on the WHOLE
        // host; a colon that lands inside the label itself (because it is
        // followed by non-digit characters, e.g. more host) survives
        // stripPort and must still be rejected by the charset check.
        expect(parseHandleFromHost('ab:cd.example.test')).toBeUndefined();
      });

      it('returns undefined for a label containing a space', () => {
        expect(parseHandleFromHost('ab cd.example.test')).toBeUndefined();
      });

      it('returns undefined for a label containing an emoji', () => {
        expect(parseHandleFromHost('😀.example.test')).toBeUndefined();
      });

      it('returns undefined for a label with a leading hyphen', () => {
        expect(parseHandleFromHost('-abc.example.test')).toBeUndefined();
      });

      it('returns undefined for a label with a trailing hyphen', () => {
        expect(parseHandleFromHost('abc-.example.test')).toBeUndefined();
      });

      it('returns undefined for an 8000-character label (the flood-vector repro)', () => {
        // The exact shape of the finding's own repro: an attacker-sized
        // Host header, bounded only by Node's ~16 KB header ceiling before
        // this fix — now rejected immediately by the length check.
        const hostile = 'a'.repeat(8000);
        expect(parseHandleFromHost(`${hostile}.example.test`)).toBeUndefined();
      });
    });
  });
});

describe('makeUrlBuilders with a second, differently-shaped config', () => {
  // Proves nothing is hardcoded — not the domain, not the subdomain
  // labels, not the protocol.
  const other = makeUrlBuilders({
    domain: 'link.testing',
    protocol: 'http',
    appSubdomain: 'dash',
    apiSubdomain: 'svc',
  });

  it('builds URLs against the fully custom config', () => {
    expect(other.buildLinkUrl('juano', 'promo')).toBe('http://juano.link.testing/promo');
    expect(other.buildBioUrl('juano')).toBe('http://juano.link.testing/');
    expect(other.buildAppUrl()).toBe('http://dash.link.testing');
    expect(other.buildApiUrl('/v1/links')).toBe('http://svc.link.testing/v1/links');
  });

  it('rejects the custom appSubdomain/apiSubdomain labels as handles', () => {
    expect(() => other.buildBioUrl('dash')).toThrow();
    expect(() => other.buildBioUrl('svc')).toThrow();
  });

  it('parses the custom reserved subdomains as absent', () => {
    expect(other.parseHandleFromHost('dash.link.testing')).toBeUndefined();
    expect(other.parseHandleFromHost('svc.link.testing')).toBeUndefined();
    expect(other.parseHandleFromHost('juano.link.testing')).toBe('juano');
  });
});
