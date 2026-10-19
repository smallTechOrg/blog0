// Stage B (spec/architecture.md §12.7 → Image): `pnpm build:release` bundles scripts/newsletter-tick.ts
// into dist/newsletter-tick.mjs — what the image's `scheduler` stage runs hourly as
// `node /app/newsletter-tick.mjs` without a repo checkout. Runs the BUNDLE against real Postgres in
// its OWN database (BLOG0_TEST_DATABASE_URL suffixed `_tick_bundle`, migrated + seeded by the release
// step here): exit 0 + the digest line + the success heartbeat, exit 1 (+ /fail heartbeat) on an
// unreachable database, exit 2 on a usage error; and the bundle imports only node builtins and
// @node-rs/argon2 (the image exposes no postgres/shiki at /app/node_modules). Newsletter delivery is
// forced to the stubs (no SMTP, no Listmonk). No LLM is involved in the tick.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { builtinModules } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensurePostgresDatabase } from '@/server/db/postgres';
import { runRelease } from '@/server/ops/release';

import { getTestDatabaseUrl } from '../helpers/env';

const ROOT = process.cwd();
const BUNDLE = path.join(ROOT, 'dist', 'newsletter-tick.mjs');
const SECRET = 'tick-bundle-5d1c0a8e-secret';

function bundleDbUrl(): string {
  const url = new URL(getTestDatabaseUrl());
  url.pathname = `${url.pathname}_tick_bundle`;
  return url.toString();
}
const DB_URL = bundleDbUrl();

// Blank values stop @next/env from filling them in from the developer's .env (the shell wins).
const baseEnv: Record<string, string | undefined> = {
  NODE_ENV: 'production', // as in the image
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  BLOG0_DATABASE_URL: DB_URL,
  BLOG0_SESSION_SECRET: 'tick-bundle-session-secret-0123456789abcdef',
  BLOG0_SITE_SLUG: 'blog0',
  BLOG0_PUBLIC_BASE_URL: 'http://localhost:3499',
  BLOG0_NEWSLETTER_SENDER: 'stub',
  BLOG0_SMTP_HOST: '',
  BLOG0_LISTMONK_URL: '',
  BLOG0_LISTMONK_API_USER: '',
  BLOG0_LISTMONK_API_TOKEN: '',
  BLOG0_LISTMONK_LIST_ID: '',
  BLOG0_HEARTBEAT_TICK_URL: '',
  BLOG0_HEARTBEAT_BACKUP_URL: '',
  BLOG0_LOG_FILE: '',
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async: the heartbeat listener lives in this process's event loop. */
function runBundle(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { cwd: ROOT, env: { ...baseEnv, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

let server: Server;
let hbUrl = '';
const hits: string[] = [];

beforeAll(async () => {
  const built = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(built.status, built.stderr).toBe(0);
  expect(built.stdout).toContain('build:release: dist/newsletter-tick.mjs');
  expect(existsSync(BUNDLE)).toBe(true);

  await ensurePostgresDatabase(DB_URL);
  const client = postgres(DB_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await client.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  } finally {
    await client.end({ timeout: 5 });
  }
  await runRelease({ env: { BLOG0_DATABASE_URL: DB_URL }, slug: 'blog0', out: () => {} });

  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  hbUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${SECRET}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe('bundled dist/newsletter-tick.mjs (what the scheduler image runs)', () => {
  it('exit 0 on a migrated database: prints the digest line and pings GET <url> once (URL never printed)', async () => {
    hits.length = 0;
    const r = await runBundle([], { BLOG0_HEARTBEAT_TICK_URL: hbUrl });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^digest: not due; suppressions pulled 0; stats refreshed 0; ips pruned 0; erasures retried 0$/m);
    expect(r.stdout).toContain('"event":"newsletter.tick"');
    expect(hits).toEqual([`GET /${SECRET}`]);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  }, 60_000);

  it('exit 1 with "newsletter:tick failed:" and GET <url>/fail when the database is unreachable', async () => {
    hits.length = 0;
    const r = await runBundle([], { BLOG0_HEARTBEAT_TICK_URL: hbUrl, BLOG0_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nowhere' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^newsletter:tick failed: /m);
    expect(hits).toEqual([`GET /${SECRET}/fail`]);
  }, 60_000);

  it('exit 2 on an unknown argument (usage), no heartbeat; a leading `--` is ignored', async () => {
    hits.length = 0;
    const usage = await runBundle(['--bogus'], { BLOG0_HEARTBEAT_TICK_URL: hbUrl });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('newsletter:tick failed: Unknown argument(s): --bogus');
    expect(usage.stderr).toContain('Usage: pnpm newsletter:tick');
    expect(hits).toEqual([]);

    const dashdash = await runBundle(['--'], {});
    expect(dashdash.status, dashdash.stderr).toBe(0);
  }, 60_000);

  it('imports only node: builtins and @node-rs/argon2 at runtime (Shiki/content pipeline and postgres are bundled)', () => {
    const source = readFileSync(BUNDLE, 'utf8');
    const bare = [...source.matchAll(/^import .*? from ["']([^"']+)["'];/gm)].map((m) => m[1]);
    const builtins = new Set(builtinModules);
    const external = bare.filter((s) => !s.startsWith('node:') && !builtins.has(s));
    expect([...new Set(external)]).toEqual(['@node-rs/argon2']);
    expect(source).not.toMatch(/\brequire\("(?!(?:node:)?(?:path|os|fs|crypto)")[^"]+"\)/);
  });
});
