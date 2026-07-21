import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // TypeScript 7.0 ships the `tsc` executable only — the programmatic
  // compiler API Next's build-time type-checking step needs returns in 7.1
  // (see apps/api and apps/worker, which hit the same gap via `nest build`).
  // Type safety is still enforced: `pnpm typecheck` (T0.1.11) runs `tsc`
  // directly against every package, `next build` just skips its own
  // redundant, currently-broken pass.
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
