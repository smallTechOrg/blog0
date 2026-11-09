// Capability abuse-protection: the Postgres-backed throttle store (DbRateLimitStore) against the real
// blog0_test database — atomic check-and-count under concurrency (also across two "instances" with
// separate pools), persistence across a simulated restart, fixed-window expiry, refund/clear, prune,
// hashed keys, fail-closed errors — plus the same sequence on embedded PGlite after the migrations.
// Every other integration file runs the throttles on the memory store (tests/setup/integration-env.ts);
// this file opts in with resetRateLimitStoreForTests(new DbRateLimitStore()).
import { and, eq, sql as dsql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as newsletterRoute } from '@/app/api/newsletter/route';
import type { Envelope } from '@/lib/api/envelope';
import { login } from '@/server/auth/login';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, loginBuckets, resetLoginRateLimiterForTests } from '@/server/auth/rate-limit';
import { resetConfigForTests } from '@/server/config';
import { closeDb, createDbHandle, getDb, type DbHandle } from '@/server/db/client';
import { runMigrations } from '@/server/db/migrate';
import { rateLimitBucket, type SiteRow } from '@/server/db/schema';
import { ApiError } from '@/server/http/api';
import { NEWSLETTER_MAX_PER_EMAIL, NEWSLETTER_WINDOW_MS, resetNewsletterRateLimiterForTests } from '@/server/newsletter/rate-limit';
import type { RateBucket } from '@/server/rate-window';
import { DbRateLimitStore, getRateLimitStore, resetRateLimitStoreForTests, sha256Hex } from '@/server/rate-window-store';
import { createAdmin } from '@/server/seed/admin';
import { seedSite } from '@/server/seed/site';

import { resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logs';

const ORIGIN = 'http://localhost:3410';
const ctx = { params: Promise.resolve({}) };
const EMAIL = 'sai@smalltech.in';
const PASSWORD = 'a-long-test-password-1';
/** Aligned to a 15-minute (and hourly) boundary. */
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);
const BUCKET: RateBucket = { scope: 'login.pair', key: `${EMAIL}\u0000203.0.113.10`, max: 5, windowMs: LOGIN_WINDOW_MS };

let currentSite: SiteRow;
const savedHops = process.env.BLOG0_TRUSTED_PROXY_HOPS;

function setHops(value: string | undefined): void {
  if (value === undefined) delete process.env.BLOG0_TRUSTED_PROXY_HOPS;
  else process.env.BLOG0_TRUSTED_PROXY_HOPS = value;
  resetConfigForTests();
}

async function bucketRows(scope?: string) {
  const rows = await getDb().select().from(rateLimitBucket);
  return scope ? rows.filter((r) => r.scope === scope) : rows;
}

async function attemptLogin(password: string, now: number, ip = 'direct') {
  try {
    await login({ siteId: currentSite.id, email: EMAIL, password, ip, userAgent: 'vitest', now: new Date(now) });
    return { ok: true as const };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { ok: false as const, code: error.code, status: error.status, retryAfter: error.headers?.['retry-after'] };
  }
}

beforeEach(async () => {
  currentSite = await resetDb();
  resetRateLimitStoreForTests(new DbRateLimitStore());
  resetNewsletterRateLimiterForTests();
  setHops(savedHops);
});

afterEach(() => {
  setHops(savedHops);
});

afterAll(() => {
  resetRateLimitStoreForTests(); // back to the configured (memory) store for later files
});

