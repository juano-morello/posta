/**
 * dependency-cruiser config for the Posta monorepo (S0.2).
 *
 * Scope of the default `pnpm depcruise` run: source only, under each app's
 * and package's own `src` folder. Build output (dist/, .next/, .turbo/) and
 * node_modules are excluded — cruising compiled output would double-count
 * every edge (once in src, once in the emitted JS) and cruising
 * node_modules risks pulling in the entire dependency tree of every
 * third-party package.
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
 * The `forbidden` rules below (T0.2.3) encode the allowed arrows from
 * CLAUDE.md: web→contracts · api→core,contracts · worker→core,contracts ·
 * core→contracts. No app imports another app. Everything not on that list
 * is forbidden. Each rule's `to.path` matches both forms a workspace
 * package can show up as in the graph: the collapsed node name it gets
 * once actually resolved (e.g. `packages/core`), and the bare
 * `@posta/<name>` specifier dependency-cruiser records when it *can't*
 * resolve the import — which is exactly what happens for an illegal edge
 * nobody has added to a package.json yet (see the web-imports-core
 * fixture in T0.2.4). Matching only the resolved form would let that
 * exact scenario slip through the net the story is supposed to build.
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
      from: { path: '^apps/web$' },
      to: { path: '^(apps/(api|worker)$|@posta/(api|worker)($|/))' },
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
      from: { path: '^apps/api$' },
      to: { path: '^(apps/(web|worker)$|@posta/(web|worker)($|/))' },
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
      from: { path: '^apps/worker$' },
      to: { path: '^(apps/(web|api)$|@posta/(web|api)($|/))' },
    },
    {
      name: 'no-illegal-core-import',
      severity: 'error',
      comment:
        'packages/core holds the Drizzle schema, the Postgres/R2 clients, ' +
        'enrichment and classification — server-only code (see the ' +
        'server-only guard added in T0.2.6) that must never reach a browser ' +
        'bundle. Only api and worker (real Node processes) may import it; ' +
        'core importing core is how its own barrel file re-exports ' +
        'internally. If you landed on this rule from apps/web, that is ' +
        'invariant-breaking by design — read the dependency-arrow block in ' +
        'CLAUDE.md before adding the import anyway.',
      from: { pathNot: '^(packages/core|apps/api|apps/worker)$' },
      to: { path: '^(packages/core$|@posta/core($|/))' },
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
      from: { path: '^packages/contracts$' },
      to: {
        path: '^(packages/core$|apps/(api|worker|web)$|@posta/(core|api|worker|web)($|/))',
      },
    },
  ],
  options: {
    exclude: {
      path: '(^|/)(node_modules|dist|\\.next|\\.turbo)/',
    },
    includeOnly: {
      path: '^(apps|packages)/[^/]+/src',
    },
    collapse: '^(apps|packages)/[^/]+',
  },
};
