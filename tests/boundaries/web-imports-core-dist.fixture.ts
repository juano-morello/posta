// Deliberately illegal, dist-resolved variant of web-imports-core.fixture.ts
// (see that file for the general shape this stands in for). This one
// exists to guard the actual root cause behind the "1 modules, 0
// dependencies cruised" silent no-op this repo hit once: `apps/web`
// genuinely gaining `@posta/core` as a dependency and importing it for
// real resolves through `packages/core`'s `main` field, i.e. into
// `packages/core/dist/index.js` — not `src/index.ts`. The other two
// fixtures in this directory (the unresolved static one, and the
// relative-src dynamic one) both happen to resolve into `src/`, which
// was *already* inside the old, buggy `includeOnly: '.../src'` scope —
// so neither of them would have caught that includeOnly regressing back
// to `src`-only, even though that is exactly what silently dropped the
// resolved edge from the graph before any rule got to see it. This
// fixture's relative import into `dist/` is what actually exercises that
// scope, the same way the original manual repro did.
//
// `dist/` is gitignored and this repo's `test` task has no build
// dependency, so the file this imports may not exist yet when this test
// runs cold — see the `beforeAll` in arrows.test.ts, which builds
// packages/core before either dist-dependent assertion runs.
import '../../packages/core/dist/index.js';

export {};
