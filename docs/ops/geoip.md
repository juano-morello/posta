# GeoIP data — DB-IP lite

Posta's ASN/country lookups run against DB-IP's free "lite" databases,
fetched by `scripts/fetch-geoip.sh` (`pnpm geo:fetch`) and baked into the
**api** container image at build time (T0.7.10) — never the worker or web
images. Invariant 6: geo/ASN lookup happens exactly once, in the API, at
the instant of capture, before the raw IP is dropped. A worker holding geo
data would imply an IP survived long enough to reach it, which invariant 6
forbids outright — its absence from that image is deliberate, not an
oversight.

Two files are required, not one — the ASN database carries no country
data and vice versa:

- `dbip-asn-lite.mmdb` — which network owns an IP (classification rule 6)
- `dbip-country-lite.mmdb` — country, when Cloudflare's `CF-IPCountry`
  header is absent

## Refresh cadence

DB-IP publishes a new release of both files every calendar month, landing
**mid-month** — the first couple of weeks of a new month can still 404 on
that month's own file. `scripts/fetch-geoip.sh` tries the current
year-month first and automatically falls back to the previous month rather
than hard-failing on that date edge.

There is no scheduled/automated re-fetch job yet: the api image is rebuilt
on every push to main (T0.7.14), which re-runs `fetch-geoip.sh` inside the
Docker build and therefore re-pulls whatever DB-IP's latest release is at
that moment. Revisit this note if the deploy cadence ever gets slow enough
that "last month's data" becomes stale in practice.

## Attribution (CC BY 4.0) — do not ship without this

DB-IP's lite databases are licensed **CC BY 4.0**, not MaxMind's
non-redistributable GeoLite2 EULA — that licence difference is the entire
reason these files can be baked *inside* a container image at all instead
of requiring an init container or a licence Secret (see `CLAUDE.md`'s
decision log). CC BY 4.0 requires attribution wherever the data is used in
a public-facing product. The bio-page footer (E8) must carry this line:

> IP geolocation by DB-IP (<https://db-ip.com>), licensed under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Dropping the line is a licence violation, not just a missing credit —
treat it the same as any other legal requirement when building E8.
