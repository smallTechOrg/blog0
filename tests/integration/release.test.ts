// Release step (capability container-image; spec/architecture.md §12.1) against real Postgres, in
// its OWN database: BLOG0_TEST_DATABASE_URL with the name suffixed `_release`, created here with
// ensurePostgresDatabase and schema-dropped here (never blog0_test's schema — other files share it).
// Covers runRelease() directly (migrate → verify → site → admin, idempotence, never resetting a
// password, pglite refusal, validation before any DB work, an unreachable DB) and the bundled
// `dist/release.mjs` the image runs (`pnpm build:release` then `node dist/release.mjs`): exit 0 / 1 / 2.
// No LLM is involved in the release step, so there is no real-key call here.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifyPassword } from '@/server/auth/password';
import { createDbHandle, rowsOf, type DbHandle } from '@/server/db/client';
import { readJournal } from '@/server/db/migrate';
import { ensurePostgresDatabase } from '@/server/db/postgres';
import { appUser, site } from '@/server/db/schema';
import { ReleaseUsageError, releaseSiteSlug, runRelease } from '@/server/ops/release';
import { SeedError } from '@/server/seed/admin';

import { getTestDatabaseUrl } from '../helpers/env';

const ROOT = process.cwd();
const JOURNAL = readJournal();
const LATEST = JOURNAL[JOURNAL.length - 1].tag;
const ADMIN = { email: 'release.admin@example.com', password: 'release-pass-0123456789', name: 'Release Admin' };

function releaseUrl(): string {
  const url = new URL(getTestDatabaseUrl());
  url.pathname = `${url.pathname}_release`;
  return url.toString();
}

const URL_RELEASE = releaseUrl();
const DB_NAME = decodeURIComponent(new URL(URL_RELEASE).pathname.slice(1));

async function dropSchemas(): Promise<void> {
  const client = postgres(URL_RELEASE, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await client.unsafe('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function release(env: Record<string, string | undefined>, slug = 'blog0'): Promise<string[]> {
  const lines: string[] = [];
  await runRelease({ env: { BLOG0_DATABASE_URL: URL_RELEASE, ...env }, slug, out: (line) => lines.push(line) });
  return lines;
}

const withAdmin = {
  BLOG0_ADMIN_EMAIL: ADMIN.email,
  BLOG0_ADMIN_PASSWORD: ADMIN.password,
  BLOG0_ADMIN_NAME: ADMIN.name,
};

let handle: DbHandle;

beforeAll(async () => {
  await ensurePostgresDatabase(URL_RELEASE);
  handle = await createDbHandle({ engine: 'postgres', url: URL_RELEASE }, { max: 1 });
});

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await dropSchemas();
});

describe('runRelease — happy path and idempotence', () => {
  it('migrates an empty database, verifies 0 pending and creates the site; admin skipped without BLOG0_ADMIN_*', async () => {
    const lines = await release({});

    expect(lines).toEqual([
      ...JOURNAL.map((e) => `${DB_NAME}: applied ${e.tag}`),
      expect.stringMatching(
        new RegExp(`^release: ${DB_NAME} @ PostgreSQL \\d+(\\.\\d+)* — ${JOURNAL.length} applied \\(latest ${LATEST}\\), 0 pending: OK$`),
      ),
      'site blog0 ok (created), admin skipped (BLOG0_ADMIN_* not set)',
    ]);
    const sites = await handle.db.select().from(site);
    expect(sites.map((s) => s.slug)).toEqual(['blog0']);
    expect(await handle.db.select().from(appUser)).toEqual([]);
  });

  it('a second run changes nothing: "already up to date", "site blog0 ok"', async () => {
    await release({});
    const [before] = await handle.db.select().from(site);

    const lines = await release({});

    expect(lines[0]).toBe(`${DB_NAME}: already up to date (latest ${LATEST})`);
    expect(lines[1]).toMatch(/0 pending: OK$/);
    expect(lines[2]).toBe('site blog0 ok, admin skipped (BLOG0_ADMIN_* not set)');
    expect(lines).toHaveLength(3);
    const sites = await handle.db.select().from(site);
    expect(sites).toHaveLength(1);
    expect(sites[0].updatedAt).toEqual(before.updatedAt);
  });

  it('creates the admin (argon2id hash that verifies) once, then reports ok and never resets the password', async () => {
    const first = await release(withAdmin);
    expect(first.at(-1)).toBe('site blog0 ok (created), admin r***@example.com ok (created)');

    const [user] = await handle.db.select().from(appUser).where(eq(appUser.email, ADMIN.email));
    expect(user.displayName).toBe(ADMIN.name);
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(user.passwordHash, ADMIN.password)).toBe(true);
    // the password is never printed
    expect(first.join('\n')).not.toContain(ADMIN.password);

    const second = await release({ ...withAdmin, BLOG0_ADMIN_PASSWORD: 'a-different-password-42' });
    expect(second.at(-1)).toBe('site blog0 ok, admin r***@example.com ok');
    const [after] = await handle.db.select().from(appUser).where(eq(appUser.email, ADMIN.email));
    expect(after.passwordHash).toBe(user.passwordHash);
    expect(await handle.db.select().from(appUser)).toHaveLength(1);
  });

  it('seeds the slug it is given', async () => {
    const lines = await release({}, 'other-site');
    expect(lines.at(-1)).toBe('site other-site ok (created), admin skipped (BLOG0_ADMIN_* not set)');
    expect((await handle.db.select().from(site)).map((s) => s.slug)).toEqual(['other-site']);
  });
});

