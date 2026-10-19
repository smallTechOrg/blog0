// GCP deploy (spec/architecture.md §12.7): `pnpm build:release` bundles scripts/seed-content.ts into
// dist/seed-content.mjs — the first-deploy content seed deploy/vm/deploy-remote.sh runs in the image
// (`node seed-content.mjs`) after the release step. Runs the BUNDLE against real Postgres in its OWN
// database (BLOG0_TEST_DATABASE_URL suffixed `_seed_content`, migrated + site + admin by the release
// step here): first run → the 5 posts published with their committed deck fixtures (0 AI calls,
// 0 ai_generation rows); second run → "already has 5 article(s) — skipped" and nothing changes;
// no admin → exit 1; an unknown argument → exit 2. The OpenRouter key is a placeholder: no AI call
// is possible here. The bundle imports only node builtins and @node-rs/argon2.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensurePostgresDatabase } from '@/server/db/postgres';
import { runRelease } from '@/server/ops/release';
import { SEED_POSTS } from '@/server/seed/posts';

import { getTestDatabaseUrl } from '../helpers/env';

const ROOT = process.cwd();
const BUNDLE = path.join(ROOT, 'dist', 'seed-content.mjs');

function bundleDbUrl(): string {
  const url = new URL(getTestDatabaseUrl());
  url.pathname = `${url.pathname}_seed_content`;
  return url.toString();
}
const DB_URL = bundleDbUrl();

// Blank values stop @next/env from filling them in from the developer's .env (the shell wins).
const baseEnv: Record<string, string | undefined> = {
  NODE_ENV: 'production', // as in the image
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  BLOG0_DATABASE_URL: DB_URL,
  BLOG0_SESSION_SECRET: 'seed-content-session-secret-0123456789abcdef',
  BLOG0_OPENROUTER_API_KEY: 'pending-placeholder',
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
  BLOG0_LOG_LEVEL: 'warn',
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBundle(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { cwd: ROOT, env: { ...baseEnv, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function query<T extends Record<string, unknown>>(text: string): Promise<T[]> {
  const sql = postgres(DB_URL, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    return (await sql.unsafe(text)) as unknown as T[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function freshDatabase(withAdmin: boolean): Promise<void> {
  await query('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  await runRelease({
    env: {
      BLOG0_DATABASE_URL: DB_URL,
      ...(withAdmin ? { BLOG0_ADMIN_EMAIL: 'seed.content@example.com', BLOG0_ADMIN_PASSWORD: 'seed-content-pass-0123', BLOG0_ADMIN_NAME: 'Seed Content' } : {}),
    },
    slug: 'blog0',
    out: () => {},
  });
}

beforeAll(async () => {
  const built = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  expect(built.status, built.stderr).toBe(0);
  expect(built.stdout).toContain('build:release: dist/seed-content.mjs');
  expect(existsSync(BUNDLE)).toBe(true);
  await ensurePostgresDatabase(DB_URL);
}, 240_000);

afterAll(async () => {
  await query('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;').catch(() => {});
});

describe('bundled dist/seed-content.mjs (first-deploy content seed)', () => {
  it('seeds the 5 posts + published fixture decks once (0 AI calls), then is a no-op on the second run', async () => {
    await freshDatabase(true);

    const first = await runBundle([]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^seed-content: site blog0 — 5 posts created; decks: 5 seeded \(0 calls\)$/m);

    const articles = await query<{ slug: string; status: string }>('select slug, status from article order by slug');
    expect(articles.map((a) => a.slug)).toEqual(SEED_POSTS.map((p) => p.slug).sort());
    expect(articles.every((a) => a.status === 'published')).toBe(true);
    const decks = await query<{ n: string }>("select count(*)::text as n from article_format where kind = 'tldr' and published_payload is not null");
    expect(decks[0].n).toBe('5');
    const generations = await query<{ n: string }>('select count(*)::text as n from ai_generation');
    expect(generations[0].n).toBe('0');
    const revisionsBefore = await query<{ n: string }>('select count(*)::text as n from article_revision');

    const second = await runBundle(['--']);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/^seed-content: site blog0 already has 5 article\(s\) — skipped \(first deploy only\)$/m);
    const revisionsAfter = await query<{ n: string }>('select count(*)::text as n from article_revision');
    expect(revisionsAfter[0].n).toBe(revisionsBefore[0].n);
  }, 180_000);

  it('leaves a site with any article alone (a writer deleted the seeds and wrote one post)', async () => {
    // Continues from the seeded database: drop all but one article → still non-empty → skipped.
    await query("delete from article where slug <> 'humans-are-software'");
    const r = await runBundle([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('already has 1 article(s) — skipped');
    const left = await query<{ n: string }>('select count(*)::text as n from article');
    expect(left[0].n).toBe('1');
  }, 60_000);

  it('exit 1 when the site has no admin yet (the release step must run with BLOG0_ADMIN_* first)', async () => {
    await freshDatabase(false);
    const r = await runBundle([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^seed-content failed: Site 'blog0' has no admin yet/m);
    const n = await query<{ n: string }>('select count(*)::text as n from article');
    expect(n[0].n).toBe('0');
  }, 60_000);

  it('exit 2 on an unknown argument', async () => {
    const r = await runBundle(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('seed-content failed: Unknown argument(s): --bogus');
  }, 60_000);

  it('imports only node: builtins and @node-rs/argon2 at runtime (postgres, Shiki, zod are bundled)', () => {
    const source = readFileSync(BUNDLE, 'utf8');
    const bare = [...source.matchAll(/^import .*? from ["']([^"']+)["'];/gm)].map((m) => m[1]);
    const builtins = new Set(builtinModules);
    const external = bare.filter((s) => !s.startsWith('node:') && !builtins.has(s));
    expect([...new Set(external)]).toEqual(['@node-rs/argon2']);
  });
});
