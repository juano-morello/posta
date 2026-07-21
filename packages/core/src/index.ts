// packages/core only ever runs server-side: it holds the Drizzle schema,
// database clients, and R2 credentials, and must never reach a browser
// bundle. The boundary is enforced by the no-illegal-core-import
// dependency-cruiser rule (.dependency-cruiser.js), which catches both
// static and dynamic imports at build time.
export {};
