// Helpers for scripts/container-e2e.sh (`pnpm test:container`, spec/architecture.md §12.5).
// Secret values are never printed: only variable NAMES and key presence reach the terminal.
//
//   node scripts/lib/container-env.mjs env
//       Loads .env + the shell (via @next/env; the shell wins) and writes var/container-e2e.env
//       (mode 0600, one unquoted KEY=value per line) with every BLOG0_* value except the ones the
//       script or the image sets itself, plus a fresh random BLOG0_SESSION_SECRET and — when no
//       real OpenRouter key is configured — the boot-accepted placeholder `pending-placeholder`
//       (the real-key E2E step then skips as PENDING KEY). Newsletter delivery is ALWAYS the stubs:
//       BLOG0_SMTP_HOST is written empty and BLOG0_NEWSLETTER_SENDER=stub, and no BLOG0_SMTP_* /
//       BLOG0_LISTMONK_* value is copied — the suite's newsletter walk must never reach a real relay
//       or Listmonk configured in .env. CONTAINER_ENV_FILE overrides the output path (tests). Prints the container's database URL
//       (BLOG0_TEST_DATABASE_URL with a loopback host replaced by host.docker.internal) on stdout,
//       and `key: real` / `key: placeholder` on stderr.
//   node scripts/lib/container-env.mjs reset-db
//       Creates blog0_test when missing, then drops and recreates its schemas (drizzle + public) so
//       the release step migrates an empty database. Refuses unless the URL is postgres:// and differs from BLOG0_DATABASE_URL.
//   node scripts/lib/container-env.mjs stale <image-created-iso>
//       Exit 0 + prints the first newer file when a build-context file that reaches the image is
//       newer than the image; exit 1 (prints "up to date") otherwise. Honours .dockerignore.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import nextEnv from '@next/env';

const ROOT = process.cwd();
const ENV_FILE = (process.env.CONTAINER_ENV_FILE ?? '').trim() || path.join(ROOT, 'var', 'container-e2e.env');

/** Set by the script / the image / the test harness — never copied into the container env file. */
const EXCLUDED = new Set([
  'BLOG0_DATABASE_URL',
  'BLOG0_TEST_DATABASE_URL',
  'BLOG0_PORT',
  'BLOG0_PUBLIC_BASE_URL',
  'BLOG0_STORAGE_DIR',
  'BLOG0_LOG_FILE',
  'BLOG0_DIST_DIR',
  'BLOG0_STANDALONE',
  'BLOG0_NEW_ADMIN_PASSWORD',
  'BLOG0_REQUIRE_REAL_KEY',
  'BLOG0_NEWSLETTER_SENDER', // forced to `stub` below
]);
// SMTP + Listmonk: never copied — the container runs the E2E newsletter walk on the stubs only.
const EXCLUDED_PREFIXES = ['BLOG0_E2E_', 'BLOG0_ADMIN_', 'BLOG0_SMTP_', 'BLOG0_LISTMONK_'];

/** Mirrors src/server/llm/key.ts openRouterKeyStatus: empty or a placeholder ⇒ no real key. */
const PLACEHOLDER_RE = /^(replace|pending|placeholder|changeme|change-me|your|xxx|todo|<)|placeholder|replace-with/i;
function isPlaceholderKey(value) {
  const v = (value ?? '').trim();
  return v === '' || PLACEHOLDER_RE.test(v);
}

function loadEnv() {
  nextEnv.loadEnvConfig(ROOT, false, { info: () => {}, error: (...args) => console.error(...args) });
}

function testDatabaseUrl() {
  const raw = (process.env.BLOG0_TEST_DATABASE_URL ?? '').trim();
  if (!raw) throw new Error('BLOG0_TEST_DATABASE_URL is not set (.env or shell)');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BLOG0_TEST_DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('BLOG0_TEST_DATABASE_URL must be postgres://');
  }
  if (raw === (process.env.BLOG0_DATABASE_URL ?? '').trim()) {
    throw new Error('BLOG0_TEST_DATABASE_URL must differ from BLOG0_DATABASE_URL');
  }
  return url;
}

