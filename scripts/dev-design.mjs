#!/usr/bin/env node
// pnpm dev:design [--reset-designer-password] — designer mode (capability designer-mode,
// spec/architecture.md §11): the whole app on embedded PGlite with nothing installed beyond
// Node + pnpm, no Postgres, no .env required.
//
//   1. engine: always PGlite — BLOG0_DATABASE_URL from the shell if it is pglite://<dir>, else
//      pglite://./var/pglite (a postgres:// URL in .env is ignored here; use `pnpm dev` for that)
//   2. .env (optional) fills every other unset variable; set one to empty in the shell to blank it,
//      e.g. `BLOG0_OPENROUTER_API_KEY= pnpm dev:design` (an empty value counts as absent)
//   3. migrate → seed site + designer admin (password printed once, kept in var/designer-admin.txt)
//      → seed the 5 posts → seed decks (fixture when no key) → close PGlite
//   4. start the hot-reload dev server (`scripts/serve.mjs dev`) on BLOG0_PORT (default 3410)
// Idempotent; start over with: rm -rf var/pglite var/designer-admin.txt var/pglite-session-secret
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import nextEnv from '@next/env';

const DEFAULT_URL = 'pglite://./var/pglite';
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--reset-designer-password');
if (unknown.length > 0) {
  console.error(`dev:design: unknown argument(s): ${unknown.join(' ')} (only --reset-designer-password is accepted)`);
  process.exit(2);
}
const resetDesignerPassword = args.includes('--reset-designer-password');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// 1. Pin the engine BEFORE .env is read (@next/env never overrides a variable that is already set).
const shellUrl = (process.env.BLOG0_DATABASE_URL ?? '').trim();
if (/^pglite:\/\//i.test(shellUrl)) {
  process.env.BLOG0_DATABASE_URL = shellUrl;
} else {
  if (shellUrl !== '') console.log('dev:design always runs on embedded PGlite — ignoring the postgres BLOG0_DATABASE_URL (use `pnpm dev` for Postgres).');
  process.env.BLOG0_DATABASE_URL = DEFAULT_URL;
}

// 2. Optional .env for everything else (OpenRouter key, admin, port …).
nextEnv.loadEnvConfig(root, true, { info: () => {}, error: console.error });

const rawPort = (process.env.BLOG0_PORT ?? '').replace(/\s+#.*$/, '').trim();
const port = rawPort === '' ? '3410' : rawPort;
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`BLOG0_PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
  process.exit(2);
}
process.env.BLOG0_PORT = port;
if ((process.env.BLOG0_PUBLIC_BASE_URL ?? '').trim() === '') process.env.BLOG0_PUBLIC_BASE_URL = `http://localhost:${port}`;

console.log(`dev:design: embedded PGlite at ${process.env.BLOG0_DATABASE_URL.slice('pglite://'.length)} — nothing else to install.`);

// 3. Migrate + seed in this process (TypeScript via tsx), then close PGlite.
const require = createRequire(import.meta.url);
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
try {
  await tsImport('./lib/allow-server-only.ts', import.meta.url);
  const { runDesignerSetup } = await tsImport('../src/server/designer/setup.ts', import.meta.url);
  await runDesignerSetup({ resetDesignerPassword });
} catch (error) {
  console.error(`dev:design failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// 4. The hot-reload dev server (the same working command as `pnpm dev`).
console.log(`dev:design: starting the dev server → http://localhost:${port}  (admin: /admin/login)`);
const child = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs'), 'dev'], { stdio: 'inherit', env: process.env });

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
