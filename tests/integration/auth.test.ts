import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { eq, sql as dsql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import type { LoginResponse, LogoutResponse, MeResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { BAD_CREDENTIALS_MESSAGE } from '@/server/auth/login';
import { hashPassword } from '@/server/auth/password';
import { resetLoginRateLimiterForTests } from '@/server/auth/rate-limit';
import { hashSessionToken, SESSION_SLIDE_AFTER_MS, SESSION_TTL_MS } from '@/server/auth/session';
import { getDb } from '@/server/db/client';
import { ALL_TABLE_NAMES, appUser, session, site } from '@/server/db/schema';
import { createAdmin, seedAdmin, SeedError } from '@/server/seed/admin';
import { seedSite } from '@/server/seed/site';
import { resetConfigForTests } from '@/server/config';
import { resetCurrentSiteForTests } from '@/server/site/current';

import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const PASSWORD = 'a-long-test-password-1';
const EMAIL = 'sai@smalltech.in';

function loginRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      host: 'localhost:3410',
      'x-forwarded-for': '203.0.113.10',
      'user-agent': 'vitest-auth',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function logoutRequest(cookie: string | null, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { origin: ORIGIN, host: 'localhost:3410', ...headers };
  if (cookie) h.cookie = cookie;
  return new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: h });
}

function meRequest(cookie: string | null): Request {
  return new Request(`${ORIGIN}/api/auth/me`, { headers: cookie ? { cookie } : {} });
}

async function createUserWithPassword(email: string, password: string, displayName = 'Sai Krishna V'): Promise<string> {
  const db = getDb();
  const [s] = await db.select().from(site).limit(1);
  const created = await createAdmin(db, s.id, { email, password, displayName });
  return created.userId;
}

function cookiePair(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0];
}

async function json<T>(response: Response): Promise<Envelope<T>> {
  return (await response.json()) as Envelope<T>;
}

function scriptEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // BLOG0_DATABASE_URL already points at blog0_test (tests/setup/integration-env.ts).
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.BLOG0_ADMIN_EMAIL;
  delete env.BLOG0_ADMIN_PASSWORD;
  delete env.BLOG0_ADMIN_NAME;
  delete env.BLOG0_NEW_ADMIN_PASSWORD;
  return { ...env, ...extra };
}

