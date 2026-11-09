import 'server-only';

import type { RateBucket, RateLimitStore, RateScope } from '../rate-window';
import { getRateLimitStore, peekRateLimitStore, resetRateLimitStoreForTests } from '../rate-window-store';

export { delayDecision, LOGIN_DELAY_CAP_SEC, LOGIN_DELAY_RESET_MS, LOGIN_FREE_ATTEMPTS, loginDelaySec } from './login-delay';

// Login throttling — Stage A (spec/architecture.md §6; capabilities admin-auth, abuse-protection).
// Knowing the admin email must never lock the owner out, so the hard per-email lock is gone:
// (a) hard caps ONLY when the client IP is a real address (skipped for `direct` / `unknown`, which
//     would otherwise make the pair cap a per-email lock again): 5 failures per (email, IP) and 50 per
//     IP within 15 minutes (`login.pair`, `login.ip`);
// (b) a progressive per-email delay, always (`login.delay`, auth/login-delay.ts): after 5 attempts
//     since the last success, each next attempt waits 1, 2, 4 … 60 s after the previous one.
// Order: hard caps (refused → the delay is untouched) → delay (refused → the cap reservations are
// refunded) → the caller verifies the password. Every admitted attempt is reserved before the
// verification, so concurrent attempts on any instance cannot overrun; a correct password then calls
// `recordSuccess()` (clear pair, refund ip, clear delay). This module holds no state of its own.
// > Assumed: 5 free attempts, 1 s doubling to 60 s, 15 min reset, 50 per IP (constants here and in
// > login-delay.ts).
// Stage C — known device (auth/known-device.ts): an attempt carrying a valid `blog0_device` cookie of
// the account being tried skips the shared per-email delay and is counted in its OWN delay key
// (email + device id) instead; its success clears only that key, never the shared one, so neither an
// owner's typo nor an owner's sign-in changes what an attacker on unknown devices faces. The hard
// caps (a) apply unchanged. > Assumed (Stage C).

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_IP_MAX_FAILURES = 50;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** The non-addresses `clientIpFromRequest` returns when no trusted proxy supplied one (auth/login.ts). */
const NOT_AN_IP = new Set(['direct', 'unknown']);

export type LoginThrottleScope = Extract<RateScope, 'login.pair' | 'login.ip' | 'login.delay'>;
export type RateLimitCheck = { limited: false } | { limited: true; retryAfterSec: number; scope: LoginThrottleScope };

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** True for an address the trusted proxies supplied; false for the `direct` / `unknown` constants. */
export function isRealClientIp(ip: string): boolean {
  return ip !== '' && !NOT_AN_IP.has(ip);
}

/** The hard-cap buckets one sign-in attempt counts in: none without a real IP; else (email, IP) then IP. */
export function loginBuckets(email: string, ip: string): RateBucket[] {
  if (!isRealClientIp(ip)) return [];
  return [
    { scope: 'login.pair', key: `${normalize(email)}\u0000${ip}`, max: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS },
    { scope: 'login.ip', key: ip, max: LOGIN_IP_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS },
  ];
}

/** The `login.delay` key of an email (lower-cased; the database store keeps only its SHA-256). */
export function loginDelayKey(email: string): string {
  return normalize(email);
}

/** The `login.delay` key of one known device of an email (a NUL never occurs in an email). */
export function knownDeviceDelayKey(email: string, deviceId: string): string {
  return `${normalize(email)}\u0000device\u0000${deviceId}`;
}

/** Options for one sign-in attempt: `knownDeviceId` = the device id of a verified known-device cookie. */
export interface LoginAttemptOptions {
  knownDeviceId?: string | null;
}

function delayKeyFor(email: string, options: LoginAttemptOptions): string {
  return options.knownDeviceId ? knownDeviceDelayKey(email, options.knownDeviceId) : loginDelayKey(email);
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
   * Check + reserve atomically: when allowed, the attempt is already counted (hard caps and delay).
   * Call `recordSuccess` (same `now`) if the password matches. A store failure propagates (fail closed).
   */
  async attempt(siteId: string, email: string, ip: string, now: number = Date.now(), options: LoginAttemptOptions = {}): Promise<RateLimitCheck> {
    const store = this.#resolve();
    const buckets = loginBuckets(email, ip);
    const caps = await store.attempt(siteId, buckets, now);
    if (caps.limited) return { limited: true, retryAfterSec: caps.retryAfterSec, scope: caps.scope as LoginThrottleScope };

    const delay = await store.attemptDelay(siteId, delayKeyFor(email, options), now);
    if (delay.limited) {
      for (const bucket of buckets) await store.refund(siteId, bucket, now);
      return { limited: true, retryAfterSec: delay.retryAfterSec, scope: 'login.delay' };
    }
    return { limited: false };
  }

  /** A correct password: clear the (email, IP) count, refund this attempt's IP reservation, forget the delay (the device's own key for a known device). */
  async recordSuccess(siteId: string, email: string, ip: string, now: number = Date.now(), options: LoginAttemptOptions = {}): Promise<void> {
    const store = this.#resolve();
    const [pair, perIp] = loginBuckets(email, ip);
    if (pair) await store.clear(siteId, pair, now);
    if (perIp) await store.refund(siteId, perIp, now);
    await store.clearDelay(siteId, delayKeyFor(email, options));
  }
}

/**
 * "Too many attempts — try again in N seconds." under a minute ("1 second" when N = 1), else
 * "… in N minutes." (rounded up) — spec/ui.md → Sign in.
 */
export function rateLimitMessage(retryAfterSec: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSec));
  if (seconds < 60) return `Too many attempts — try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(seconds / 60);
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
