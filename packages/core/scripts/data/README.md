# Datacenter ASN list

`datacenter-asns.json` seeds the `asn_datacenter` table (T1.4.1) — the
classification view (E4) joins this table to flag traffic from cloud,
hosting, and colo networks, instead of hardcoding a list of ASNs into the
view itself. Adding an ASN is an INSERT, not a migration against a live
partitioned `events` table.

## Where the list came from

The bulk of the dataset is transformed from
[brianhama/bad-asn-list](https://github.com/brianhama/bad-asn-list) (MIT
license) — "ASNs known to belong to cloud, managed hosting, and colo
facilities." A supplemental set of major providers that list omits or
names ambiguously (Cloudflare, Oracle Cloud, Akamai, plus clearer names
for AWS/GCP/Azure/DigitalOcean/Hetzner/OVH/Linode/Vultr/Scaleway/Contabo)
is added from public ASN registration records (bgp.he.net / PeeringDB).

The exact source URL and the date it was last pulled are recorded in the
JSON file's own `provenance` header — open `datacenter-asns.json` and read
`provenance.upstreamSource` / `provenance.pulledAt` for the values current
right now, rather than trusting this doc to stay in sync with them.

## Why this is committed, not fetched at runtime

A runtime fetch (worker/API calling out to GitHub or an ASN API on a
schedule) was rejected: a classification input that changes silently
would invalidate E4's golden corpus without a diff. Committing the JSON
means every change to it is a reviewable pull request, same as any other
code change.

## Refreshing the list

```
packages/core/scripts/vendor-asn.sh
```

(also `pnpm --filter @posta/core vendor:asn`). Downloads the upstream CSV
fresh, re-runs the transform (`vendor-asn.ts`), and overwrites
`datacenter-asns.json` with a new `provenance.pulledAt`. Review the diff
like any other change before committing it — a provider renaming or
retiring an ASN should show up as a readable diff, not a silent
replacement.

To add or edit one of the manually-curated entries (Cloudflare, Oracle,
etc.), edit the `SUPPLEMENTAL_ENTRIES` array in `vendor-asn.ts` and
re-run the script above — supplemental entries always win over the
upstream CSV for the same ASN.

## Applying the list to a database

```
pnpm --filter @posta/core seed:asn
```

Reads `datacenter-asns.json` and issues one multi-row
`INSERT ... ON CONFLICT (asn) DO UPDATE SET name = EXCLUDED.name` against
`asn_datacenter`. Safe to run on every deploy: re-running after editing a
name updates it in place, never duplicates a row, and never resets
`added_at` (`added_at` is only set on first insert).

## Adding a single ASN in production, without a deploy

This is the whole reason `asn_datacenter` is a table instead of a
hardcoded list in the view: a newly-observed hosting ASN can be added
with one statement, immediately, no deploy required —

```sql
INSERT INTO asn_datacenter (asn, name) VALUES (12345, 'Some New Hosting Provider, Inc.')
ON CONFLICT (asn) DO UPDATE SET name = EXCLUDED.name;
```

Also add the same row to `datacenter-asns.json` (via a small pull request)
so the next `pnpm seed:asn` run doesn't disagree with what production
already has — the hotfix above is for the immediate gap, not a
replacement for keeping the vendored file itself current.
