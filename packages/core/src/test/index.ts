// Barrel for packages/core's TEST-ONLY utilities, exposed via the
// dedicated `@posta/core/testing` subpath (see package.json's `exports`)
// — deliberately NOT re-exported from the main `.` entry point
// (src/index.ts), so apps/api and apps/worker's PRODUCTION code never
// pulls in testcontainers (a heavy, test-only dependency: dockerode,
// ssh2, protobufjs, ...) through the ordinary package import. T1.1.2's
// own doc comment says this harness is meant for "every integration test
// in E1-E4" to reuse — this subpath is what makes that true for OTHER
// packages'/apps' test files, not just packages/core's own.
export * from './pg-container';
