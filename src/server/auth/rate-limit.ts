import 'server-only';

import type { RateBucket, RateLimitStore } from '../rate-window';
import { getRateLimitStore, peekRateLimitStore, resetRateLimitStoreForTests } from '../rate-window-store';

// Login throttling (spec/architecture.md §6; capabilities admin-auth, abuse-protection):
// - 5 failed attempts for the same (lower-cased email, client IP) within 15 minutes, and
// - 20 failed attempts for the same lower-cased email across all IPs within 15 minutes
// → further attempts are refused for the rest of that window. Both buckets are per site.
// `attempt()` checks AND reserves a failure atomically in the throttle store (in Postgres by
// default, so the cap holds across restarts and instances); a correct password then calls
// `recordSuccess()` with the attempt's `now`. This module holds no state of its own.

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_EMAIL_MAX_FAILURES = 20;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export type RateLimitCheck = { limited: false } | { limited: true; retryAfterSec: number };

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** The two buckets one sign-in attempt counts in: (email, IP) pair first, then the email alone. */
export function loginBuckets(email: string, ip: string): [RateBucket, RateBucket] {
  const normalized = normalize(email);
  return [
    { scope: 'login.pair', key: `${normalized}\u0000${ip}`, max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS },
    { scope: 'login.email', key: normalized, max: LOGIN_EMAIL_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS },
  ];
}

export class LoginRateLimiter {
  readonly #store: RateLimitStore | null;

  /** `store` defaults to the process-wide store (`getRateLimitStore()`, resolved per call). */
  constructor(store?: RateLimitStore) {
    this.#store = store ?? null;
  }

  #resolve(): RateLimitStore {
    return this.#store ?? getRateLimitStore();
  }

  /**
   * Check + reserve atomically: when allowed, the attempt is already counted as a failure in both
   * buckets. Call `recordSuccess` (same `now`) if the password matches.
   */
  async attempt(siteId: string, email: string, ip: string, now: number = Date.now()): Promise<RateLimitCheck> {
    const check = await this.#resolve().attempt(siteId, loginBuckets(email, ip), now);
    return check.limited ? { limited: true, retryAfterSec: check.retryAfterSec } : { limited: false };
  }

  /** Clears the (email, IP) count and refunds the reservation this attempt made on the email cap. */
  async recordSuccess(siteId: string, email: string, ip: string, now: number = Date.now()): Promise<void> {
    const [pair, perEmail] = loginBuckets(email, ip);
    const store = this.#resolve();
    await store.clear(siteId, pair, now);
    await store.refund(siteId, perEmail, now);
  }
}

/** "Too many attempts — try again in N minutes." (N rounded up, at least 1). */
export function rateLimitMessage(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Too many attempts — try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** The login limiter on the process-wide store (stateless; cheap to create per call). */
export function getLoginRateLimiter(): LoginRateLimiter {
  return new LoginRateLimiter();
}

/**
 * Fresh in-memory counts for tests. A test that opted into the database store keeps it (its rows
 * are wiped by the test's own table reset).
 */
export function resetLoginRateLimiterForTests(): void {
  if (peekRateLimitStore()?.kind !== 'db') resetRateLimitStoreForTests();
}
