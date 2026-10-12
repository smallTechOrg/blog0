import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@node-rs/argon2', 'shiki', 'postgres'],
  poweredByHeader: false,
  typedRoutes: false,
};

export default nextConfig;
