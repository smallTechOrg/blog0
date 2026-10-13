#!/usr/bin/env node
// pnpm dev:design [--reset-designer-password] — designer mode (capability designer-mode,
// spec/architecture.md §11): the whole app on embedded PGlite with nothing installed beyond
// Node + pnpm, no Postgres, no .env required.
//
//   1. engine: always PGlite — BLOG0_DATABASE_URL from the shell if it is pglite://<dir>, else
//      pglite://./var/pglite (a postgres:// URL in .env is ignored here; use `pnpm dev` for that)
//   2. .env (optional) fills every other unset variable; set one to empty in the shell to blank it,
//      e.g. `BLOG0_OPENROUTER_API_KEY= pnpm dev:design` (an empty value counts as absent)
//   3. refuse early (before touching the database) when the port is taken — usually a second
//      dev:design on the same data dir, which must never open it twice
//   4. migrate → seed site + designer admin (kept in var/designer-admin.txt) → seed the 5 posts →
//      seed decks (fixture when no key) → seed the sample recording → close PGlite. Progress lines
//      only: the app's JSON info logs are held back to `warn` during setup unless BLOG0_LOG_LEVEL is set
//   5. start the hot-reload dev server (`scripts/serve.mjs dev`) on BLOG0_PORT (default 3410), wait
//      until it answers and the home page is compiled, then print the banner: URL, admin login (the
//      password only when it was just generated — printed once), where to edit, how to start over
// Idempotent; start over with: rm -rf var/pglite var/storage var/pglite-session-secret var/designer-admin.txt
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
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

const t0 = Date.now();
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// 3. A taken port fails here, before the database is opened (a second dev:design on the same
//    PGlite dir would corrupt it).
const portFree = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', (error) => resolve(error.code !== 'EADDRINUSE'));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(Number(port));
});
if (!portFree) {
  console.error(
    `dev:design: port ${port} is already in use — is blog0 already running in another terminal? Stop it (Ctrl+C there), ` +
      `or pick another port: BLOG0_PORT=${Number(port) + 10} pnpm dev:design`,
  );
  process.exit(1);
}

console.log(`dev:design: embedded PGlite at ${process.env.BLOG0_DATABASE_URL.slice('pglite://'.length)} — nothing else to install.`);
console.log('dev:design: preparing the database (a few seconds) …');

// 4. Migrate + seed in this process (TypeScript via tsx), then close PGlite. The app's JSON info
//    logs (one per seeded deck/recording) are held back so the progress lines stay readable.
const userLogLevel = process.env.BLOG0_LOG_LEVEL;
if ((userLogLevel ?? '').trim() === '') process.env.BLOG0_LOG_LEVEL = 'warn';
const require = createRequire(import.meta.url);
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
let setup;
try {
  await tsImport('./lib/allow-server-only.ts', import.meta.url);
  const { runDesignerSetup } = await tsImport('../src/server/designer/setup.ts', import.meta.url);
  setup = await runDesignerSetup({ resetDesignerPassword });
} catch (error) {
  console.error(`dev:design failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('If the data dir is damaged, start over (deletes local designer data): rm -rf var/pglite var/storage var/pglite-session-secret var/designer-admin.txt');
  process.exit(1);
}
if (userLogLevel === undefined) delete process.env.BLOG0_LOG_LEVEL;
else process.env.BLOG0_LOG_LEVEL = userLogLevel;
const setupMs = Date.now() - t0;
console.log(`dev:design: database ready in ${seconds(setupMs)} — starting the dev server on port ${port} …`);

// 5. The hot-reload dev server (the same working command as `pnpm dev`).
const child = spawn(process.execPath, [path.join(root, 'scripts', 'serve.mjs'), 'dev'], { stdio: 'inherit', env: process.env });
void announceWhenReady();

/** What `start over` deletes for THIS run's dirs (the defaults: var/pglite var/storage …). */
function startOverPaths(adminFile) {
  const rel = (p) => path.relative(root, path.resolve(root, p)) || '.';
  const dataDir = process.env.BLOG0_DATABASE_URL.slice('pglite://'.length);
  const storageDir = (process.env.BLOG0_STORAGE_DIR ?? '').trim() || 'var/storage';
  const paths = [rel(dataDir), rel(storageDir)];
  if ((process.env.BLOG0_SESSION_SECRET ?? '').trim() === '') paths.push(rel('var/pglite-session-secret'));
  paths.push(rel(adminFile));
  return paths;
}

async function get(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

/** Waits for the server, compiles the home page once (so the first visit is fast), prints the banner. */
async function announceWhenReady() {
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 180_000;
  while ((await get(`${base}/api/health`, 5_000)) !== 200) {
    if (Date.now() > deadline || child.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  await get(`${base}/`, 120_000);
  if (child.exitCode !== null) return;
  const { admin } = setup;
  const adminLine =
    admin.password !== null
      ? `designer admin: ${admin.email} / ${admin.password}   (${admin.status === 'created' ? 'new' : 'rotated'} — shown once; also saved in ${admin.file})`
      : admin.fileExists
        ? `designer admin: ${admin.email} — password in ${admin.file}`
        : `designer admin: ${admin.email} — ${admin.file} is missing; get a new password with: pnpm dev:design --reset-designer-password`;
  const rule = '─'.repeat(72);
  console.log(
    [
      '',
      rule,
      `blog0 designer mode is ready (database ${seconds(setupMs)}, total ${seconds(Date.now() - t0)})`,
      `site:            ${base}`,
      `admin:           ${base}/admin/login`,
      adminLine,
      'edit styles:     src/styles/design.css (ported design) · additions.css · admin.css — saved edits hot-reload',
      'edit components: src/components/design · site · reader',
      'new password:    pnpm dev:design --reset-designer-password',
      `start over:      stop (Ctrl+C), then rm -rf ${startOverPaths(admin.file).join(' ')}`,
      rule,
      '',
    ].join('\n'),
  );
}

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
