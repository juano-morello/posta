// packages/core holds the Drizzle schema, database clients, and R2
// credentials — it must never reach a browser bundle (see the
// no-illegal-core-import rule in .dependency-cruiser.js, which catches
// this at the source-import level; this catches it at the bundler level
// as a second, independent line of defense for anything that slips past
// dependency-cruiser, e.g. a dynamic import dependency-cruiser cannot
// statically resolve).
//
// `server-only` resolves to a no-op under the `react-server` export
// condition (Next's server-components graph) and to a module that throws
// under any other condition (a client bundle). tsc, which is what
// actually builds this package, never evaluates module code — it only
// needs the import to resolve, which it does via server-only's plain
// `main` entry — so this import is inert for api/worker (real Node
// processes) and for `pnpm --filter @posta/core build` alike. It only
// bites when a bundler compiles this package into a browser bundle.
import 'server-only';

export {};
