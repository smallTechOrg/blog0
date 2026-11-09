// Stage A login throttling (spec/roadmap.md → Launch polish item 8; spec/architecture.md §6;
// admin-auth.md + abuse-protection.md success criteria) through the real login service and route,
// on BOTH stores: the in-memory store and the Postgres-backed DbRateLimitStore (real blog0_test),
// plus the DB store on embedded PGlite. Injected `now`; `direct` client IP unless a test sets
// BLOG0_TRUSTED_PROXY_HOPS. Knowing the admin email must never lock the owner out.
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import type { LoginResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { login } from '@/server/auth/login';
import { LOGIN_DELAY_RESET_MS, LoginRateLimiter } from '@/server/auth/rate-limit';
import { resetConfigForTests } from '@/server/config';
import { closeDb, createDbHandle, getDb } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { rateLimitBucket, session, type SiteRow } from '@/server/db/schema';
import { ApiError } from '@/server/http/api';
import { MemoryRateLimitStore, type RateLimitStore } from '@/server/rate-window';
import { DbRateLimitStore, resetRateLimitStoreForTests, sha256Hex } from '@/server/rate-window-store';
import { createAdmin } from '@/server/seed/admin';
import { seedSite } from '@/server/seed/site';

import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const EMAIL = 'sai@smalltech.in';
const PASSWORD = 'a-long-test-password-1';
const WRONG = 'wrong-password-000';
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);

let currentSite: SiteRow;
const savedHops = process.env.BLOG0_TRUSTED_PROXY_HOPS;

function setHops(value: string | undefined): void {
  if (value === undefined) delete process.env.BLOG0_TRUSTED_PROXY_HOPS;
  else process.env.BLOG0_TRUSTED_PROXY_HOPS = value;
  resetConfigForTests();
}

type Attempt = { ok: true } | { ok: false; code: string; retryAfter?: string; details?: unknown };

async function attempt(password: string, now: number, ip = 'direct', email = EMAIL): Promise<Attempt> {
  try {
    await login({ siteId: currentSite.id, email, password, ip, userAgent: 'vitest', now: new Date(now) });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { ok: false, code: error.code, retryAfter: error.headers?.['retry-after'], details: error.details };
  }
}

async function delayRows() {
  return getDb().select().from(rateLimitBucket).where(eq(rateLimitBucket.scope, 'login.delay'));
}

beforeEach(async () => {
  currentSite = await resetDb();
  await createAdmin(getDb(), currentSite.id, { email: EMAIL, password: PASSWORD, displayName: 'Sai' });
  setHops(savedHops);
});

afterEach(() => setHops(savedHops));

afterAll(() => {
  resetRateLimitStoreForTests(); // back to the configured (memory) store for later files
});

