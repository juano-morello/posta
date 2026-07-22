import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // T0.7.6 — self-contained runtime output for the Docker image. Without
  // this the runtime stage would need the full workspace `node_modules`
  // (every workspace package's prod deps, hoisted) to run `next start`;
  // standalone traces exactly what this app's server needs and copies it
  // into `.next/standalone`, which is several hundred MB lighter.
  output: 'standalone',
};

export default nextConfig;