describe('DbRateLimitStore — atomic check-and-count', () => {
  it('the test opted in: the process store is the database store, and the reset helpers keep it', () => {
    resetLoginRateLimiterForTests();
    resetNewsletterRateLimiterForTests();
    expect(getRateLimitStore().kind).toBe('db');
  });

  it('20 concurrent attempts on a 5-cap bucket admit exactly 5; the row count is 5', async () => {
    const store = new DbRateLimitStore();

    const results = await Promise.all(Array.from({ length: 20 }, () => store.attempt(currentSite.id, [BUCKET], T0 + 1000)));

    expect(results.filter((r) => !r.limited)).toHaveLength(5);
    expect(results.filter((r) => r.limited)).toHaveLength(15);
    const rows = await bucketRows('login.pair');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ siteId: currentSite.id, count: 5, keyHash: sha256Hex(BUCKET.key) });
    expect(rows[0].windowStart.getTime()).toBe(T0);
    expect(rows[0].expiresAt.getTime()).toBe(T0 + LOGIN_WINDOW_MS);
  });

  it('two instances with separate connection pools share one cap (multi-bucket, concurrent)', async () => {
    const other: DbHandle = await createDbHandle({ engine: 'postgres', url: process.env.BLOG0_DATABASE_URL! }, { max: 5 });
    try {
      const a = new DbRateLimitStore();
      const b = new DbRateLimitStore(other.db);
      const buckets = loginBuckets(EMAIL, '203.0.113.10');

      const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? a : b).attempt(currentSite.id, buckets, T0 + 2000)),
      );

      expect(results.filter((r) => !r.limited)).toHaveLength(LOGIN_MAX_FAILURES);
      const limited = results.filter((r) => r.limited);
      expect(limited.every((r) => r.limited && r.scope === 'login.pair' && r.retryAfterSec === LOGIN_WINDOW_MS / 1000 - 2)).toBe(true);
      expect((await bucketRows('login.pair'))[0].count).toBe(LOGIN_MAX_FAILURES);
      expect((await bucketRows('login.ip'))[0].count).toBe(LOGIN_MAX_FAILURES);
    } finally {
      await other.close();
    }
  });

  it('a refusal in one bucket counts in none (the others stay put)', async () => {
    const store = new DbRateLimitStore();
    const tight: RateBucket = { scope: 'newsletter.email', key: 'a@b.io', max: 1, windowMs: NEWSLETTER_WINDOW_MS };
    const loose: RateBucket = { scope: 'newsletter.site', key: currentSite.id, max: 100, windowMs: NEWSLETTER_WINDOW_MS };

    expect(await store.attempt(currentSite.id, [tight, loose], T0)).toEqual({ limited: false });
    expect(await store.attempt(currentSite.id, [tight, loose], T0 + 60_000)).toEqual({
      limited: true,
      retryAfterSec: NEWSLETTER_WINDOW_MS / 1000 - 60,
      scope: 'newsletter.email',
    });
    expect((await bucketRows('newsletter.site'))[0].count).toBe(1);
  });

  it('refund never goes below zero; clear removes only the current window; an empty bucket list is allowed', async () => {
    const store = new DbRateLimitStore();
    await store.refund(currentSite.id, BUCKET, T0); // missing → no-op
    expect(await bucketRows()).toHaveLength(0);

    await store.attempt(currentSite.id, [BUCKET], T0);
    await store.refund(currentSite.id, BUCKET, T0);
    await store.refund(currentSite.id, BUCKET, T0);
    expect((await bucketRows())[0].count).toBe(0);

    await store.attempt(currentSite.id, [BUCKET], T0 + LOGIN_WINDOW_MS); // next window (the expired T0 row is pruned in passing)
    await store.clear(currentSite.id, BUCKET, T0); // another window → the current one is untouched
    expect((await bucketRows()).map((r) => [r.windowStart.getTime(), r.count])).toEqual([[T0 + LOGIN_WINDOW_MS, 1]]);
    await store.clear(currentSite.id, BUCKET, T0 + LOGIN_WINDOW_MS + 5000);
    expect(await bucketRows()).toHaveLength(0);

    expect(await store.attempt(currentSite.id, [], T0)).toEqual({ limited: false });
  });
});

