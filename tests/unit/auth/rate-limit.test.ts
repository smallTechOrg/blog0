import { describe, expect, it } from 'vitest';

import {
  LOGIN_EMAIL_MAX_FAILURES,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  LoginRateLimiter,
  rateLimitMessage,
} from '@/server/auth/rate-limit';

const T0 = new Date('2026-10-12T09:00:00Z').getTime();

function failTimes(limiter: LoginRateLimiter, email: string, ip: string, times: number, at = T0): void {
  for (let i = 0; i < times; i += 1) limiter.recordFailure(email, ip, at + i * 1000);
}

describe('LoginRateLimiter', () => {
  it('allows the first five failures and locks the sixth attempt for the rest of the window', () => {
    const limiter = new LoginRateLimiter();

    failTimes(limiter, 'sai@smalltech.in', '10.0.0.1', LOGIN_MAX_FAILURES - 1);
    const beforeFifth = limiter.check('sai@smalltech.in', '10.0.0.1', T0 + 10_000);
    limiter.recordFailure('sai@smalltech.in', '10.0.0.1', T0 + 10_000);
    const afterFifth = limiter.check('sai@smalltech.in', '10.0.0.1', T0 + 60_000);

    expect(beforeFifth).toEqual({ limited: false });
    expect(afterFifth).toEqual({ limited: true, retryAfterSec: (LOGIN_WINDOW_MS - 60_000) / 1000 });
  });

  it('unlocks once the 15-minute window has passed', () => {
    const limiter = new LoginRateLimiter();
    failTimes(limiter, 'sai@smalltech.in', '10.0.0.1', LOGIN_MAX_FAILURES);

    const justBefore = limiter.check('sai@smalltech.in', '10.0.0.1', T0 + LOGIN_WINDOW_MS - 1);
    const after = limiter.check('sai@smalltech.in', '10.0.0.1', T0 + LOGIN_WINDOW_MS);

    expect(justBefore.limited).toBe(true);
    expect(after).toEqual({ limited: false });
  });

  it('keys on the lower-cased email and the IP together', () => {
    const limiter = new LoginRateLimiter();
    failTimes(limiter, 'Sai@SmallTech.in', '10.0.0.1', LOGIN_MAX_FAILURES);

    const sameKeyOtherCase = limiter.check('sai@smalltech.in', '10.0.0.1', T0 + 5000);
    const otherIp = limiter.check('sai@smalltech.in', '10.0.0.2', T0 + 5000);
    const otherEmail = limiter.check('b@smalltech.in', '10.0.0.1', T0 + 5000);

    expect(sameKeyOtherCase.limited).toBe(true);
    expect(otherIp.limited).toBe(false);
    expect(otherEmail.limited).toBe(false);
  });

  it('clears the failure count after a successful sign-in', () => {
    const limiter = new LoginRateLimiter();
    failTimes(limiter, 'sai@smalltech.in', '10.0.0.1', LOGIN_MAX_FAILURES - 1);

    limiter.recordSuccess('sai@smalltech.in', '10.0.0.1');
    failTimes(limiter, 'sai@smalltech.in', '10.0.0.1', LOGIN_MAX_FAILURES - 1, T0 + 10_000);

    expect(limiter.check('sai@smalltech.in', '10.0.0.1', T0 + 20_000).limited).toBe(false);
  });

  it('forgets expired entries so memory stays bounded', () => {
    const limiter = new LoginRateLimiter();
    failTimes(limiter, 'a@smalltech.in', '10.0.0.1', 1);
    failTimes(limiter, 'b@smalltech.in', '10.0.0.1', 1);

    limiter.prune(T0 + LOGIN_WINDOW_MS + 5000);

    expect(limiter.size()).toBe(0);
  });
});

describe('LoginRateLimiter.attempt (check + synchronous reservation)', () => {
  it('reserves each allowed attempt immediately, so a burst of 10 gets exactly 5 through', () => {
    const limiter = new LoginRateLimiter();

    const results = Array.from({ length: 10 }, () => limiter.attempt('sai@smalltech.in', 'direct', T0));

    expect(results.filter((r) => !r.limited)).toHaveLength(LOGIN_MAX_FAILURES);
    expect(results.slice(LOGIN_MAX_FAILURES).every((r) => r.limited)).toBe(true);
  });

  it('a success after a reserved attempt clears the (email, IP) count', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) limiter.attempt('sai@smalltech.in', 'direct', T0 + i);

    expect(limiter.attempt('sai@smalltech.in', 'direct', T0 + 100).limited).toBe(false);
    limiter.recordSuccess('sai@smalltech.in', 'direct');

    const after = Array.from({ length: LOGIN_MAX_FAILURES }, () => limiter.attempt('sai@smalltech.in', 'direct', T0 + 200));
    expect(after.every((r) => !r.limited)).toBe(true);
  });

  it('caps failures per email across all IPs, so rotating IPs cannot brute-force one account', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < LOGIN_EMAIL_MAX_FAILURES; i += 1) {
      expect(limiter.attempt('sai@smalltech.in', `10.0.${i}.1`, T0 + i * 1000).limited).toBe(false);
    }

    const freshIp = limiter.attempt('sai@smalltech.in', '192.0.2.200', T0 + 60_000);
    const otherEmail = limiter.attempt('b@smalltech.in', '192.0.2.200', T0 + 60_000);
    const later = limiter.attempt('sai@smalltech.in', '192.0.2.201', T0 + LOGIN_WINDOW_MS);

    expect(LOGIN_EMAIL_MAX_FAILURES).toBe(20);
    expect(freshIp).toEqual({ limited: true, retryAfterSec: (LOGIN_WINDOW_MS - 60_000) / 1000 });
    expect(otherEmail.limited).toBe(false);
    expect(later.limited).toBe(false);
  });

  it('does not count refused attempts towards the window', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 50; i += 1) limiter.attempt('sai@smalltech.in', 'direct', T0);

    // Only 5 reservations were made for this email, so 15 other IPs still get through.
    const others = Array.from({ length: LOGIN_EMAIL_MAX_FAILURES - LOGIN_MAX_FAILURES }, (_, i) =>
      limiter.attempt('sai@smalltech.in', `10.1.${i}.1`, T0 + 1000),
    );
    expect(others.every((r) => !r.limited)).toBe(true);
  });
});

describe('rateLimitMessage', () => {
  it('rounds the wait up to whole minutes and never says zero', () => {
    expect(rateLimitMessage(14 * 60 + 1)).toBe('Too many attempts — try again in 15 minutes.');
    expect(rateLimitMessage(1)).toBe('Too many attempts — try again in 1 minute.');
    expect(rateLimitMessage(0)).toBe('Too many attempts — try again in 1 minute.');
  });
});
