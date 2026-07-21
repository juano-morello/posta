/**
 * dependency-cruiser config for the Posta monorepo (S0.2).
 *
 * Scope of the default `pnpm depcruise` run: each app's and package's own
 * folder (src *and* dist — see the `includeOnly`/`exclude` comments below
 * for why dist has to stay visible). `.next`/`.turbo`/`node_modules` are
 * excluded — cruising `.next` once OOM'd this process (Next's build output
 * is thousands of internal chunks) and cruising `node_modules` would pull
 * in the entire dependency tree of every third-party package.
 *
 * `collapse` folds every file under a given apps/<name> or packages/<name>
 * folder into a single node, so the graph — and `pnpm depcruise`'s module
 * count — tracks the five real workspace packages (contracts, core, api,
 * worker, web) rather than their individual source files. This is also
 * what makes a `--output-type dot|mermaid` render a readable diagram
 * later: five boxes, not dozens.
 *
 * `tests/boundaries/` is intentionally outside these entry points. The
 * boundary tests (T0.2.4) point a *separate* depcruise invocation directly
 * at their fixtures, so a deliberately-illegal import there never fails
 * this default run — see tests/boundaries/arrows.test.ts.
 *
 * The `forbidden` rules below (T0.2.3, hardened in a same-day follow-up
 * fix) encode the allowed arrows from CLAUDE.md: web→contracts ·
 * api→core,contracts · worker→core,contracts · core→contracts. No app
 * imports another app. Everything not on that list is forbidden.
 *
 * Every `from`/`to` path uses `(/|$)` rather than a bare `$`, e.g.
 * `^apps/web(/|$)` not `^apps/web$`. Rule matching happens against each
 * edge's *real* path — `apps/web/src/app/page.tsx`, or a resolved target
 * like `packages/core/dist/index.js` — not the collapsed display name;
 * collapse only happens for reporting. A bare `$` anchor only ever matches
 * the collapsed name, which means it silently matches nothing during rule
 * evaluation: an original version of this file used exact `$` anchors
 * everywhere and every rule below was consequently a no-op for every real,
 * resolved import (it only ever caught the narrower case of an import
 * nobody had added to a package.json yet, where the unresolved specifier
 * happens to equal the bare package name). Each rule's `to.path` still
 * also matches the bare `@posta/<name>` specifier dependency-cruiser
 * records when it *can't* resolve the import at all — both forms have to
 * stay covered, or one of the two ways an illegal edge shows up in this
 * repo (nobody added the dependency yet vs. somebody actually added it
 * and imported it) goes undetected.
 */
