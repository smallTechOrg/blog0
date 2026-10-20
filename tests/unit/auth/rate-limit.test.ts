import { describe, expect, it } from 'vitest';

import {
  isRealClientIp,
  LOGIN_DELAY_RESET_MS,
  LOGIN_IP_MAX_FAILURES,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  loginBuckets,
  loginDelaySec,
  LoginRateLimiter,
  rateLimitMessage,
} from '@/server/auth/rate-limit';
import { delayDecision } from '@/server/auth/login-delay';
import { MemoryRateLimitStore } from '@/server/rate-window';

// Login throttle on the in-memory store (Stage A — spec/architecture.md §6, admin-auth.md): the
// progressive per-email delay replaces the hard per-email lock; hard caps only per (email, real IP)
// and per real IP. The database store is proven against real Postgres in
// tests/integration/rate-limit-db.test.ts and tests/integration/login-delay.test.ts.

const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);
const SITE = 'site-a';
const EMAIL = 'sai@smalltech.in';

function fresh(): { store: MemoryRateLimitStore; limiter: LoginRateLimiter } {
  const store = new MemoryRateLimitStore();
  return { store, limiter: new LoginRateLimiter(store) };
}

describe('loginDelaySec — the schedule', () => {
  it('is free for the first 5 attempts, then 1 s doubling to a 60 s cap', () => {
    expect([0, 1, 2, 3, 4].map(loginDelaySec)).toEqual([0, 0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 11, 12, 40].map(loginDelaySec)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it('delayDecision: no previous attempt or no wait → allowed; inside the wait → whole seconds left (≥ 1)', () => {
    expect(delayDecision(9, null, T0)).toEqual({ limited: false });
    expect(delayDecision(4, T0, T0)).toEqual({ limited: false });
    expect(delayDecision(5, T0, T0 + 100)).toEqual({ limited: true, retryAfterSec: 1 });
    expect(delayDecision(7, T0, T0 + 1500)).toEqual({ limited: true, retryAfterSec: 3 });
    expect(delayDecision(7, T0, T0 + 4000)).toEqual({ limited: false });
    // a previous attempt stamped in the future (clock skew) never stretches the wait past the schedule
    expect(delayDecision(5, T0 + 60_000, T0)).toEqual({ limited: true, retryAfterSec: 1 });
  });
});

describe('loginBuckets / isRealClientIp', () => {
  it('hard caps exist only for a real client IP: pair 5 / 15 min and IP 50 / 15 min', () => {
    expect(isRealClientIp('203.0.113.10')).toBe(true);
    expect(isRealClientIp('direct')).toBe(false);
    expect(isRealClientIp('unknown')).toBe(false);
    expect(loginBuckets(EMAIL, 'direct')).toEqual([]);
    expect(loginBuckets(EMAIL, 'unknown')).toEqual([]);
    expect(loginBuckets('Sai@SmallTech.in', '203.0.113.10')).toEqual([
      { scope: 'login.pair', key: `${EMAIL}\u0000203.0.113.10`, max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS },
      { scope: 'login.ip', key: '203.0.113.10', max: LOGIN_IP_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS },
    ]);
    expect(LOGIN_IP_MAX_FAILURES).toBe(50);
  });
});

describe('LoginRateLimiter — progressive per-email delay (memory store, direct IP)', () => {
  it('5 wrong at t=0 → t+0.5 s is refused with Retry-After 1 and NOT counted; t+1 s is admitted', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < 5; i += 1) expect(await limiter.attempt(SITE, EMAIL, 'direct', T0)).toEqual({ limited: false });

    expect(await limiter.attempt(SITE, EMAIL, 'direct', T0 + 500)).toEqual({ limited: true, retryAfterSec: 1, scope: 'login.delay' });
    // not counted: the wait after the admitted 6th attempt is 2 s (n = 6), not 4 s (n = 7)
    expect(await limiter.attempt(SITE, EMAIL, 'direct', T0 + 1000)).toEqual({ limited: false });
    expect(await limiter.attempt(SITE, EMAIL, 'direct', T0 + 2500)).toEqual({ limited: true, retryAfterSec: 1, scope: 'login.delay' });
    expect(await limiter.attempt(SITE, EMAIL, 'direct', T0 + 3000)).toEqual({ limited: false });
  });

  it('waits grow 1, 2, 4, 8, 16, 32, 60 s and stay at 60 when every attempt comes exactly after its wait', async () => {
    const { limiter } = fresh();
    let now = T0;
    for (let i = 0; i < 5; i += 1) expect((await limiter.attempt(SITE, EMAIL, 'direct', now)).limited).toBe(false);
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const refused = await limiter.attempt(SITE, EMAIL, 'direct', now);
      if (!refused.limited) throw new Error('expected a wait');
      waits.push(refused.retryAfterSec);
      now += refused.retryAfterSec * 1000;
      expect(await limiter.attempt(SITE, EMAIL, 'direct', now)).toEqual({ limited: false });
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('an attacker hammering the admin email cannot lock the owner out: 20 failures, then the owner is admitted after the current wait', async () => {
    const { limiter } = fresh();
    let now = T0;
    let failures = 0;
    // The attacker fires continuously (every 100 ms) for 10 minutes; only admitted attempts count.
    while (now < T0 + 10 * 60_000) {
      if (!(await limiter.attempt(SITE, EMAIL, 'direct', now)).limited) failures += 1;
      now += 100;
    }
    expect(failures).toBeGreaterThanOrEqual(15);
    const refused = await limiter.attempt(SITE, EMAIL, 'direct', now);
    expect(refused.limited).toBe(true);
    if (!refused.limited) return;
    expect(refused.retryAfterSec).toBeLessThanOrEqual(60);

    // The owner tries once the current wait has passed: admitted (the password is then verified).
    const owner = now + refused.retryAfterSec * 1000;
    expect(await limiter.attempt(SITE, EMAIL, 'direct', owner)).toEqual({ limited: false });
    await limiter.recordSuccess(SITE, EMAIL, 'direct', owner);
    // the success cleared the delay: the next attempts are free again
    for (let i = 0; i < 5; i += 1) expect((await limiter.attempt(SITE, EMAIL, 'direct', owner + 10)).limited).toBe(false);
  });

  it('forgets an email after 15 quiet minutes', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < 9; i += 1) await limiter.attempt(SITE, EMAIL, 'direct', T0 + i * 60_000);
    const last = T0 + 8 * 60_000;
    expect((await limiter.attempt(SITE, EMAIL, 'direct', last + 1000)).limited).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      expect(await limiter.attempt(SITE, EMAIL, 'direct', last + LOGIN_DELAY_RESET_MS)).toEqual({ limited: false });
    }
    expect((await limiter.attempt(SITE, EMAIL, 'direct', last + LOGIN_DELAY_RESET_MS)).limited).toBe(true);
  });

  it('keys the delay on the lower-cased email, per site', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < 5; i += 1) await limiter.attempt(SITE, 'Sai@SmallTech.in', 'direct', T0);

    expect((await limiter.attempt(SITE, EMAIL, 'direct', T0)).limited).toBe(true);
    expect((await limiter.attempt(SITE, 'b@smalltech.in', 'direct', T0)).limited).toBe(false);
    expect((await limiter.attempt('site-b', EMAIL, 'direct', T0)).limited).toBe(false);
  });

  it('10 concurrent attempts after the 5th failure admit exactly 1 (atomic check-and-reserve)', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < 5; i += 1) await limiter.attempt(SITE, EMAIL, 'direct', T0);

    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.attempt(SITE, EMAIL, 'direct', T0 + 1000)));

    expect(results.filter((r) => !r.limited)).toHaveLength(1);
  });

  it('10 concurrent attempts from scratch admit exactly 5 (the 6th needs a 1 s gap)', async () => {
    const { limiter } = fresh();
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.attempt(SITE, EMAIL, 'direct', T0)));
    expect(results.filter((r) => !r.limited)).toHaveLength(5);
  });
});

