import { describe, expect, it } from 'vitest';

import {
  LOGIN_EMAIL_MAX_FAILURES,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  LoginRateLimiter,
  loginBuckets,
  rateLimitMessage,
} from '@/server/auth/rate-limit';
import { MemoryRateLimitStore } from '@/server/rate-window';

// Login throttle on the in-memory store (first-hit windows). The database store's behaviour is
// proven against real Postgres in tests/integration/rate-limit-db.test.ts.

const T0 = new Date('2026-10-12T09:00:00Z').getTime();
const SITE = 'site-a';

function fresh(): { store: MemoryRateLimitStore; limiter: LoginRateLimiter } {
  const store = new MemoryRateLimitStore();
  return { store, limiter: new LoginRateLimiter(store) };
}

async function failTimes(limiter: LoginRateLimiter, email: string, ip: string, times: number, at = T0): Promise<void> {
  for (let i = 0; i < times; i += 1) expect((await limiter.attempt(SITE, email, ip, at + i * 1000)).limited).toBe(false);
}

describe('LoginRateLimiter (memory store)', () => {
  it('allows the first five failures and locks the sixth attempt for the rest of the window', async () => {
    const { limiter } = fresh();

    await failTimes(limiter, 'sai@smalltech.in', '10.0.0.1', LOGIN_MAX_FAILURES);
    const sixth = await limiter.attempt(SITE, 'sai@smalltech.in', '10.0.0.1', T0 + 60_000);

    expect(sixth).toEqual({ limited: true, retryAfterSec: (LOGIN_WINDOW_MS - 60_000) / 1000 });
  });

  it('unlocks once the 15-minute window has passed', async () => {
    const { limiter } = fresh();
    await failTimes(limiter, 'sai@smalltech.in', '10.0.0.1', LOGIN_MAX_FAILURES, T0);

    const justBefore = await limiter.attempt(SITE, 'sai@smalltech.in', '10.0.0.1', T0 + LOGIN_WINDOW_MS - 1);
    const after = await limiter.attempt(SITE, 'sai@smalltech.in', '10.0.0.1', T0 + LOGIN_WINDOW_MS);

    expect(justBefore.limited).toBe(true);
    expect(after).toEqual({ limited: false });
  });

  it('keys on the lower-cased email and the IP together, per site', async () => {
    const { limiter } = fresh();
    await failTimes(limiter, 'Sai@SmallTech.in', '10.0.0.1', LOGIN_MAX_FAILURES);

    expect((await limiter.attempt(SITE, 'sai@smalltech.in', '10.0.0.1', T0 + 5000)).limited).toBe(true);
    expect((await limiter.attempt(SITE, 'sai@smalltech.in', '10.0.0.2', T0 + 5000)).limited).toBe(false);
    expect((await limiter.attempt(SITE, 'b@smalltech.in', '10.0.0.1', T0 + 5000)).limited).toBe(false);
    expect((await limiter.attempt('site-b', 'sai@smalltech.in', '10.0.0.1', T0 + 5000)).limited).toBe(false);
  });

  it('a success clears the (email, IP) count and refunds the per-email reservation', async () => {
    const { store, limiter } = fresh();
    await failTimes(limiter, 'sai@smalltech.in', 'direct', LOGIN_MAX_FAILURES - 1);
    expect((await limiter.attempt(SITE, 'sai@smalltech.in', 'direct', T0 + 100)).limited).toBe(false);

    await limiter.recordSuccess(SITE, 'sai@smalltech.in', 'direct', T0 + 100);

    const after = [];
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) after.push(await limiter.attempt(SITE, 'sai@smalltech.in', 'direct', T0 + 200));
    expect(after.every((r) => !r.limited)).toBe(true);
    // per-email: 4 earlier failures + 5 new (the successful attempt's reservation was refunded)
    const [, perEmail] = loginBuckets('sai@smalltech.in', 'direct');
    await store.clear(SITE, loginBuckets('sai@smalltech.in', 'direct')[0], T0 + 300);
    const remaining = LOGIN_EMAIL_MAX_FAILURES - (LOGIN_MAX_FAILURES - 1) - LOGIN_MAX_FAILURES;
    for (let i = 0; i < remaining; i += 1) {
      expect((await store.attempt(SITE, [perEmail], T0 + 300)).limited).toBe(false);
    }
    expect((await store.attempt(SITE, [perEmail], T0 + 300)).limited).toBe(true);
  });

  it('prune forgets expired windows so memory stays bounded', async () => {
    const { store, limiter } = fresh();
    await failTimes(limiter, 'a@smalltech.in', '10.0.0.1', 1);
    await failTimes(limiter, 'b@smalltech.in', '10.0.0.1', 1);
    expect(store.size).toBe(4); // pair + email for each

    expect(await store.prune(T0 + LOGIN_WINDOW_MS + 5000)).toBe(4);
    expect(store.size).toBe(0);
  });
});

describe('LoginRateLimiter.attempt (atomic check + reservation)', () => {
  it('reserves each allowed attempt, so a concurrent burst of 10 gets exactly 5 through', async () => {
    const { limiter } = fresh();

    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.attempt(SITE, 'sai@smalltech.in', 'direct', T0)));

    expect(results.filter((r) => !r.limited)).toHaveLength(LOGIN_MAX_FAILURES);
    expect(results.slice(LOGIN_MAX_FAILURES).every((r) => r.limited)).toBe(true);
  });

  it('caps failures per email across all IPs, so rotating IPs cannot brute-force one account', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < LOGIN_EMAIL_MAX_FAILURES; i += 1) {
      expect((await limiter.attempt(SITE, 'sai@smalltech.in', `10.0.${i}.1`, T0 + i * 1000)).limited).toBe(false);
    }

    const freshIp = await limiter.attempt(SITE, 'sai@smalltech.in', '192.0.2.200', T0 + 60_000);
    const otherEmail = await limiter.attempt(SITE, 'b@smalltech.in', '192.0.2.200', T0 + 60_000);
    const later = await limiter.attempt(SITE, 'sai@smalltech.in', '192.0.2.201', T0 + LOGIN_WINDOW_MS);

    expect(LOGIN_EMAIL_MAX_FAILURES).toBe(20);
    expect(freshIp).toEqual({ limited: true, retryAfterSec: (LOGIN_WINDOW_MS - 60_000) / 1000 });
    expect(otherEmail.limited).toBe(false);
    expect(later.limited).toBe(false);
  });

  it('does not count refused attempts towards the window', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < 50; i += 1) await limiter.attempt(SITE, 'sai@smalltech.in', 'direct', T0);

    // Only 5 reservations were made for this email, so 15 other IPs still get through.
    for (let i = 0; i < LOGIN_EMAIL_MAX_FAILURES - LOGIN_MAX_FAILURES; i += 1) {
      expect((await limiter.attempt(SITE, 'sai@smalltech.in', `10.1.${i}.1`, T0 + 1000)).limited).toBe(false);
    }
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
});

describe('rateLimitMessage', () => {
  it('rounds the wait up to whole minutes and never says zero', () => {
    expect(rateLimitMessage(14 * 60 + 1)).toBe('Too many attempts — try again in 15 minutes.');
    expect(rateLimitMessage(1)).toBe('Too many attempts — try again in 1 minute.');
    expect(rateLimitMessage(0)).toBe('Too many attempts — try again in 1 minute.');
  });
});