describe.each([
  ['memory', () => new MemoryRateLimitStore() as RateLimitStore],
  ['db', () => new DbRateLimitStore() as RateLimitStore],
])('progressive per-email delay — %s store', (kind, makeStore) => {
  beforeEach(() => resetRateLimitStoreForTests(makeStore()));

  it('5 wrong at t=0 → t+0.5 s is 429 Retry-After 1 and not counted; the right password at t+1 s → 200', async () => {
    for (let i = 0; i < 5; i += 1) expect(await attempt(WRONG, T0)).toMatchObject({ ok: false, code: 'BAD_CREDENTIALS' });

    const early = await attempt(PASSWORD, T0 + 500);
    expect(early).toEqual({ ok: false, code: 'RATE_LIMITED', retryAfter: '1', details: { retryAfterSec: 1 } });
    if (kind === 'db') expect((await delayRows())[0].count).toBe(5);

    expect(await attempt(PASSWORD, T0 + 1000)).toEqual({ ok: true });
    if (kind === 'db') expect(await delayRows()).toHaveLength(0); // the success cleared it
  });

  it('wrong passwords spaced by their waits produce waits 1, 2, 4, 8, 16, 32, 60 s and stay at 60', async () => {
    let now = T0;
    for (let i = 0; i < 5; i += 1) await attempt(WRONG, now);
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const refused = await attempt(WRONG, now);
      expect(refused).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      const wait = Number((refused as { retryAfter: string }).retryAfter);
      waits.push(wait);
      now += wait * 1000;
      expect(await attempt(WRONG, now)).toMatchObject({ code: 'BAD_CREDENTIALS' });
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('an attacker hammering the admin email can\'t lock the owner out: after 20+ failures the owner signs in once the current wait passes', async () => {
    let now = T0;
    let failures = 0;
    while (failures < 20) {
      const r = await attempt(WRONG, now);
      if (r.ok === false && r.code === 'BAD_CREDENTIALS') failures += 1;
      else now += Number((r as { retryAfter: string }).retryAfter) * 1000; // the attacker waits exactly as long as needed
    }
    const refused = await attempt(PASSWORD, now);
    expect(refused).toMatchObject({ ok: false, code: 'RATE_LIMITED', retryAfter: '60' });

    expect(await attempt(PASSWORD, now + 60_000)).toEqual({ ok: true });
    // and the delay is gone for the owner afterwards
    expect(await attempt(PASSWORD, now + 60_001)).toEqual({ ok: true });
  });

  it('10 concurrent attempts after the 5th failure admit exactly 1 (the other 9 are 429 and not verified)', async () => {
    for (let i = 0; i < 5; i += 1) await attempt(WRONG, T0);

    const results = await Promise.all(Array.from({ length: 10 }, () => attempt(WRONG, T0 + 1000)));

    expect(results.filter((r) => !r.ok && r.code === 'BAD_CREDENTIALS')).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === 'RATE_LIMITED')).toHaveLength(9);
    if (kind === 'db') expect((await delayRows())[0].count).toBe(6);
  });

  it('after 15 quiet minutes the delay is gone', async () => {
    for (let i = 0; i < 8; i += 1) await attempt(WRONG, T0 + i * 20_000);
    const last = T0 + 7 * 20_000;
    expect(await attempt(WRONG, last + 1000)).toMatchObject({ code: 'RATE_LIMITED' });

    if (kind === 'db') {
      // the normal prune removes the idle row
      expect(await new DbRateLimitStore().prune(last + LOGIN_DELAY_RESET_MS)).toBe(1);
      expect(await delayRows()).toHaveLength(0);
    }
    for (let i = 0; i < 5; i += 1) expect(await attempt(WRONG, last + LOGIN_DELAY_RESET_MS)).toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect(await attempt(WRONG, last + LOGIN_DELAY_RESET_MS)).toMatchObject({ code: 'RATE_LIMITED', retryAfter: '1' });
  });
});

