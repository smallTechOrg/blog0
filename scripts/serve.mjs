#!/usr/bin/env node
// Loads .env via @next/env, then runs `next <dev|start> -p ${BLOG0_PORT || 3410}` and forwards signals.
// On the first SIGTERM/SIGINT it also arms a kill timer of BLOG0_SHUTDOWN_TIMEOUT_MS (default 8000)
// + 5000 ms: a server that has not exited by then is SIGKILLed and this script exits 1 (§12.2).
// Usage (from the repo root): pnpm dev | pnpm start   (designer mode: pnpm dev:design, which ends here)
// `start` refuses an absent/empty BLOG0_DATABASE_URL (no silent PGlite in production).
// BLOG0_DIST_DIR (shell or .env) reaches next.config.ts `distDir` through the inherited env, so
// `BLOG0_DIST_DIR=.next-gate pnpm start` serves the build made by `BLOG0_DIST_DIR=.next-gate pnpm build`.
// `pnpm dev` is the hot-reload server (Turbopack). Open it as http://localhost:<port>; 127.0.0.1 and
// this machine's LAN addresses are allowed by next.config.ts `allowedDevOrigins` (without that, the
// HMR socket was refused and the page fully reloaded every ~40 s — the old "reload loop").
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
  if (mode === 'start') {
    // Production never defaults to the embedded database (src/server/config.ts enforces the same rule
    // for a bare `next start`); fail here, before Next.js boots, with the same message.
    console.error(
      'blog0 cannot start: BLOG0_DATABASE_URL is required in production; set postgres://… or explicitly pglite://… to opt in',
    );
    process.exit(1);
  }
  console.log('BLOG0_DATABASE_URL not set — using embedded PGlite at ./var/pglite (run `pnpm dev:design` once to migrate + seed it).');
}

// Same rule as src/server/config.ts; an invalid value falls back here (the server itself refuses to boot).
const rawShutdown = (process.env.BLOG0_SHUTDOWN_TIMEOUT_MS ?? '').replace(/\s+#.*$/, '').trim();
const shutdownTimeoutMs =
  /^\d+$/.test(rawShutdown) && Number(rawShutdown) >= 1000 && Number(rawShutdown) <= 120000 ? Number(rawShutdown) : 8000;
const KILL_GRACE_MS = 5000;

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, mode, '-p', port], { stdio: 'inherit', env: process.env });

let killTimer = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    if (killTimer === null && signal !== 'SIGHUP') {
      const limit = shutdownTimeoutMs + KILL_GRACE_MS;
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        console.error(`blog0: server did not exit within ${limit} ms — killed`);
        process.exit(1);
      }, limit);
    }
  });
}

child.on('exit', (code, signal) => {
  if (killTimer !== null) clearTimeout(killTimer);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
