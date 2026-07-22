import { z } from 'zod';
import { zNonEmpty, zPort, zUrl } from '@posta/contracts';

// T0.3.7 — web's Zod env schema (S0.3). web is the one frontend surface
// (invariant 11): it renders both the dashboard and the public bio
// pages, and reads bio data from the API over HTTP rather than touching
// Postgres directly — so it needs none of the DB/Redis/R2 vars, and no
// auth secret (Better Auth's server-side secret belongs to the API,
// which owns auth).
//
// Split in two, matching how Next.js itself splits env:
//   - webServerEnvSchema: server-only vars, never sent to the browser.
//     WEB_PORT/NODE_ENV to run the server, REVALIDATE_SECRET to verify
//     the API's on-demand ISR webhook (S8.6), and the domain vars
//     makeUrlBuilders() needs to build bio/app URLs.
//   - webPublicEnvSchema: NEXT_PUBLIC_ vars, inlined into the browser
//     bundle at build time — just NEXT_PUBLIC_API_URL, the one thing the
//     client needs to know to call the API directly.
//
// The security assertion this split exists for lives in env.test.ts, not
// here: it is a test over webPublicEnvSchema's declared keys, checked
// against SECRET_ENV_KEYS (contracts) and a SECRET/PASSWORD/KEY/TOKEN
// name pattern, so a future NEXT_PUBLIC_BETTER_AUTH_SECRET fails loudly
// instead of silently shipping to every visitor's browser.

export const webServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  WEB_PORT: zPort,

  // The API → Next on-demand revalidation webhook secret (S8.6), fired
  // on bio save. Server-only: never exposed under NEXT_PUBLIC_.
  REVALIDATE_SECRET: zNonEmpty,

  // Everything makeUrlBuilders() needs to build bio/app URLs. NOT
  // POSTA_RESERVED_HANDLES — web falls back to contracts' frozen
  // RESERVED_HANDLES default for client-side handle validation (see
  // packages/contracts/src/reserved.ts) rather than needing its own
  // override.
  POSTA_LINK_DOMAIN: zNonEmpty,
  POSTA_PROTOCOL: z.enum(['http', 'https']),
  POSTA_APP_SUBDOMAIN: zNonEmpty,
  POSTA_API_SUBDOMAIN: zNonEmpty,
});

export const webPublicEnvSchema = z.object({
  // Browser-exposed. Must be a public URL — never put a secret behind
  // NEXT_PUBLIC_ (.env.example, and see the security test in
  // env.test.ts, which enforces this rather than relying on review).
  NEXT_PUBLIC_API_URL: zUrl,
});

export type WebServerEnv = z.infer<typeof webServerEnvSchema>;
export type WebPublicEnv = z.infer<typeof webPublicEnvSchema>;