describe('login on the database store', () => {
  beforeEach(async () => {
    await createAdmin(getDb(), currentSite.id, { email: EMAIL, password: PASSWORD, displayName: 'Sai' });
  });

  it('Stage A: 5 wrong passwords → an immediate 6th is 429 Retry-After 1; still 429 after a restart (new store, new pool); admitted at +1 s', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      expect(await attemptLogin('wrong-password-000', T0)).toMatchObject({ ok: false, code: 'BAD_CREDENTIALS' });
    }
    expect(await attemptLogin(PASSWORD, T0 + 100)).toEqual({ ok: false, code: 'RATE_LIMITED', status: 429, retryAfter: '1' });

    // simulated restart: a fresh pool and a fresh store instance — the delay is in the database
    await closeDb();
    resetRateLimitStoreForTests(new DbRateLimitStore());
    expect(await attemptLogin(PASSWORD, T0 + 500)).toMatchObject({ ok: false, code: 'RATE_LIMITED', retryAfter: '1' });

    expect(await attemptLogin(PASSWORD, T0 + 1000)).toEqual({ ok: true });
  });

  it('a correct password after 3 failures (real IP) clears the pair row, leaves the per-IP count at 3 and clears the delay', async () => {
    for (let i = 0; i < 3; i += 1) await attemptLogin('wrong-password-000', T0 + i * 1000, '203.0.113.10');
    expect((await bucketRows('login.pair'))[0].count).toBe(3);

    expect(await attemptLogin(PASSWORD, T0 + 10_000, '203.0.113.10')).toEqual({ ok: true });

    expect(await bucketRows('login.pair')).toHaveLength(0);
    expect(await bucketRows('login.delay')).toHaveLength(0);
    const [perIp] = await bucketRows('login.ip');
    expect(perIp.count).toBe(3);
    expect(perIp.keyHash).toBe(sha256Hex('203.0.113.10'));
  });

  it('the per-email delay holds across IPs on the database store (no hard per-email lock)', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      expect(await attemptLogin('wrong-password-000', T0 + i, `10.0.${i}.1`)).toMatchObject({ code: 'BAD_CREDENTIALS' });
    }
    expect(await attemptLogin(PASSWORD, T0 + 100, '192.0.2.1')).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfter: '1' });
    expect(await attemptLogin(PASSWORD, T0 + 1004, '192.0.2.1')).toEqual({ ok: true });
  });

  it('the login route answers 429 with Retry-After from the database store (real clock)', async () => {
    setHops('1');
    const request = (password: string) =>
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', 'x-forwarded-for': '203.0.113.10' },
        body: JSON.stringify({ email: EMAIL, password }),
      });
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) expect((await loginRoute(request('wrong-password-000'), ctx)).status).toBe(401);

    const res = await loginRoute(request(PASSWORD), ctx);

    expect(res.status).toBe(429);
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.ok === false && body.error.code).toBe('RATE_LIMITED');
  });

  it('fails closed: a store whose database is unreachable makes login a 500, never an allow', async () => {
    const dead = await createDbHandle({ engine: 'postgres', url: process.env.BLOG0_DATABASE_URL! }, { max: 1 });
    await dead.close();
    resetRateLimitStoreForTests(new DbRateLimitStore(dead.db));
    const logs = captureLogs();
    try {
      const res = await loginRoute(
        new Request(`${ORIGIN}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410' },
          body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        }),
        ctx,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as Envelope<unknown>;
      expect(body.ok === false && body.error.code).toBe('INTERNAL');
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      logs.stop();
    }
  });
});

describe('newsletter on the database store', () => {
  const post = (email: string, ip: string) =>
    newsletterRoute(
      new Request(`${ORIGIN}/api/newsletter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', 'x-forwarded-for': ip },
        body: JSON.stringify({ email, fillMs: 5000 }),
      }),
      ctx,
    );

  it('per-email cap reached → 429 + Retry-After, and the refused attempt did not touch the per-IP / site rows', async () => {
    setHops('1');
    for (let i = 0; i < NEWSLETTER_MAX_PER_EMAIL; i += 1) expect((await post('reader@example.com', '198.51.100.7')).status).toBe(200);

    const refused = await post('reader@example.com', '198.51.100.7');

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await bucketRows('newsletter.email'))[0].count).toBe(NEWSLETTER_MAX_PER_EMAIL);
    expect((await bucketRows('newsletter.ip'))[0].count).toBe(NEWSLETTER_MAX_PER_EMAIL);
    expect((await bucketRows('newsletter.site'))[0].count).toBe(NEWSLETTER_MAX_PER_EMAIL);
    // another address from the same IP still passes (IP cap 10)
    expect((await post('other@example.com', '198.51.100.7')).status).toBe(200);
  });

  it('stores only SHA-256 key hashes — never the raw email or IP', async () => {
    setHops('1');
    await post('Hashed@Example.com', '198.51.100.8');

    const rows = await bucketRows();
    expect(rows.map((r) => r.scope).sort()).toEqual(['newsletter.email', 'newsletter.ip', 'newsletter.site']);
    for (const row of rows) {
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.keyHash).not.toContain('example.com');
      expect(row.keyHash).not.toBe('198.51.100.8');
    }
    expect(rows.find((r) => r.scope === 'newsletter.ip')!.keyHash).toBe(sha256Hex('198.51.100.8'));
    expect(rows.find((r) => r.scope === 'newsletter.email')!.keyHash).toBe(sha256Hex('hashed@example.com'));
    const raw = await getDb().execute(dsql`select count(*)::int as n from rate_limit_bucket where key_hash in ('hashed@example.com', '198.51.100.8')`);
    expect(JSON.stringify(raw)).toContain('"n":0');
  });
});

