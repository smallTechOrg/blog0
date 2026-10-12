import { networkInterfaces } from 'node:os';

import type { NextConfig } from 'next';

/**
 * Hosts allowed to use the dev server's HMR socket and dev assets besides `localhost`.
 *
 * Next 16 blocks cross-origin requests to dev-only resources (`/_next/hmr` …) from any host other
 * than `localhost`. Opening the dev server as http://127.0.0.1:3410 or from the LAN address
 * (both printed by `next dev`) made the HMR websocket fail, so edits never hot-updated and the
 * client fell back to a full page reload every ~40 s — the "pnpm dev reload loop" from Phase 1.
 * Allow the loopback addresses, this machine's own LAN addresses and the BLOG0_PUBLIC_BASE_URL host.
 */
function devOrigins(): string[] {
  const hosts = new Set<string>(['127.0.0.1', '::1', '[::1]']);
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) if (nic.family === 'IPv4') hosts.add(nic.address);
  }
  try {
    const base = (process.env.BLOG0_PUBLIC_BASE_URL ?? '').trim();
    if (base !== '') hosts.add(new URL(base).hostname);
  } catch {
    // an invalid base URL is reported by the app's config check at boot
  }
  hosts.delete('localhost'); // always allowed
  return [...hosts];
}

/**
 * Static, env-independent security headers on every response (spec/architecture.md §6). The
 * per-request CSP (nonce) and HSTS come from src/proxy.ts in production only.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()' },
];

const nextConfig: NextConfig = {
  // Standalone output only for the container image build (Dockerfile sets BLOG0_STANDALONE=1,
  // spec/architecture.md §12.1): the local `pnpm start` runs `next start`, which warns under it.
  output: process.env.BLOG0_STANDALONE === '1' ? 'standalone' : undefined,
  // BLOG0_DIST_DIR: a separate build directory (e.g. `.next-gate`) so a gate/CI `pnpm build` never
  // overwrites the `.next` a running `pnpm start` is serving. `pnpm start` must use the same value.
  distDir: (process.env.BLOG0_DIST_DIR ?? '').trim() || '.next',
  // Loaded from node_modules at runtime, never bundled: native binaries (argon2), large grammars
  // (shiki), the postgres driver, and PGlite (a WASM binary + data files read from its package dir).
  serverExternalPackages: ['@node-rs/argon2', 'shiki', 'postgres', '@electric-sql/pglite'],
  allowedDevOrigins: devOrigins(),
  experimental: {
    // `next dev` restoring Turbopack's on-disk cache (.next/dev/cache/turbopack) after source edits
    // made by another process (an editor, `next build`, a parallel tool) twice left the server
    // answering every page load with a chunk-list "restart" + "HMR hash mismatch" → the page reloaded
    // ~10×/s until the dev server was restarted. A cold dev cache costs a few seconds per start and
    // removes that state; production builds keep their cache.
    turbopackFileSystemCacheForDev: false,
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  poweredByHeader: false,
  typedRoutes: false,
};

export default nextConfig;
