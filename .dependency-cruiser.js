'use strict';

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
 * No `forbidden` rules yet (T0.2.2 only proves the tool runs over the
 * graph); the arrow rules land in T0.2.3.
 */
module.exports = {
  forbidden: [],
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