describe('DB store specifics', () => {
  beforeEach(() => resetRateLimitStoreForTests(new DbRateLimitStore()));

  it('one row per email: scope login.delay, window_start epoch 0, count = n, expires_at = last + 15 min, hashed key', async () => {
    await attempt(WRONG, T0);
    await attempt(WRONG, T0 + 2000, 'direct', 'Sai@SmallTech.in');

    const rows = await delayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ siteId: currentSite.id, count: 2, keyHash: sha256Hex(EMAIL) });
    expect(rows[0].windowStart.getTime()).toBe(0);
    expect(rows[0].expiresAt.getTime()).toBe(T0 + 2000 + LOGIN_DELAY_RESET_MS);
    expect(JSON.stringify(await getDb().select().from(rateLimitBucket))).not.toContain('smalltech');
  });

  it('the delay survives a restart (new pool, new store instance) and holds across instances', async () => {
    for (let i = 0; i < 5; i += 1) await attempt(WRONG, T0);

    await closeDb();
    resetRateLimitStoreForTests(new DbRateLimitStore());
    expect(await attempt(PASSWORD, T0 + 400)).toMatchObject({ code: 'RATE_LIMITED', retryAfter: '1' });

    const other = await createDbHandle({ engine: 'postgres', url: process.env.BLOG0_DATABASE_URL! }, { max: 2 });
    try {
      const elsewhere = new LoginRateLimiter(new DbRateLimitStore(other.db));
      expect(await elsewhere.attempt(currentSite.id, EMAIL, 'direct', T0 + 500)).toEqual({ limited: true, retryAfterSec: 1, scope: 'login.delay' });
    } finally {
      await other.close();
    }
    expect(await attempt(PASSWORD, T0 + 1000)).toEqual({ ok: true });
  });

  it('no direct-IP hard cap: login.pair / login.ip rows are never written for `direct`', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(WRONG, T0);
    const scopes = (await getDb().select().from(rateLimitBucket)).map((r) => r.scope);
    expect(scopes).toEqual(['login.delay']);
  });

  it('with a real IP: a correct password after 3 failures clears the pair row, leaves the IP count at 3 and clears the delay', async () => {
    for (let i = 0; i < 3; i += 1) await attempt(WRONG, T0 + i * 1000, '203.0.113.10');
    expect(await attempt(PASSWORD, T0 + 10_000, '203.0.113.10')).toEqual({ ok: true });

    const rows = await getDb().select().from(rateLimitBucket);
    expect(rows.filter((r) => r.scope === 'login.pair')).toHaveLength(0);
    expect(rows.find((r) => r.scope === 'login.ip')).toMatchObject({ count: 3, keyHash: sha256Hex('203.0.113.10') });
    expect(rows.filter((r) => r.scope === 'login.delay')).toHaveLength(0);
  });

  it('embedded PGlite (pglite://memory, after the migrations): the same delay sequence', async () => {
    const handle = await createDbHandle({ engine: 'pglite', dir: 'memory' });
    try {
      await runMigrations(handle);
      const { site } = await seedSite(handle.db, 'blog0');
      const limiter = new LoginRateLimiter(new DbRateLimitStore(handle.db));
      for (let i = 0; i < 5; i += 1) expect(await limiter.attempt(site.id, EMAIL, 'direct', T0)).toEqual({ limited: false });
      expect(await limiter.attempt(site.id, EMAIL, 'direct', T0 + 500)).toEqual({ limited: true, retryAfterSec: 1, scope: 'login.delay' });
      expect(await limiter.attempt(site.id, EMAIL, 'direct', T0 + 1000)).toEqual({ limited: false });
      await limiter.recordSuccess(site.id, EMAIL, 'direct', T0 + 1000);
      expect(await handle.db.select().from(rateLimitBucket).where(and(eq(rateLimitBucket.siteId, site.id), eq(rateLimitBucket.scope, 'login.delay')))).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

describe('the login route (real clock)', () => {
  beforeEach(() => resetRateLimitStoreForTests(new DbRateLimitStore()));

  const request = (password: string, ip?: string) =>
    new Request(`${ORIGIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', ...(ip ? { 'x-forwarded-for': ip } : {}) },
      body: JSON.stringify({ email: EMAIL, password }),
    });

  it('the 6th quick attempt → 429 with Retry-After 1, error.details.retryAfterSec 1, seconds copy and auth.login scope login.delay; the right password after the wait → 200', async () => {
    const logs = captureLogs();
    try {
      for (let i = 0; i < 5; i += 1) expect((await loginRoute(request(WRONG), ctx)).status).toBe(401);
      const sixth = await loginRoute(request(PASSWORD), ctx);
      expect(sixth.status).toBe(429);
      expect(sixth.headers.get('retry-after')).toBe('1');
      expect(sixth.headers.get('set-cookie')).toBeNull();
      const body = (await sixth.json()) as Envelope<LoginResponse>;
      if (body.ok) throw new Error('expected an error');
      expect(body.error).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many attempts — try again in 1 second.', details: { retryAfterSec: 1 } });
      expect(logs.find('auth.login').at(-1)).toMatchObject({ outcome: 'rate_limited', scope: 'login.delay', email_masked: 's***@smalltech.in' });

      await new Promise((r) => setTimeout(r, 1100));
      const owner = await loginRoute(request(PASSWORD), ctx);
      expect(owner.status).toBe(200);
      expect(await getDb().select().from(session)).toHaveLength(1);
    } finally {
      logs.stop();
    }
  });

  it('behind a trusted proxy: the 6th failure of one (email, IP) → 429 login.pair (minutes); the same email from another IP is only delayed', async () => {
    setHops('1');
    const logs = captureLogs();
    try {
      for (let i = 0; i < 5; i += 1) expect((await loginRoute(request(WRONG, '203.0.113.10'), ctx)).status).toBe(401);
      const sameIp = await loginRoute(request(PASSWORD, '203.0.113.10'), ctx);
      expect(sameIp.status).toBe(429);
      // The pair cap uses a fixed 15-min clock window (DB store), so the wait is whatever is left of it:
      // anywhere from 1 s (right before the boundary) to 900 s — never a short per-email delay scope.
      const pairWait = Number(sameIp.headers.get('retry-after'));
      expect(pairWait).toBeGreaterThanOrEqual(1);
      expect(pairWait).toBeLessThanOrEqual(900);
      expect(logs.find('auth.login').at(-1)).toMatchObject({ outcome: 'rate_limited', scope: 'login.pair' });

      const otherIp = await loginRoute(request(PASSWORD, '198.51.100.7'), ctx);
      expect([200, 429]).toContain(otherIp.status); // 200 when ≥ 1 s passed since the 5th failure
      if (otherIp.status === 429) {
        expect(otherIp.headers.get('retry-after')).toBe('1');
        await new Promise((r) => setTimeout(r, 1100));
        expect((await loginRoute(request(PASSWORD, '198.51.100.7'), ctx)).status).toBe(200);
      }
    } finally {
      logs.stop();
    }
  });
});