describe('LoginRateLimiter — hard caps with a real client IP', () => {
  it('the 6th failure of one (email, IP) within 15 min → login.pair; the same email from another IP is only delayed', async () => {
    const { limiter } = fresh();
    let now = T0;
    for (let i = 0; i < 5; i += 1) {
      expect((await limiter.attempt(SITE, EMAIL, '203.0.113.10', now)).limited).toBe(false);
      now += 60_000; // spaced well past every delay
    }
    const sixth = await limiter.attempt(SITE, EMAIL, '203.0.113.10', now);
    expect(sixth).toMatchObject({ limited: true, scope: 'login.pair' });
    if (sixth.limited) expect(sixth.retryAfterSec).toBeGreaterThan(60);

    expect(await limiter.attempt(SITE, EMAIL, '198.51.100.7', now)).toEqual({ limited: false });
  });

  it('the 51st failure from one IP across emails → login.ip', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i += 1) {
      expect((await limiter.attempt(SITE, `user${i}@smalltech.in`, '203.0.113.10', T0 + i)).limited).toBe(false);
    }
    expect(await limiter.attempt(SITE, 'fresh@smalltech.in', '203.0.113.10', T0 + 100)).toMatchObject({ limited: true, scope: 'login.ip' });
    expect((await limiter.attempt(SITE, 'fresh@smalltech.in', '203.0.113.11', T0 + 100)).limited).toBe(false);
  });

  it('a delay refusal refunds the pair/IP reservation it made (refused attempts count nowhere)', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < 4; i += 1) await limiter.attempt(SITE, EMAIL, '203.0.113.10', T0);
    // a 5th from another IP makes n = 5 → the next attempt needs a 1 s gap
    await limiter.attempt(SITE, EMAIL, '198.51.100.1', T0);
    for (let i = 0; i < 20; i += 1) {
      expect(await limiter.attempt(SITE, EMAIL, '203.0.113.10', T0 + 10)).toMatchObject({ limited: true, scope: 'login.delay' });
    }
    // the pair still holds 4: one more is admitted after the wait, then the pair cap applies
    expect(await limiter.attempt(SITE, EMAIL, '203.0.113.10', T0 + 1000)).toEqual({ limited: false });
    expect(await limiter.attempt(SITE, EMAIL, '203.0.113.10', T0 + 120_000)).toMatchObject({ limited: true, scope: 'login.pair' });
  });

  it('a success clears the pair, refunds the IP reservation and clears the delay', async () => {
    const { store, limiter } = fresh();
    for (let i = 0; i < 4; i += 1) await limiter.attempt(SITE, EMAIL, '203.0.113.10', T0 + i * 1000);
    expect(await limiter.attempt(SITE, EMAIL, '203.0.113.10', T0 + 5000)).toEqual({ limited: false });
    await limiter.recordSuccess(SITE, EMAIL, '203.0.113.10', T0 + 5000);

    for (let i = 0; i < 5; i += 1) expect(await limiter.attempt(SITE, EMAIL, '203.0.113.10', T0 + 6000)).toEqual({ limited: false });
    // IP bucket: 4 earlier failures + 5 new = 9 (the successful attempt was refunded) → 41 more fit
    const [, ip] = loginBuckets(EMAIL, '203.0.113.10');
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES - 9; i += 1) expect((await store.attempt(SITE, [ip], T0 + 7000)).limited).toBe(false);
    expect((await store.attempt(SITE, [ip], T0 + 7000)).limited).toBe(true);
  });
});

