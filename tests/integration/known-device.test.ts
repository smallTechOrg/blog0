// Stage C known-device sign-in (spec/architecture.md §6; capability admin-auth success criteria):
// an attacker who knows the admin email keeps the per-email delay active for unknown devices, but
// the owner's browser — holding a valid `blog0_device` cookie for THAT account — signs in at once.
// Real login service + routes on the real blog0_test Postgres, both throttle stores, injected `now`.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { issueKnownDevice, KNOWN_DEVICE_TTL_MS, verifyKnownDevice } from '@/server/auth/known-device';
import { login } from '@/server/auth/login';
import { getConfig, resetConfigForTests } from '@/server/config';
import { getDb } from '@/server/db/client';
import { appUser, rateLimitBucket, type SiteRow } from '@/server/db/schema';
import { ApiError } from '@/server/http/api';
import { MemoryRateLimitStore, type RateLimitStore } from '@/server/rate-window';
import { DbRateLimitStore, resetRateLimitStoreForTests } from '@/server/rate-window-store';
import { runResetPassword } from '@/server/ops/reset-password';
import { createAdmin } from '@/server/seed/admin';

import { resetDb } from '../helpers/db';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const EMAIL = 'sai@smalltech.in';
const OTHER_EMAIL = 'other@smalltech.in';
const PASSWORD = 'a-long-test-password-1';
const OTHER_PASSWORD = 'other-password-12345';
const WRONG = 'wrong-password-000';
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);

let currentSite: SiteRow;
let ownerId: string;
let otherId: string;
const savedHops = process.env.BLOG0_TRUSTED_PROXY_HOPS;

function setHops(value: string | undefined): void {
  if (value === undefined) delete process.env.BLOG0_TRUSTED_PROXY_HOPS;
  else process.env.BLOG0_TRUSTED_PROXY_HOPS = value;
  resetConfigForTests();
}

type Attempt = { ok: true; device: string } | { ok: false; code: string; retryAfter?: string };

async function attempt(password: string, now: number, opts: { device?: string | null; ip?: string; email?: string } = {}): Promise<Attempt> {
  try {
    const result = await login({
      siteId: currentSite.id,
      email: opts.email ?? EMAIL,
      password,
      ip: opts.ip ?? 'direct',
      userAgent: 'vitest',
      deviceCookie: opts.device ?? null,
      now: new Date(now),
    });
    return { ok: true, device: result.device.value };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { ok: false, code: error.code, retryAfter: error.headers?.['retry-after'] };
  }
}

/** The attacker (no device cookie) fails 20 times, always waiting exactly as long as required. */
async function hammer(start: number): Promise<number> {
  let now = start;
  let failures = 0;
  while (failures < 20) {
    const r = await attempt(WRONG, now);
    if (!r.ok && r.code === 'BAD_CREDENTIALS') failures += 1;
    else if (!r.ok) now += Number(r.retryAfter) * 1000;
    else throw new Error('the wrong password signed in');
  }
  return now;
}

beforeEach(async () => {
  currentSite = await resetDb();
  ownerId = (await createAdmin(getDb(), currentSite.id, { email: EMAIL, password: PASSWORD, displayName: 'Sai' })).userId;
  otherId = (await createAdmin(getDb(), currentSite.id, { email: OTHER_EMAIL, password: OTHER_PASSWORD, displayName: 'Other' })).userId;
  setHops(savedHops);
});

afterEach(() => setHops(savedHops));

afterAll(() => {
  resetRateLimitStoreForTests();
});

