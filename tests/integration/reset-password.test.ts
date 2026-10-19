// Stage A password reset CLI (spec/roadmap.md → Launch polish item 7; spec/architecture.md §12.1;
// admin-auth.md success criteria): runResetPassword() against the real blog0_test Postgres and an
// embedded PGlite directory, `pnpm admin:reset-password` through tsx, and the bundled
// `dist/reset-password.mjs` the image runs (`pnpm build:release`). No LLM is involved.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { login } from '@/server/auth/login';
import { verifyPassword } from '@/server/auth/password';
import { createDbHandle, getDb } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { appUser, rateLimitBucket, session, type SiteRow } from '@/server/db/schema';
import { ApiError } from '@/server/http/api';
import { ResetPasswordError, runResetPassword } from '@/server/ops/reset-password';
import { DbRateLimitStore, resetRateLimitStoreForTests } from '@/server/rate-window-store';
import { createAdmin } from '@/server/seed/admin';
import { seedSite } from '@/server/seed/site';

import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const ROOT = process.cwd();
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const EMAIL = 'sai@smalltech.in';
const OLD = 'the-old-password-123';
const NEW = 'a-brand-new-password-456';

let currentSite: SiteRow;

async function signIn(password: string): Promise<{ status: number; cookie: string }> {
  const res = await loginRoute(
    new Request(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410' },
      body: JSON.stringify({ email: EMAIL, password }),
    }),
    ctx,
  );
  return { status: res.status, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}

async function me(cookie: string): Promise<number> {
  return (await meRoute(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie } }), ctx)).status;
}