describe('prune', () => {
  it('deletes exactly the rows with expires_at <= now and returns how many', async () => {
    const store = new DbRateLimitStore();
    const mk = (key: string, start: number, windowMs: number) => ({
      siteId: currentSite.id,
      scope: 'login.pair',
      keyHash: sha256Hex(key),
      windowStart: new Date(start),
      expiresAt: new Date(start + windowMs),
      count: 1,
    });
    await getDb()
      .insert(rateLimitBucket)
      .values([
        mk('old', T0 - LOGIN_WINDOW_MS, LOGIN_WINDOW_MS), // expires at T0 → pruned (<=)
        mk('older', T0 - 2 * LOGIN_WINDOW_MS, LOGIN_WINDOW_MS), // pruned
        mk('live', T0, LOGIN_WINDOW_MS), // expires at T0 + 15 min → kept
        mk('hourly', T0 - LOGIN_WINDOW_MS, NEWSLETTER_WINDOW_MS), // kept
      ]);

    expect(await store.prune(T0)).toBe(2);

    const left = (await bucketRows()).map((r) => r.keyHash).sort();
    expect(left).toEqual([sha256Hex('live'), sha256Hex('hourly')].sort());
    expect(await store.prune(T0)).toBe(0);
  });

  it('attempt() prunes expired windows in passing (at most once per interval) and a prune failure never fails the attempt', async () => {
    const store = new DbRateLimitStore();
    await store.attempt(currentSite.id, [BUCKET], T0); // first attempt in this process-state → prunes
    await store.attempt(currentSite.id, [BUCKET], T0 + 2 * LOGIN_WINDOW_MS); // 30 min later → prunes the T0 window
    expect((await bucketRows()).map((r) => r.windowStart.getTime())).toEqual([T0 + 2 * LOGIN_WINDOW_MS]);

    class FailingPrune extends DbRateLimitStore {
      override async prune(): Promise<number> {
        throw Object.assign(new Error('connection terminated: postgres://secret@db'), { code: '57P01' });
      }
    }
    resetRateLimitStoreForTests(new FailingPrune()); // also clears the once-per-interval timestamp
    const logs = captureLogs();
    try {
      const result = await getRateLimitStore().attempt(currentSite.id, [BUCKET], T0 + 2 * LOGIN_WINDOW_MS);
      expect(result).toEqual({ limited: false });
      const warn = logs.find('rate_limit.prune_failed');
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatchObject({ level: 'warn', err_code: '57P01' });
      expect(JSON.stringify(logs.lines)).not.toContain('secret@db');
    } finally {
      logs.stop();
    }
  });
});

describe('DbRateLimitStore on embedded PGlite (pglite://memory)', () => {
  it('the same 5-cap sequence behaves identically after the migrations', async () => {
    const handle = await createDbHandle({ engine: 'pglite', dir: 'memory' });
    try {
      expect(await runMigrations(handle)).toContain('0001_rate_limit_bucket');
      const { site } = await seedSite(handle.db, 'blog0');
      const store = new DbRateLimitStore(handle.db);

      const results = await Promise.all(Array.from({ length: 20 }, () => store.attempt(site.id, [BUCKET], T0 + 1000)));

      expect(results.filter((r) => !r.limited)).toHaveLength(5);
      expect(results.find((r) => r.limited)).toEqual({ limited: true, retryAfterSec: LOGIN_WINDOW_MS / 1000 - 1, scope: 'login.pair' });
      const [row] = await handle.db
        .select()
        .from(rateLimitBucket)
        .where(and(eq(rateLimitBucket.siteId, site.id), eq(rateLimitBucket.scope, 'login.pair')));
      expect(row.count).toBe(5);
      expect((await store.attempt(site.id, [BUCKET], T0 + LOGIN_WINDOW_MS)).limited).toBe(false);
      await store.clear(site.id, BUCKET, T0 + LOGIN_WINDOW_MS);
      await store.attempt(site.id, [BUCKET], T0 + LOGIN_WINDOW_MS);
      await store.prune(T0 + 2 * LOGIN_WINDOW_MS);
      expect(await handle.db.select().from(rateLimitBucket)).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});