describe('MemoryRateLimitStore', () => {
  const bucket = { scope: 'newsletter.email', key: 'a@b.io', max: 2, windowMs: 60_000 } as const;

  it('reports the scope with the longest wait when several buckets are full', async () => {
    const store = new MemoryRateLimitStore();
    const short = { scope: 'newsletter.site', key: SITE, max: 1, windowMs: 10_000 } as const;
    expect(await store.attempt(SITE, [bucket, short], T0)).toEqual({ limited: false });
    expect(await store.attempt(SITE, [bucket], T0)).toEqual({ limited: false });

    expect(await store.attempt(SITE, [short, bucket], T0 + 1000)).toEqual({ limited: true, retryAfterSec: 59, scope: 'newsletter.email' });
  });

  it('refund never goes below zero and is a no-op for a missing window', async () => {
    const store = new MemoryRateLimitStore();
    await store.refund(SITE, bucket, T0);
    await store.attempt(SITE, [bucket], T0);
    await store.refund(SITE, bucket, T0);
    await store.refund(SITE, bucket, T0);

    expect(await store.attempt(SITE, [bucket], T0)).toEqual({ limited: false });
    expect(await store.attempt(SITE, [bucket], T0)).toEqual({ limited: false });
    expect((await store.attempt(SITE, [bucket], T0)).limited).toBe(true);
  });

  it('an empty bucket list is always allowed', async () => {
    expect(await new MemoryRateLimitStore().attempt(SITE, [], T0)).toEqual({ limited: false });
  });

  it('delay keys are bounded and pruned with the windows', async () => {
    const store = new MemoryRateLimitStore();
    await store.attemptDelay(SITE, 'a@b.io', T0);
    await store.attemptDelay(SITE, 'c@d.io', T0);
    expect(store.size).toBe(2);
    expect(await store.prune(T0 + LOGIN_DELAY_RESET_MS)).toBe(2);
    expect(store.size).toBe(0);
    await store.attemptDelay(SITE, 'a@b.io', T0);
    await store.clearDelay(SITE, 'a@b.io');
    expect(store.size).toBe(0);
  });
});

describe('rateLimitMessage', () => {
  it('under 60 s it counts seconds ("1 second"); from 60 s whole minutes rounded up', () => {
    expect(rateLimitMessage(1)).toBe('Too many attempts — try again in 1 second.');
    expect(rateLimitMessage(0)).toBe('Too many attempts — try again in 1 second.');
    expect(rateLimitMessage(32)).toBe('Too many attempts — try again in 32 seconds.');
    expect(rateLimitMessage(59)).toBe('Too many attempts — try again in 59 seconds.');
    expect(rateLimitMessage(60)).toBe('Too many attempts — try again in 1 minute.');
    expect(rateLimitMessage(14 * 60 + 1)).toBe('Too many attempts — try again in 15 minutes.');
  });
});
