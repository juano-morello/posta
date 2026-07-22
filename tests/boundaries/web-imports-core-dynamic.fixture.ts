// Deliberately illegal, dynamic-import variant of web-imports-core.fixture.ts
// (see that file for the general shape this stands in for). This one
// exists to prove the no-illegal-core-import rule catches a *dynamic*
// import, not just a static one — and specifically a dynamic import that
// actually *resolves*, which static analysis alone can miss if a rule's
// path patterns only account for an unresolved specifier.
//
// It uses a relative import (`../../packages/core/src/index.ts`) rather
// than the `@posta/core` specifier the static fixture uses. That is
// deliberate: nothing under tests/boundaries/ has @posta/core as a real
// dependency, so a bare-specifier import from here can only ever be
// unresolved — which would exercise the same code path
// web-imports-core.fixture.ts already covers. A relative import needs no
// package.json entry to resolve, so it genuinely resolves to
// packages/core's real source, exercising the *other* shape a real
// violation takes: someone has actually reached core, not just typed its
// package name. Both shapes have to be caught, since dependency-cruiser
// records them differently (an unresolved specifier vs. a real path) and
// a rule can pass one while silently missing the other — see
// .dependency-cruiser.js's top comment for the incident where that
// happened here.
export async function loadCoreDynamically() {
  const core = await import('../../packages/core/src/index.ts');
  return core;
}