async function runScript(
  script: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      env: scriptEnv(extraEnv),
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** BLOG0_TRUSTED_PROXY_HOPS for the next requests (undefined = unset → default 0). */
function setTrustedProxyHops(value: string | undefined): void {
  if (value === undefined) delete process.env.BLOG0_TRUSTED_PROXY_HOPS;
  else process.env.BLOG0_TRUSTED_PROXY_HOPS = value;
  resetConfigForTests();
}

async function truncateEverything(): Promise<void> {
  await getDb().execute(dsql.raw(`truncate table ${ALL_TABLE_NAMES.map((t) => `"${t}"`).join(', ')} restart identity cascade`));
  resetCurrentSiteForTests();
}

describe('admin auth', () => {
  let logs: CapturedLogs;

  beforeEach(async () => {
    await resetDb();
    setTrustedProxyHops(undefined);
    resetLoginRateLimiterForTests();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.stop();
    setTrustedProxyHops(undefined);
  });

  describe('POST /api/auth/login', () => {
    it('returns the user, sets an httpOnly SameSite=Lax cookie and stores only a hash of the token', async () => {
      const userId = await createUserWithPassword(EMAIL, PASSWORD);

      const response = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      const body = await json<LoginResponse>(response);

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true, data: { user: { id: userId, email: EMAIL, displayName: 'Sai Krishna V' } } });
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/^blog0_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
      expect(setCookie).not.toContain('Secure');
      const token = cookiePair(response).split('=')[1];
      const rows = await getDb().select().from(session).where(eq(session.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(hashSessionToken(token));
      expect(rows[0].tokenHash).not.toContain(token);
      // No trusted proxy by default: the client-supplied x-forwarded-for is not stored as the IP.
      expect(rows[0]).toMatchObject({ ip: null, userAgent: 'vitest-auth' });
      const [user] = await getDb().select().from(appUser).where(eq(appUser.id, userId));
      expect(user.lastLoginAt).toBeInstanceOf(Date);
      const raw = await getDb().execute(dsql`select count(*)::int as n from session where token_hash = ${token}`);
      expect((raw as unknown as Array<{ n: number }>)[0].n).toBe(0);
    });

    it('with an https BLOG0_PUBLIC_BASE_URL the session cookie is Secure', async () => {
      const previous = process.env.BLOG0_PUBLIC_BASE_URL;
      process.env.BLOG0_PUBLIC_BASE_URL = 'https://blog.example';
      resetConfigForTests();
      try {
        await createUserWithPassword(EMAIL, PASSWORD);
        const response = await loginRoute(
          loginRequest({ email: EMAIL, password: PASSWORD }, { origin: 'https://blog.example', host: 'blog.example' }),
          ctx,
        );
        expect(response.status).toBe(200);
        const setCookie = response.headers.get('set-cookie') ?? '';
        expect(setCookie).toMatch(/^blog0_session=[A-Za-z0-9_-]{43}; /);
        expect(setCookie.split('; ')).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Secure']));
      } finally {
        if (previous === undefined) delete process.env.BLOG0_PUBLIC_BASE_URL;
        else process.env.BLOG0_PUBLIC_BASE_URL = previous;
        resetConfigForTests();
      }
    });

    it('signs in with a differently-cased, padded email and the session works on the next request', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);

      const response = await loginRoute(loginRequest({ email: '  SAI@SmallTech.IN ', password: PASSWORD }), ctx);
      const me = await meRoute(meRequest(cookiePair(response)), ctx);

      expect(response.status).toBe(200);
      expect(me.status).toBe(200);
      const meBody = await json<MeResponse>(me);
      expect(meBody.ok && meBody.data.user.email).toBe(EMAIL);
    });

    it('answers wrong password and unknown email with the identical 401 BAD_CREDENTIALS', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);

      const wrongPassword = await loginRoute(loginRequest({ email: EMAIL, password: 'not-the-password-123' }), ctx);
      const unknownEmail = await loginRoute(loginRequest({ email: 'nobody@smalltech.in', password: PASSWORD }), ctx);

      const a = await json<LoginResponse>(wrongPassword);
      const b = await json<LoginResponse>(unknownEmail);
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      if (a.ok || b.ok) throw new Error('expected errors');
      expect(a.error.code).toBe('BAD_CREDENTIALS');
      expect(b.error.code).toBe('BAD_CREDENTIALS');
      expect(a.error.message).toBe(BAD_CREDENTIALS_MESSAGE);
      expect(b.error.message).toBe(a.error.message);
      expect(a.error.message).toBe('Email or password is incorrect.');
      expect(wrongPassword.headers.get('set-cookie')).toBeNull();
      expect(await getDb().select().from(session)).toHaveLength(0);
    });

    it('refuses a disabled user with the same BAD_CREDENTIALS answer', async () => {
      const userId = await createUserWithPassword(EMAIL, PASSWORD);
      await getDb().update(appUser).set({ disabledAt: new Date() }).where(eq(appUser.id, userId));

      const response = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);

      expect(response.status).toBe(401);
      const body = await json<LoginResponse>(response);
      expect(!body.ok && body.error.message).toBe(BAD_CREDENTIALS_MESSAGE);
    });

    it('returns 429 RATE_LIMITED with Retry-After on the 6th failure and refuses even the right password', async () => {
      setTrustedProxyHops('1');
      await createUserWithPassword(EMAIL, PASSWORD);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await loginRoute(loginRequest({ email: EMAIL, password: `wrong-password-${i}xx` }), ctx)).status);
      }

      const sixth = await loginRoute(loginRequest({ email: EMAIL, password: 'wrong-password-6xx' }), ctx);
      const correct = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      const otherIp = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }, { 'x-forwarded-for': '198.51.100.7' }), ctx);

      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      expect(sixth.status).toBe(429);
      const retryAfter = Number(sixth.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(14 * 60);
      expect(retryAfter).toBeLessThanOrEqual(15 * 60);
      const sixthBody = await json<LoginResponse>(sixth);
      if (sixthBody.ok) throw new Error('expected error');
      expect(sixthBody.error.code).toBe('RATE_LIMITED');
      expect(sixthBody.error.message).toBe('Too many attempts — try again in 15 minutes.');
      expect(correct.status).toBe(429);
      expect(correct.headers.get('set-cookie')).toBeNull();
      expect(otherIp.status).toBe(200);
    });

    it('counts concurrent wrong attempts before verifying: 10 in parallel → exactly 5 BAD_CREDENTIALS + 5 RATE_LIMITED', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) => loginRoute(loginRequest({ email: EMAIL, password: `wrong-password-${i}xx` }), ctx)),
      );
      const codes = await Promise.all(
        responses.map(async (r) => {
          const body = await json<LoginResponse>(r);
          return body.ok ? 'OK' : body.error.code;
        }),
      );

      expect(codes.filter((c) => c === 'BAD_CREDENTIALS')).toHaveLength(5);
      expect(codes.filter((c) => c === 'RATE_LIMITED')).toHaveLength(5);
      const correct = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      expect(correct.status).toBe(429);
    });

    it('with no trusted proxy (default) a spoofed x-forwarded-for / x-real-ip cannot dodge the limit', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const spoof = { 'x-forwarded-for': `198.51.100.${i}`, 'x-real-ip': `192.0.2.${i}` };
        statuses.push((await loginRoute(loginRequest({ email: EMAIL, password: `wrong-password-${i}xx` }, spoof), ctx)).status);
      }

      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('behind one trusted proxy, only the proxy-appended hop counts — a spoofed left entry does not reset the limit', async () => {
      setTrustedProxyHops('1');
      await createUserWithPassword(EMAIL, PASSWORD);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const spoof = { 'x-forwarded-for': `10.9.9.${i}, 203.0.113.10` };
        statuses.push((await loginRoute(loginRequest({ email: EMAIL, password: `wrong-password-${i}xx` }, spoof), ctx)).status);
      }

      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('caps failures per email across rotating IPs (20 per 15 min) even behind a trusted proxy', async () => {
      setTrustedProxyHops('1');
      await createUserWithPassword(EMAIL, PASSWORD);
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        const ip = { 'x-forwarded-for': `198.51.100.${i + 1}` };
        statuses.push((await loginRoute(loginRequest({ email: EMAIL, password: `wrong-password-${i}xx` }, ip), ctx)).status);
      }
      const correctFromFreshIp = await loginRoute(
        loginRequest({ email: EMAIL, password: PASSWORD }, { 'x-forwarded-for': '198.51.100.200' }),
        ctx,
      );
      const otherAccount = await loginRoute(
        loginRequest({ email: 'nobody@smalltech.in', password: PASSWORD }, { 'x-forwarded-for': '198.51.100.201' }),
        ctx,
      );

      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(statuses[20]).toBe(429);
      expect(correctFromFreshIp.status).toBe(429);
      expect(Number(correctFromFreshIp.headers.get('retry-after'))).toBeGreaterThan(14 * 60);
      expect(otherAccount.status).toBe(401);
    });

    it('rejects invalid bodies with 400 VALIDATION_FAILED and a cross-site POST with 403 FORBIDDEN_ORIGIN', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);

      const notAnEmail = await loginRoute(loginRequest({ email: 'not-an-email', password: PASSWORD }), ctx);
      const missingPassword = await loginRoute(loginRequest({ email: EMAIL }), ctx);
      const tooLong = await loginRoute(loginRequest({ email: EMAIL, password: 'x'.repeat(201) }), ctx);
      const malformed = await loginRoute(loginRequest('{"email":'), ctx);
      const crossSite = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }, { origin: 'https://evil.example' }), ctx);

      expect([notAnEmail.status, missingPassword.status, tooLong.status, malformed.status]).toEqual([400, 400, 400, 400]);
      const body = await json<LoginResponse>(missingPassword);
      expect(!body.ok && body.error.code).toBe('VALIDATION_FAILED');
      expect(crossSite.status).toBe(403);
      const crossBody = await json<LoginResponse>(crossSite);
      expect(!crossBody.ok && crossBody.error.code).toBe('FORBIDDEN_ORIGIN');
      expect(await getDb().select().from(session)).toHaveLength(0);
    });

    it('emits one auth.login line per attempt with outcome and a masked email, never the password', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);

      await loginRoute(loginRequest({ email: EMAIL, password: 'wrong-password-zz' }), ctx);
      await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      for (let i = 0; i < 5; i += 1) {
        await loginRoute(loginRequest({ email: 'ghost@smalltech.in', password: 'wrong-password-zz' }), ctx);
      }

      const lines = logs.find('auth.login');
      expect(lines.map((l) => l.outcome)).toEqual([
        'bad_credentials',
        'ok',
        'bad_credentials',
        'bad_credentials',
        'bad_credentials',
        'bad_credentials',
        'bad_credentials',
      ]);
      await loginRoute(loginRequest({ email: 'ghost@smalltech.in', password: 'wrong-password-zz' }), ctx);
      expect(logs.find('auth.login').at(-1)).toMatchObject({ outcome: 'rate_limited', email_masked: 'g***@smalltech.in' });
      expect(lines[1]).toMatchObject({ level: 'info', email_masked: 's***@smalltech.in' });
      const everything = JSON.stringify(logs.lines);
      expect(everything).not.toContain(PASSWORD);
      expect(everything).not.toContain('wrong-password-zz');
      expect(everything).not.toContain(EMAIL);
      expect(logs.find('api.request').find((l) => l.status === 200)?.input_summary).toEqual({ email_masked: 's***@smalltech.in' });
    });
  });

  describe('session lifecycle', () => {
    it('GET /api/auth/me answers 401 UNAUTHENTICATED without a cookie', async () => {
      const response = await meRoute(meRequest(null), ctx);

      expect(response.status).toBe(401);
      const body = await json<MeResponse>(response);
      expect(!body.ok && body.error.code).toBe('UNAUTHENTICATED');
    });

    it('logout ends only the current session; the old cookie is rejected afterwards', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);
      const first = cookiePair(await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx));
      const second = cookiePair(await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx));

      const out = await logoutRoute(logoutRequest(first), ctx);
      const meFirst = await meRoute(meRequest(first), ctx);
      const meFirstAgain = await meRoute(meRequest(first), ctx);
      const meSecond = await meRoute(meRequest(second), ctx);

      expect(out.status).toBe(200);
      expect(await json<LogoutResponse>(out)).toEqual({ ok: true, data: { signedOut: true } });
      expect(out.headers.get('set-cookie')).toMatch(/^blog0_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
      expect(meFirst.status).toBe(401);
      expect(meFirstAgain.status).toBe(401);
      expect(meSecond.status).toBe(200);
      expect(await getDb().select().from(session)).toHaveLength(1);
    });

    it('logout succeeds without a session but refuses a cross-site POST', async () => {
      const anonymous = await logoutRoute(logoutRequest(null), ctx);
      const stale = await logoutRoute(logoutRequest('blog0_session=not-a-real-token'), ctx);
      const crossSite = await logoutRoute(logoutRequest(null, { origin: 'https://evil.example' }), ctx);

      expect(anonymous.status).toBe(200);
      expect(stale.status).toBe(200);
      expect(crossSite.status).toBe(403);
      const body = await json<LogoutResponse>(crossSite);
      expect(!body.ok && body.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('extends expires_at and re-sends the cookie when the session is used more than 24 h after last_seen_at', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);
      const cookie = cookiePair(await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx));
      const past = new Date(Date.now() - SESSION_SLIDE_AFTER_MS - 60 * 60 * 1000);
      await getDb()
        .update(session)
        .set({ createdAt: past, lastSeenAt: past, expiresAt: new Date(past.getTime() + SESSION_TTL_MS) });

      const before = Date.now();
      const response = await meRoute(meRequest(cookie), ctx);
      const again = await meRoute(meRequest(cookie), ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toMatch(/^blog0_session=.+; Max-Age=2592000/);
      const [row] = await getDb().select().from(session);
      expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
      expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(again.status).toBe(200);
      expect(again.headers.get('set-cookie')).toBeNull();
    });

    it('purges expired sessions lazily at login', async () => {
      const userId = await createUserWithPassword(EMAIL, PASSWORD);
      await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      await getDb().update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.userId, userId));

      await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);

      const rows = await getDb().select().from(session);
      expect(rows).toHaveLength(1);
      expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('seeding', () => {
    it('seeds site and admin once; a second run changes nothing and leaves the password alone', async () => {
      await truncateEverything();
      const db = getDb();

      const site1 = await seedSite(db, 'blog0');
      const admin1 = await seedAdmin(db, site1.site.id, { email: 'Sai@SmallTech.in', password: PASSWORD, displayName: 'Sai Krishna V' });
      const [hashBefore] = await db.select({ h: appUser.passwordHash, u: appUser.updatedAt }).from(appUser);
      const site2 = await seedSite(db, 'blog0');
      const admin2 = await seedAdmin(db, site2.site.id, { email: EMAIL, password: 'a-different-password-9', displayName: 'Other Name' });
      const [hashAfter] = await db.select({ h: appUser.passwordHash, u: appUser.updatedAt, n: appUser.displayName }).from(appUser);

      expect([site1.status, admin1.status]).toEqual(['created', 'created']);
      expect([site2.status, admin2.status]).toEqual(['ok', 'ok']);
      expect(site2.site.id).toBe(site1.site.id);
      expect(admin1.email).toBe(EMAIL);
      expect(hashAfter.h).toBe(hashBefore.h);
      expect(hashAfter.n).toBe('Sai Krishna V');
      expect(await db.select().from(site)).toHaveLength(1);
      expect(await db.select().from(appUser)).toHaveLength(1);
      const signIn = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      expect(signIn.status).toBe(200);
    });

    it('resets the admin password only when asked', async () => {
      const [s] = await getDb().select().from(site);
      await seedAdmin(getDb(), s.id, { email: EMAIL, password: PASSWORD, displayName: 'Sai Krishna V' });

      const reset = await seedAdmin(getDb(), s.id, { email: EMAIL, password: 'the-new-password-42', displayName: 'Sai Krishna V' }, { resetPassword: true });
      const oldPw = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      const newPw = await loginRoute(loginRequest({ email: EMAIL, password: 'the-new-password-42' }), ctx);

      expect(reset.status).toBe('password_reset');
      expect(oldPw.status).toBe(401);
      expect(newPw.status).toBe(200);
    });

    it('createAdmin refuses an email that already exists', async () => {
      await createUserWithPassword(EMAIL, PASSWORD);
      const [s] = await getDb().select().from(site);

      const attempt = createAdmin(getDb(), s.id, { email: 'SAI@smalltech.in', password: PASSWORD, displayName: 'Dup' });

      await expect(attempt).rejects.toBeInstanceOf(SeedError);
      await expect(attempt).rejects.toThrow(/already exists/);
    });

    it('pnpm db:seed creates site + admin on an empty DB, prints "ok" for both on re-run and masks the email', async () => {
      await truncateEverything();
      const env = { BLOG0_ADMIN_EMAIL: EMAIL, BLOG0_ADMIN_PASSWORD: PASSWORD, BLOG0_ADMIN_NAME: 'Sai Krishna V' };

      const first = await runScript('db-seed.ts', [], env);
      const second = await runScript('db-seed.ts', [], env);

      expect(first.code).toBe(0);
      expect(first.stdout.trim()).toBe('site blog0 ok (created), admin s***@smalltech.in ok (created)');
      expect(second.code).toBe(0);
      expect(second.stdout.trim()).toBe('site blog0 ok, admin s***@smalltech.in ok');
      expect(first.stdout + second.stdout + first.stderr + second.stderr).not.toContain(PASSWORD);
      expect(first.stdout + second.stdout).not.toContain(EMAIL);
      resetCurrentSiteForTests();
      const signIn = await loginRoute(loginRequest({ email: EMAIL, password: PASSWORD }), ctx);
      expect(signIn.status).toBe(200);
    });

    it('pnpm db:seed refuses (exit 1) a short password, the .env.example placeholder or a missing email without writing anything', async () => {
      await truncateEverything();

      const shortPassword = await runScript('db-seed.ts', [], { BLOG0_ADMIN_EMAIL: EMAIL, BLOG0_ADMIN_PASSWORD: 'short-pw' });
      const placeholder = await runScript('db-seed.ts', [], {
        BLOG0_ADMIN_EMAIL: EMAIL,
        BLOG0_ADMIN_PASSWORD: 'replace-with-a-12-plus-char-password',
      });
      const missingEmail = await runScript('db-seed.ts', [], { BLOG0_ADMIN_PASSWORD: PASSWORD });

      expect(placeholder.code).toBe(1);
      expect(placeholder.stderr).toMatch(/BLOG0_ADMIN_PASSWORD still holds the \.env\.example placeholder/);
      expect(placeholder.stderr).not.toContain('a-12-plus-char');

      expect(shortPassword.code).toBe(1);
      expect(shortPassword.stderr).toMatch(/BLOG0_ADMIN_PASSWORD: Password must be at least 12 characters/);
      expect(shortPassword.stderr).not.toContain('short-pw');
      expect(missingEmail.code).toBe(1);
      expect(missingEmail.stderr).toMatch(/BLOG0_ADMIN_EMAIL is missing/);
      expect(await getDb().select().from(site)).toHaveLength(0);
    });

    it('pnpm db:seed hashes the password exactly as given, so sign-in with the same (padded) value works', async () => {
      await truncateEverything();
      const padded = '  padded-password-12 ';

      const seeded = await runScript('db-seed.ts', [], { BLOG0_ADMIN_EMAIL: EMAIL, BLOG0_ADMIN_PASSWORD: padded });
      resetCurrentSiteForTests();
      const signIn = await loginRoute(loginRequest({ email: EMAIL, password: padded }), ctx);

      expect(seeded.code).toBe(0);
      expect(signIn.status).toBe(200);
    });

    it('pnpm admin:create adds a second admin who can sign in; a duplicate exits 1', async () => {
      const env = { BLOG0_NEW_ADMIN_PASSWORD: 'b-writer-password-1' };

      const created = await runScript('create-admin.ts', ['--email', 'b@smalltech.in', '--name', 'B Writer'], env);
      const duplicate = await runScript('create-admin.ts', ['--email', 'B@smalltech.in', '--name', 'B Again'], env);
      const noPassword = await runScript('create-admin.ts', ['--email', 'c@smalltech.in', '--name', 'C Writer'], {});
      const signIn = await loginRoute(loginRequest({ email: 'b@smalltech.in', password: 'b-writer-password-1' }), ctx);

      expect(created.code).toBe(0);
      expect(created.stdout.trim()).toBe('admin b***@smalltech.in (B Writer) created');
      expect(created.stdout).not.toContain('b-writer-password-1');
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toMatch(/already exists/);
      expect(noPassword.code).toBe(1);
      expect(noPassword.stderr).toMatch(/BLOG0_NEW_ADMIN_PASSWORD/);
      expect(signIn.status).toBe(200);
      const body = await json<LoginResponse>(signIn);
      expect(body.ok && body.data.user.displayName).toBe('B Writer');
    });
  });

  it('hashPassword output is what the seed stores (argon2id PHC)', async () => {
    await createUserWithPassword(EMAIL, PASSWORD);

    const [row] = await getDb().select({ h: appUser.passwordHash }).from(appUser);

    expect(row.h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(row.h).not.toBe(await hashPassword(PASSWORD));
  });
});