/** Env for a child process: blank values stop @next/env from filling them in from the developer's .env. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    BLOG0_DATABASE_URL: process.env.BLOG0_DATABASE_URL,
    BLOG0_NEW_ADMIN_PASSWORD: '',
    BLOG0_SITE_SLUG: 'blog0',
    BLOG0_LOG_LEVEL: 'info',
    BLOG0_LOG_FILE: '',
    ...extra,
  };
  return env as NodeJS.ProcessEnv;
}

/** Async run (no TTY: stdin is a closed pipe), so the event loop of this process stays free. */
function runChild(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(args[0] as string, args.slice(1), { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.stdin.end();
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

beforeEach(async () => {
  currentSite = await resetDb();
  await createAdmin(getDb(), currentSite.id, { email: EMAIL, password: OLD, displayName: 'Sai' });
  resetRateLimitStoreForTests(new DbRateLimitStore());
});

afterAll(() => {
  resetRateLimitStoreForTests();
});

describe('runResetPassword (postgres://)', () => {
  it('sets the new password, ends every session of that user, clears the email\'s login delay; prints only the masked email + count', async () => {
    const a = await signIn(OLD);
    const b = await signIn(OLD);
    expect([a.status, b.status]).toEqual([200, 200]);
    // another admin's session must survive
    await createAdmin(getDb(), currentSite.id, { email: 'other@smalltech.in', password: 'other-password-1234', displayName: 'Other' });
    await login({ siteId: currentSite.id, email: 'other@smalltech.in', password: 'other-password-1234', ip: 'direct', userAgent: null });
    // a pending login delay for the email (5 failures)
    for (let i = 0; i < 5; i += 1) await login({ siteId: currentSite.id, email: EMAIL, password: 'wrong-password-000', ip: 'direct', userAgent: null }).catch(() => undefined);
    expect(await getDb().select().from(rateLimitBucket).where(eq(rateLimitBucket.scope, 'login.delay'))).toHaveLength(1);

    const logs = captureLogs();
    const out: string[] = [];
    try {
      await runResetPassword({ env: { BLOG0_DATABASE_URL: process.env.BLOG0_DATABASE_URL }, email: ' Sai@SmallTech.in ', password: NEW, slug: 'blog0', out: (l) => out.push(l) });
    } finally {
      logs.stop();
    }

    expect(out).toEqual(['password reset for s***@smalltech.in · 2 sessions ended']);
    expect(await me(a.cookie)).toBe(401);
    expect(await me(b.cookie)).toBe(401);
    expect(await getDb().select().from(session)).toHaveLength(1); // the other admin's
    expect(await getDb().select().from(rateLimitBucket).where(eq(rateLimitBucket.scope, 'login.delay'))).toHaveLength(0);
    // immediately after the reset: no delay left, the old password is refused, the new one works
    expect((await signIn(OLD)).status).toBe(401);
    expect((await signIn(NEW)).status).toBe(200);
    const [user] = await getDb().select().from(appUser).where(eq(appUser.email, EMAIL));
    expect(await verifyPassword(user.passwordHash, NEW)).toBe(true);
    expect(logs.find('auth.password_reset')).toEqual([expect.objectContaining({ email_masked: 's***@smalltech.in', sessions_ended: 2 })]);
    expect(JSON.stringify(logs.lines)).not.toContain(NEW);
    expect(JSON.stringify(logs.lines)).not.toContain(EMAIL);
  });

  it('an unknown email → ResetPasswordError exit 1, nothing changes', async () => {
    const a = await signIn(OLD);
    const err = await runResetPassword({ env: { BLOG0_DATABASE_URL: process.env.BLOG0_DATABASE_URL }, email: 'nobody@smalltech.in', password: NEW, slug: 'blog0', out: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResetPasswordError);
    expect(err).toMatchObject({ exitCode: 1, message: 'no admin with that email' });
    expect(await me(a.cookie)).toBe(200);
    expect((await signIn(OLD)).status).toBe(200);
  });

  it('a password outside 12–200 chars or a bad email → exit 2 before any change; a missing site → exit 1', async () => {
    const env = { BLOG0_DATABASE_URL: process.env.BLOG0_DATABASE_URL };
    for (const password of ['x'.repeat(11), 'x'.repeat(201)]) {
      const err = await runResetPassword({ env, email: EMAIL, password, slug: 'blog0', out: () => {} }).catch((e: unknown) => e);
      expect(err).toMatchObject({ exitCode: 2 });
    }
    expect(await runResetPassword({ env, email: 'not-an-email', password: NEW, slug: 'blog0', out: () => {} }).catch((e: unknown) => e)).toMatchObject({ exitCode: 2 });
    expect(await runResetPassword({ env, email: EMAIL, password: NEW, slug: 'no-such-site', out: () => {} }).catch((e: unknown) => e)).toMatchObject({ exitCode: 1 });
    expect((await signIn(OLD)).status).toBe(200);
  });
});

describe('runResetPassword (pglite:// — designer mode has admins too)', () => {
  it('resets an admin in an embedded PGlite directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blog0-reset-pglite-'));
    try {
      const handle = await createDbHandle({ engine: 'pglite', dir });
      await runMigrations(handle);
      const { site } = await seedSite(handle.db, 'blog0');
      await createAdmin(handle.db, site.id, { email: 'designer@example.test', password: OLD, displayName: 'Designer' });
      await handle.close();

      const out: string[] = [];
      await runResetPassword({ env: { BLOG0_DATABASE_URL: `pglite://${dir}` }, email: 'designer@example.test', password: NEW, slug: 'blog0', out: (l) => out.push(l) });
      expect(out).toEqual(['password reset for d***@example.test · 0 sessions ended']);

      const again = await createDbHandle({ engine: 'pglite', dir });
      try {
        const [user] = await again.db.select().from(appUser).where(eq(appUser.email, 'designer@example.test'));
        expect(await verifyPassword(user.passwordHash, NEW)).toBe(true);
      } finally {
        await again.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pnpm admin:reset-password (tsx)', () => {
  it('BLOG0_NEW_ADMIN_PASSWORD → exit 0 with the masked line; the password never appears in the output', async () => {
    const a = await signIn(OLD);
    const r = await runChild([process.execPath, TSX, 'scripts/reset-password.ts', '--', '--email', EMAIL], childEnv({ BLOG0_NEW_ADMIN_PASSWORD: NEW }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('password reset for s***@smalltech.in · 1 session ended');
    expect(r.stdout + r.stderr).not.toContain(NEW);
    expect(r.stdout + r.stderr).not.toContain(EMAIL);
    expect(r.stdout).toContain('"event":"auth.password_reset"');
    expect(await me(a.cookie)).toBe(401);
    expect((await signIn(NEW)).status).toBe(200);
  });

  it('no TTY and no BLOG0_NEW_ADMIN_PASSWORD → exit 2; missing --email → exit 2; unknown email → exit 1; short password → exit 2', async () => {
    const noPassword = await runChild([process.execPath, TSX, 'scripts/reset-password.ts', '--email', EMAIL], childEnv({}));
    expect(noPassword.status).toBe(2);
    expect(noPassword.stderr).toContain('set BLOG0_NEW_ADMIN_PASSWORD or run with a terminal');

    const noEmail = await runChild([process.execPath, TSX, 'scripts/reset-password.ts'], childEnv({ BLOG0_NEW_ADMIN_PASSWORD: NEW }));
    expect(noEmail.status).toBe(2);
    expect(noEmail.stderr).toContain('Usage: pnpm admin:reset-password --email <address>');

    const unknown = await runChild([process.execPath, TSX, 'scripts/reset-password.ts', '--email=ghost@smalltech.in'], childEnv({ BLOG0_NEW_ADMIN_PASSWORD: NEW }));
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('reset-password failed: no admin with that email');

    const short = await runChild([process.execPath, TSX, 'scripts/reset-password.ts', '--email', EMAIL], childEnv({ BLOG0_NEW_ADMIN_PASSWORD: 'short-pass1' }));
    expect(short.status).toBe(2);
    expect(short.stdout + short.stderr).not.toContain('short-pass1');
    expect((await signIn(OLD)).status).toBe(200);
  });
});

describe('bundled dist/reset-password.mjs (what the image runs)', () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, ['scripts/build-release.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(built.status, built.stderr).toBe(0);
    expect(existsSync(path.join(ROOT, 'dist', 'reset-password.mjs'))).toBe(true);
  });

  it('node dist/reset-password.mjs --email … → exit 0, sessions ended, new password works (argon2 from node_modules, postgres bundled)', async () => {
    const a = await signIn(OLD);
    const b = await signIn(OLD);
    const r = await runChild([process.execPath, 'dist/reset-password.mjs', '--email', EMAIL], childEnv({ NODE_ENV: 'production', BLOG0_NEW_ADMIN_PASSWORD: NEW }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('password reset for s***@smalltech.in · 2 sessions ended');
    expect(r.stdout + r.stderr).not.toContain(NEW);
    expect([await me(a.cookie), await me(b.cookie)]).toEqual([401, 401]);
    expect((await signIn(NEW)).status).toBe(200);

    const unknown = await runChild([process.execPath, 'dist/reset-password.mjs', '--email', 'ghost@smalltech.in'], childEnv({ NODE_ENV: 'production', BLOG0_NEW_ADMIN_PASSWORD: NEW }));
    expect(unknown.status).toBe(1);
  });

  it('the login delay of the email is cleared by the bundle too', async () => {
    for (let i = 0; i < 6; i += 1) {
      await login({ siteId: currentSite.id, email: EMAIL, password: 'wrong-password-000', ip: 'direct', userAgent: null }).catch((e: unknown) => {
        if (!(e instanceof ApiError)) throw e;
      });
    }
    expect((await signIn(OLD)).status).toBe(429);
    const r = await runChild([process.execPath, 'dist/reset-password.mjs', '--email', EMAIL], childEnv({ NODE_ENV: 'production', BLOG0_NEW_ADMIN_PASSWORD: NEW }));
    expect(r.status, r.stderr).toBe(0);
    expect((await signIn(NEW)).status).toBe(200);
  });
});