describe('runRelease — edge cases', () => {
  it('only one of BLOG0_ADMIN_EMAIL / BLOG0_ADMIN_PASSWORD set (or blank) → admin skipped', async () => {
    expect((await release({ BLOG0_ADMIN_EMAIL: ADMIN.email })).at(-1)).toMatch(/admin skipped/);
    expect((await release({ BLOG0_ADMIN_EMAIL: '  ', BLOG0_ADMIN_PASSWORD: ADMIN.password })).at(-1)).toMatch(/admin skipped/);
    expect(await handle.db.select().from(appUser)).toEqual([]);
  });

  it('releaseSiteSlug: default blog0, comment-tolerant, rejects a malformed slug', () => {
    expect(releaseSiteSlug({})).toBe('blog0');
    expect(releaseSiteSlug({ BLOG0_SITE_SLUG: '  my-site  # prod' })).toBe('my-site');
    expect(() => releaseSiteSlug({ BLOG0_SITE_SLUG: 'Bad Slug' })).toThrow(/BLOG0_SITE_SLUG must be lowercase/);
  });
});

describe('runRelease — error paths', () => {
  it('a pglite:// target is a ReleaseUsageError and nothing is created on disk', async () => {
    const err = await release({ BLOG0_DATABASE_URL: 'pglite://var/release-should-not-exist' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseUsageError);
    expect((err as Error).message).toBe('the release step is for Postgres; designer mode migrates in pnpm dev:design');
    expect(existsSync(path.join(ROOT, 'var', 'release-should-not-exist'))).toBe(false);
  });

  it('an absent BLOG0_DATABASE_URL (the PGlite default) is refused the same way', async () => {
    await expect(runRelease({ env: {}, slug: 'blog0', out: () => {} })).rejects.toBeInstanceOf(ReleaseUsageError);
  });

  it('invalid admin credentials fail before any database work', async () => {
    const err = await release({ ...withAdmin, BLOG0_ADMIN_PASSWORD: 'short' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedError);
    expect((err as Error).message).toMatch(/BLOG0_ADMIN_PASSWORD/);
    // nothing was migrated: the ledger table does not exist
    const [ledger] = rowsOf<{ exists: boolean }>(
      await handle.db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`),
    );
    expect(ledger.exists).toBe(false);
  });

  it('an unreachable database rejects (no output claims success)', async () => {
    const lines: string[] = [];
    await expect(
      runRelease({ env: { BLOG0_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nothing' }, slug: 'blog0', out: (l) => lines.push(l) }),
    ).rejects.toThrow();
    expect(lines.join('\n')).not.toMatch(/OK/);
  });
});

describe('bundled dist/release.mjs (what the image runs)', () => {
  // Blank values stop @next/env from filling them in from the developer's .env.
  const baseEnv = {
    NODE_ENV: 'production' as const, // as in the image
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    BLOG0_ADMIN_EMAIL: '',
    BLOG0_ADMIN_PASSWORD: '',
    BLOG0_ADMIN_NAME: '',
    BLOG0_SITE_SLUG: '',
  };
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['dist/release.mjs'], { cwd: ROOT, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 60_000 });

  beforeAll(() => {
    const built = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(built.status, built.stderr).toBe(0);
    expect(existsSync(path.join(ROOT, 'dist', 'release.mjs'))).toBe(true);
  });

  it('exit 0: migrates, verifies, seeds site + admin (argon2 loaded from node_modules); second run is a no-op', () => {
    const first = run({ BLOG0_DATABASE_URL: URL_RELEASE, ...withAdmin });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(new RegExp(`release: ${DB_NAME} @ PostgreSQL .* 0 pending: OK`));
    expect(first.stdout).toContain('site blog0 ok (created), admin r***@example.com ok (created)');

    const second = run({ BLOG0_DATABASE_URL: URL_RELEASE, ...withAdmin });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('already up to date');
    expect(second.stdout).toContain('site blog0 ok, admin r***@example.com ok');
  });

  it('imports only node: builtins and @node-rs/argon2 at runtime (the image exposes no postgres/pglite at /app/node_modules)', () => {
    const source = readFileSync(path.join(ROOT, 'dist', 'release.mjs'), 'utf8');
    const bare = [...source.matchAll(/^import .*? from ["']([^"']+)["'];/gm)].map((m) => m[1]);
    const builtins = new Set(builtinModules);
    const external = bare.filter((s) => !s.startsWith('node:') && !builtins.has(s));
    expect([...new Set(external)]).toEqual(['@node-rs/argon2']);
  });

  it('exit 2 on pglite://', () => {
    const r = run({ BLOG0_DATABASE_URL: 'pglite://x' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('release failed: the release step is for Postgres; designer mode migrates in pnpm dev:design');
  });

  it('exit 1 on a malformed BLOG0_SITE_SLUG or an unreachable database', () => {
    const slug = run({ BLOG0_DATABASE_URL: URL_RELEASE, BLOG0_SITE_SLUG: 'Not A Slug' });
    expect(slug.status).toBe(1);
    expect(slug.stderr).toMatch(/^release failed: BLOG0_SITE_SLUG must be lowercase/m);

    const down = run({ BLOG0_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nothing' });
    expect(down.status).toBe(1);
    expect(down.stderr).toMatch(/^release failed: /m);
    expect(down.stderr).not.toContain('nobody@');
  });
});
