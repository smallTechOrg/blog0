#!/usr/bin/env node
// Loads .env via @next/env, then runs `next <dev|start> -p ${BLOG0_PORT || 3410}` and forwards signals.
// Usage (from the repo root): pnpm dev | pnpm start   (designer mode: pnpm dev:design, which ends here)
// `pnpm dev` is the hot-reload server (Turbopack). Open it as http://localhost:<port>; 127.0.0.1 and
// this machine's LAN addresses are allowed by next.config.ts `allowedDevOrigins` (without that, the
// HMR socket was refused and the page fully reloaded every ~40 s — the Phase 1 "reload loop").
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

import nextEnv from '@next/env';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: node scripts/serve.mjs <dev|start>');
  process.exit(2);
}

nextEnv.loadEnvConfig(process.cwd(), mode === 'dev', { info: () => {}, error: console.error });

const rawPort = (process.env.BLOG0_PORT ?? '').replace(/\s+#.*$/, '').trim();
const port = rawPort === '' ? '3410' : rawPort;
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`BLOG0_PORT must be an integer between 1 and 65535 (got "${rawPort}") — fix it in .env`);
  process.exit(2);
}

if ((process.env.BLOG0_DATABASE_URL ?? '').replace(/\s+#.*$/, '').trim() === '') {
  console.log('BLOG0_DATABASE_URL not set — using embedded PGlite at ./var/pglite (run `pnpm dev:design` once to migrate + seed it).');
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, mode, '-p', port], { stdio: 'inherit', env: process.env });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