describe.each([
  ['memory', () => new MemoryRateLimitStore() as RateLimitStore],
  ['db', () => new DbRateLimitStore() as RateLimitStore],
])('known device skips the per-email delay — %s store', (_kind, makeStore) => {
  beforeEach(() => resetRateLimitStoreForTests(makeStore()));

  it('an attacker hammering the email keeps the delay for unknown devices; the owner with the cookie signs in immediately', async () => {
    const first = await attempt(PASSWORD, T0 - 60_000);
    if (!first.ok) throw new Error('owner could not sign in');
    const device = first.device;

    const now = await hammer(T0);
    // an unknown device (no cookie) is inside the delay even with the right password
    expect(await attempt(PASSWORD, now)).toMatchObject({ ok: false, code: 'RATE_LIMITED', retryAfter: '60' });
    // the owner's browser signs in right now
    const owner = await attempt(PASSWORD, now, { device });
    expect(owner.ok).toBe(true);
    // the owner's success does not hand the attacker a fresh set of free attempts
    expect(await attempt(WRONG, now + 1)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    // and a known-device typo does not lengthen the shared delay: unknown devices still wait ≤ 60 s
    expect(await attempt(WRONG, now + 2, { device })).toMatchObject({ ok: false, code: 'BAD_CREDENTIALS' });
    expect(await attempt(PASSWORD, now + 60_000)).toMatchObject({ ok: true });
  });

  it('a tampered, expired, other-user or not-for-this-email cookie is ignored (the delay applies)', async () => {
    const own = await attempt(PASSWORD, T0 - 60_000);
    const other = await attempt(OTHER_PASSWORD, T0 - 60_000, { email: OTHER_EMAIL });
    if (!own.ok || !other.ok) throw new Error('setup sign-in failed');
    const secret = getConfig().sessionSecret.reveal();
    const [v, user, deviceId, issued, sig] = own.device.split('.');
    const tampered = [v, user, deviceId, String(Number(issued) - 1), sig].join('.');
    const forged = issueKnownDevice(ownerId, new Date(T0 - 60_000), 'not-the-real-session-secret-0123456789').value;
    const old = issueKnownDevice(ownerId, new Date(T0 - KNOWN_DEVICE_TTL_MS - 1000), secret).value;

    const now = await hammer(T0);
    for (const device of [tampered, forged, old, other.device, 'garbage']) {
      expect(await attempt(PASSWORD, now, { device })).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    }
    // the genuine cookie still works
    expect(await attempt(PASSWORD, now, { device: own.device })).toMatchObject({ ok: true });
  });

  it('a known device has its own delay: 5 wrong passwords from it delay only that device', async () => {
    const first = await attempt(PASSWORD, T0 - 60_000);
    if (!first.ok) throw new Error('owner could not sign in');
    for (let i = 0; i < 5; i += 1) expect(await attempt(WRONG, T0, { device: first.device })).toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect(await attempt(PASSWORD, T0 + 500, { device: first.device })).toMatchObject({ ok: false, code: 'RATE_LIMITED', retryAfter: '1' });
    // the email's shared delay was not touched by those failures: an unknown device signs in
    expect(await attempt(PASSWORD, T0 + 500)).toMatchObject({ ok: true });
    expect(await attempt(PASSWORD, T0 + 1000, { device: first.device })).toMatchObject({ ok: true });
  });
});

describe('known device — caps, reset, routes', () => {
  beforeEach(() => resetRateLimitStoreForTests(new DbRateLimitStore()));

  it('the (email, real IP) pair cap still applies to a known device', async () => {
    setHops('1');
    const first = await attempt(PASSWORD, T0 - 60_000, { ip: '203.0.113.10' });
    if (!first.ok) throw new Error('owner could not sign in');
    for (let i = 0; i < 5; i += 1) {
      expect(await attempt(WRONG, T0 + i * 2000, { device: first.device, ip: '203.0.113.10' })).toMatchObject({ code: 'BAD_CREDENTIALS' });
    }
    expect(await attempt(PASSWORD, T0 + 60_000, { device: first.device, ip: '203.0.113.10' })).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });

  it('reset-password invalidates every known device of that user (devices_valid_after), not other users\'', async () => {
    const own = await attempt(PASSWORD, Date.now() - 60_000);
    const other = await attempt(OTHER_PASSWORD, Date.now() - 60_000, { email: OTHER_EMAIL });
    if (!own.ok || !other.ok) throw new Error('setup sign-in failed');

    await runResetPassword({ env: { BLOG0_DATABASE_URL: process.env.BLOG0_DATABASE_URL }, email: EMAIL, password: 'the-new-password-789', slug: 'blog0', out: () => {} });
    const [row] = await getDb().select().from(appUser).where(eq(appUser.id, ownerId));
    expect(row.devicesValidAfter).toBeInstanceOf(Date);
    const [otherRow] = await getDb().select().from(appUser).where(eq(appUser.id, otherId));
    expect(otherRow.devicesValidAfter).toBeNull();

    const now = await hammer(Date.now());
    expect(await attempt('the-new-password-789', now, { device: own.device })).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    // a device cookie issued after the reset is honoured again
    const fresh = await attempt('the-new-password-789', now + 60_000);
    if (!fresh.ok) throw new Error('sign-in after the wait failed');
    const later = await hammer(now + 120_000);
    expect(await attempt('the-new-password-789', later, { device: fresh.device })).toMatchObject({ ok: true });
  });

  it('the route sets blog0_device (HttpOnly, SameSite=Lax, 180 days) beside blog0_session, reads it back, and logout keeps it', async () => {
    const request = (password: string, cookie?: string) =>
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ email: EMAIL, password }),
      });

    const res = await loginRoute(request(PASSWORD), ctx);
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^blog0_session=/);
    expect(cookies[1]).toMatch(/^blog0_device=v1\.[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000; Expires=/);
    expect(cookies[1]).not.toContain('Secure');
    const sessionPair = cookies[0].split(';')[0];
    const devicePair = cookies[1].split(';')[0];
    expect(verifyKnownDevice(devicePair.slice('blog0_device='.length))?.userId).toBe(ownerId);

    // logout clears only the session cookie
    const out = await logoutRoute(
      new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: { origin: ORIGIN, host: 'localhost:3410', cookie: `${sessionPair}; ${devicePair}` } }),
      ctx,
    );
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()).toEqual([expect.stringMatching(/^blog0_session=; /)]);

    // attacker locks the email; the browser with the device cookie still signs in through the route
    for (let i = 0; i < 5; i += 1) expect((await loginRoute(request(WRONG), ctx)).status).toBe(401);
    expect((await loginRoute(request(PASSWORD), ctx)).status).toBe(429);
    const known = await loginRoute(request(PASSWORD, `blog0_session=stale; ${devicePair}`), ctx);
    expect(known.status).toBe(200);
    expect(await getDb().select().from(rateLimitBucket).where(eq(rateLimitBucket.scope, 'login.delay'))).toHaveLength(1);
  });

  it('with an https public base URL the device cookie is Secure', async () => {
    const previous = process.env.BLOG0_PUBLIC_BASE_URL;
    process.env.BLOG0_PUBLIC_BASE_URL = 'https://blog.example';
    resetConfigForTests();
    try {
      const res = await loginRoute(
        new Request('https://blog.example/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://blog.example', host: 'blog.example' },
          body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        }),
        ctx,
      );
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()[1].split('; ')).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Secure']));
    } finally {
      if (previous === undefined) delete process.env.BLOG0_PUBLIC_BASE_URL;
      else process.env.BLOG0_PUBLIC_BASE_URL = previous;
      resetConfigForTests();
    }
  });

  it('a failed sign-in sets no cookie at all', async () => {
    const res = await loginRoute(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410' },
        body: JSON.stringify({ email: EMAIL, password: WRONG }),
      }),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