export default {
  forbidden: [
    {
      name: 'no-web-to-other-apps',
      severity: 'error',
      comment:
        'web is the one frontend surface (invariant 11): it renders both the ' +
        'dashboard and the public bio pages, and reads bio data from the API ' +
        'over HTTP — that is a network call, not an import. If you are here ' +
        'because you wanted a type from api or worker, put that type in ' +
        'packages/contracts instead; that is the only thing web may import ' +
        'besides node_modules.',
      from: { path: '^apps/web(/|$)' },
      to: { path: '^(apps/(api|worker)(/|$)|@posta/(api|worker)($|/))' },
    },
    {
      name: 'no-api-to-other-apps',
      severity: 'error',
      comment:
        'api and worker are separate deployables (the worker is a distinct ' +
        'BullMQ consumer process, per the apps/worker description in ' +
        'CLAUDE.md) and web is a separate Next.js app. No app imports ' +
        'another app; share code through packages/core or ' +
        'packages/contracts instead.',
      from: { path: '^apps/api(/|$)' },
      to: { path: '^(apps/(web|worker)(/|$)|@posta/(web|worker)($|/))' },
    },
    {
      name: 'no-worker-to-other-apps',
      severity: 'error',
      comment:
        'Same rule as no-api-to-other-apps, mirrored for worker: the worker ' +
        'drains Redis and writes events, api serves redirects and CRUD, web ' +
        'renders pages. None of the three apps may reach into another app ' +
        'src directory — share code through packages/core or ' +
        'packages/contracts instead.',
      from: { path: '^apps/worker(/|$)' },
      to: { path: '^(apps/(web|api)(/|$)|@posta/(web|api)($|/))' },
    },
    {
      name: 'no-illegal-core-import',
      severity: 'error',
      comment:
        'packages/core holds the Drizzle schema, the Postgres/R2 clients, ' +
        'enrichment and classification — server-only code that must never ' +
        'reach a browser bundle. This rule is the *only* guard for that: an ' +
        'earlier version also added the npm `server-only` package to ' +
        "core's entry point, but that package's non-react-server export is " +
        'an unconditional throw, and plain Node (api, worker) never sets ' +
        'the react-server condition — it crashed both services the moment ' +
        'either genuinely imported core, so it was removed. This rule ' +
        'catches static *and* dynamic imports, so there is no gap left for ' +
        'a runtime check to cover. Only api and worker (real Node ' +
        'processes) may import core; core importing core is how its own ' +
        'barrel file re-exports internally. If you landed on this rule ' +
        'from apps/web, that is invariant-breaking by design — read the ' +
        'dependency-arrow block in CLAUDE.md before adding the import ' +
        'anyway.',
      from: { pathNot: '^(packages/core|apps/api|apps/worker)(/|$)' },
      to: { path: '^(packages/core(/|$)|@posta/core($|/))' },
    },
    {
      name: 'no-contracts-importing-server-code',
      severity: 'error',
      comment:
        'contracts is the isomorphic web<->api seam: pure Zod types, zero ' +
        'server deps (T0.2.5 asserts this at the package.json level too). ' +
        'If contracts imports core or any app, that pulls server-only or ' +
        'app-specific code into a package web statically imports, which ' +
        'defeats the entire point of having an isomorphic contracts package.',
      from: { path: '^packages/contracts(/|$)' },
      to: {
        path: '^(packages/core(/|$)|apps/(api|worker|web)(/|$)|@posta/(core|api|worker|web)($|/))',
      },
    },
  ],
  options: {
    // `.next` and `node_modules` are excluded entirely: `.next` is
    // Next.js's own webpack/Turbopack build output (thousands of internal
    // chunks — cruising it is what caused an out-of-memory crash before
    // this exclude existed), and `node_modules` would pull in every
    // third-party package's own dependency tree.
    //
    // `dist` is deliberately NOT excluded, even though it is build
    // output: a real (not just unresolved) illegal import resolves
    // through a package's `main` field, i.e. into its `dist/*.js` — api
    // and worker's `@posta/core` dependency resolves the same way. `dist`
    // files never get scanned as separate *entry points* (the CLI is only
    // ever pointed at `apps packages`, i.e. it discovers files by walking
    // from each package's real source — `dist` is generated, so nothing
    // outside that walk imports it as a starting point), so it is never
    // double-counted; it only ever shows up as the *destination* half of
    // an edge, which is exactly where a rule needs to be able to see it.
    exclude: {
      path: '(^|/)(node_modules|\\.next|\\.turbo)/',
    },
    // Scoped to each package's own folder (src *and* dist) rather than
    // just its src, and deliberately not any narrower: a resolved
    // dependency's target has to stay inside this filter or the edge
    // vanishes from the graph before any rule gets a chance to see it —
    // which is exactly the bug an earlier, `.../src`-only version of this
    // filter had. Scoped this way, `pnpm depcruise`'s module count still
    // comes out at five (via collapse below), since collapse folds src
    // and dist under the same package into one node either way.
    includeOnly: {
      path: '^(apps|packages)/[^/]+/',
    },
    // Folds every file under a given apps/<name> or packages/<name>
    // folder — src or dist — into a single node, so the graph (and
    // `pnpm depcruise`'s module count) tracks the five real workspace
    // packages rather than their individual files.
    collapse: '^(apps|packages)/[^/]+',
  },
};