/** The test DB as the container sees it: loopback hosts → host.docker.internal. */
export function containerDatabaseUrl(url) {
  const out = new URL(url.href);
  const host = out.hostname.replace(/^\[|\]$/g, '');
  if (host === '' || out.searchParams.has('host')) {
    throw new Error('BLOG0_TEST_DATABASE_URL uses a Unix socket; the container needs a TCP host (e.g. localhost:5432)');
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') out.hostname = 'host.docker.internal';
  return out.href;
}

function writeEnvFile() {
  loadEnv();
  const dbUrl = containerDatabaseUrl(testDatabaseUrl());
  const values = new Map();
  const skipped = [];
  for (const [name, value] of Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (!name.startsWith('BLOG0_') || value === undefined) continue;
    if (EXCLUDED.has(name) || EXCLUDED_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (/[\r\n]/.test(value)) {
      skipped.push(name);
      continue;
    }
    values.set(name, value.trim());
  }
  // The recording stub mail transport + the stub sender, explicitly (an empty host = no SMTP).
  values.set('BLOG0_SMTP_HOST', '');
  values.set('BLOG0_NEWSLETTER_SENDER', 'stub');
  // Generated in-process for this run only (every container session is throwaway).
  values.set('BLOG0_SESSION_SECRET', randomBytes(48).toString('base64'));
  const realKey = !isPlaceholderKey(values.get('BLOG0_OPENROUTER_API_KEY'));
  if (!realKey) values.set('BLOG0_OPENROUTER_API_KEY', 'pending-placeholder');

  mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  const body = [...values].map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(ENV_FILE, body, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  if (skipped.length > 0) console.error(`container-env: skipped multi-line values: ${skipped.join(', ')}`);
  console.error(`key: ${realKey ? 'real' : 'placeholder'}`);
  process.stdout.write(`${dbUrl}\n`);
}

async function resetDb() {
  loadEnv();
  const url = testDatabaseUrl();
  const { default: postgres } = await import('postgres');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('BLOG0_TEST_DATABASE_URL has an unexpected database name');
  // Create it when missing (through the maintenance database), like `pnpm db:create`.
  const admin = new URL(url.href);
  admin.pathname = '/postgres';
  const root = postgres(admin.href, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const found = await root`select 1 from pg_database where datname = ${name}`;
    if (found.length === 0) {
      await root.unsafe(`create database "${name}"`);
      console.log(`container-env: created ${name}`);
    }
  } finally {
    await root.end({ timeout: 5 });
  }
  const sql = postgres(url.href, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await sql`drop schema if exists drizzle cascade`;
    await sql`drop schema if exists public cascade`;
    await sql`create schema public`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log(`container-env: reset ${name} (empty schema)`);
}

// ---- image staleness ---------------------------------------------------------------------------

/**
 * Context files whose changes cannot change the image: this test's own scripts, and
 * next-env.d.ts (rewritten by every local `next build` / `next dev`, regenerated in the build stage).
 */
const NOT_IN_IMAGE = new Set(['scripts/container-e2e.sh', 'scripts/lib/container-env.mjs', 'next-env.d.ts']);

function globToRegExp(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function dockerignoreRules() {
  let text = '';
  try {
    text = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      const pattern = (negate ? l.slice(1) : l).replace(/^\/+|\/+$/g, '');
      return { negate, re: globToRegExp(pattern) };
    });
}

/** Docker semantics (simplified): the last matching rule wins; a rule matches a path or any parent. */
function ignored(rel, rules) {
  const parts = rel.split('/');
  let result = false;
  for (const rule of rules) {
    for (let i = 1; i <= parts.length; i++) {
      if (rule.re.test(parts.slice(0, i).join('/'))) {
        result = !rule.negate;
        break;
      }
    }
  }
  return result;
}

function newestContextFile(sinceMs) {
  const rules = dockerignoreRules();
  const stack = [''];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (ignored(rel, rules)) continue;
      if (entry.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!entry.isFile() || NOT_IN_IMAGE.has(rel)) continue;
      // Root-level docs (README.md …) are copied into the build stage only, never the runtime image.
      if (!rel.includes('/') && rel.endsWith('.md')) continue;
      if (statSync(path.join(ROOT, rel)).mtimeMs > sinceMs) return rel;
    }
  }
  return null;
}

function stale(createdIso) {
  const created = Date.parse(createdIso ?? '');
  if (Number.isNaN(created)) {
    console.log('image creation time unknown');
    process.exit(0);
  }
  const newer = newestContextFile(created);
  if (newer) {
    console.log(`newer than the image: ${newer}`);
    process.exit(0);
  }
  console.log('up to date');
  process.exit(1);
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'env' || command === undefined) writeEnvFile();
  else if (command === 'reset-db') await resetDb();
  else if (command === 'stale') stale(arg);
  else {
    console.error(`usage: node scripts/lib/container-env.mjs env | reset-db | stale <image-created-iso>`);
    process.exit(2);
  }
} catch (err) {
  console.error(`container-env: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
