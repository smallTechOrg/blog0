import 'server-only';

import { DIRECT_CLIENT, UNKNOWN_CLIENT } from '../auth/login';
import { FixedWindowCounter } from '../rate-window';

// Newsletter throttle (capability newsletter-signup, spec/api.md POST /api/newsletter). Three
// fixed-window buckets, in memory per process (FixedWindowCounter, as the login limiter):
//   - per client IP:  10 / hour — ONLY when the IP is known (BLOG0_TRUSTED_PROXY_HOPS > 0 and an
//     address was derived). With hops=0 every request maps to "direct"; bucketing on that would let
//     one visitor lock the whole site out, so an unknown IP skips this bucket.
//   - per email:       3 / hour — always.
//   - site-wide:     300 / hour — always.
// `attempt()` checks every applicable bucket first and counts in all of them only when none is
// full, synchronously, so concurrent requests cannot slip past and a rejected request never
// consumes budget. Callers invoke it only after validation (rejected-before-validation requests
// don't count).

export const NEWSLETTER_MAX_PER_WINDOW = 10;
export const NEWSLETTER_MAX_PER_EMAIL = 3;
export const NEWSLETTER_MAX_SITE_WIDE = 300;
export const NEWSLETTER_WINDOW_MS = 60 * 60 * 1000;

export type NewsletterRateCheck = { limited: false } | { limited: true; retryAfterSec: number };

/** One fixed-window bucket: `attempt` counts unless `key` is already at the cap. */
export class NewsletterRateLimiter extends FixedWindowCounter {
  constructor(max: number = NEWSLETTER_MAX_PER_WINDOW, windowMs: number = NEWSLETTER_WINDOW_MS) {
    super(max, windowMs);
  }

  /** Reports whether `key` is at the cap for the current window, without counting. */
  peek(key: string, now: number = Date.now()): NewsletterRateCheck {
    const retryAfterSec = this.lockedFor(key, now);
    return retryAfterSec === null ? { limited: false } : { limited: true, retryAfterSec };
  }

  /** Counts one submission for `key` unless it is already at the cap for the current window. */
  attempt(key: string, now: number = Date.now()): NewsletterRateCheck {
    const check = this.peek(key, now);
    if (!check.limited) this.add(key, now);
    return check;
  }
}

export interface NewsletterThrottleLimits {
  perIp: number;
  perEmail: number;
  siteWide: number;
  windowMs: number;
}

export const DEFAULT_NEWSLETTER_LIMITS: NewsletterThrottleLimits = {
  perIp: NEWSLETTER_MAX_PER_WINDOW,
  perEmail: NEWSLETTER_MAX_PER_EMAIL,
  siteWide: NEWSLETTER_MAX_SITE_WIDE,
  windowMs: NEWSLETTER_WINDOW_MS,
};

export type NewsletterBucket = 'ip' | 'email' | 'site';
export type NewsletterThrottleCheck = { limited: false } | { limited: true; retryAfterSec: number; bucket: NewsletterBucket };

export interface NewsletterThrottleKey {
  /** From clientIpFromRequest(); "direct"/"unknown"/empty means the IP is not known. */
  ip: string;
  /** The normalised (trimmed, lower-cased) address. */
  email: string;
  siteId: string;
}

/** True when `ip` identifies a real client (not the hops=0 / missing-header sentinels). */
export function isKnownClientIp(ip: string): boolean {
  return ip !== '' && ip !== DIRECT_CLIENT && ip !== UNKNOWN_CLIENT;
}

export class NewsletterThrottle {
  readonly limits: NewsletterThrottleLimits;
  readonly #ip: NewsletterRateLimiter;
  readonly #email: NewsletterRateLimiter;
  readonly #site: NewsletterRateLimiter;

  constructor(limits: Partial<NewsletterThrottleLimits> = {}) {
    this.limits = { ...DEFAULT_NEWSLETTER_LIMITS, ...limits };
    this.#ip = new NewsletterRateLimiter(this.limits.perIp, this.limits.windowMs);
    this.#email = new NewsletterRateLimiter(this.limits.perEmail, this.limits.windowMs);
    this.#site = new NewsletterRateLimiter(this.limits.siteWide, this.limits.windowMs);
  }

  /** Counts one signup in every applicable bucket, or none when any bucket is full. */
  attempt(key: NewsletterThrottleKey, now: number = Date.now()): NewsletterThrottleCheck {
    const buckets: Array<[NewsletterBucket, NewsletterRateLimiter, string]> = [];
    if (isKnownClientIp(key.ip)) buckets.push(['ip', this.#ip, key.ip]);
    buckets.push(['email', this.#email, `${key.siteId}\u0000${key.email}`]);
    buckets.push(['site', this.#site, key.siteId]);

    let worst: NewsletterThrottleCheck = { limited: false };
    for (const [bucket, limiter, k] of buckets) {
      const check = limiter.peek(k, now);
      if (check.limited && (!worst.limited || check.retryAfterSec > worst.retryAfterSec)) {
        worst = { limited: true, retryAfterSec: check.retryAfterSec, bucket };
      }
    }
    if (worst.limited) return worst;
    for (const [, limiter, k] of buckets) limiter.attempt(k, now);
    return { limited: false };
  }
}

const globalKey = Symbol.for('blog0.newsletterThrottle');
type GlobalWithThrottle = typeof globalThis & { [globalKey]?: NewsletterThrottle };

/** Process-wide throttle (on globalThis so dev-mode module reloads share it). */
export function getNewsletterThrottle(): NewsletterThrottle {
  const g = globalThis as GlobalWithThrottle;
  g[globalKey] ??= new NewsletterThrottle();
  return g[globalKey];
}

/** Fresh throttle for tests; `limits` overrides individual caps (e.g. a small site-wide cap). */
export function resetNewsletterRateLimiterForTests(limits: Partial<NewsletterThrottleLimits> = {}): void {
  (globalThis as GlobalWithThrottle)[globalKey] = new NewsletterThrottle(limits);
}
