// Deliberately illegal: apps/web must only ever import @posta/contracts
// (invariant 11 / the dependency-arrow block in CLAUDE.md). This file
// stands in for "some file inside apps/web" — the no-illegal-core-import
// rule it triggers doesn't actually check the fixture's own location
// (see the rule's `from.pathNot` in .dependency-cruiser.js), it checks
// that only packages/core, apps/api, and apps/worker may import core, so
// this fixture proves the violation regardless of which non-allowed
// location it sits in. It exists solely as input to the depcruise
// invocation in arrows.test.ts, which asserts that dependency-cruiser's
// `no-illegal-core-import` rule (see .dependency-cruiser.js) catches
// exactly this shape of violation.
//
// This file is NOT part of the normal build: it is excluded from
// `pnpm lint`, `pnpm typecheck`, `pnpm build`, and the default
// `pnpm depcruise` run (see the includeOnly scope in .dependency-cruiser.js
// and the ignore entry in eslint.config.js). Never import this file from
// real source — it only needs to exist on disk for depcruise to parse.
import { core } from '@posta/core';

export { core };
