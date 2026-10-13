import 'server-only';

import { DIRECT_CLIENT, UNKNOWN_CLIENT } from '../auth/login';
import type { RateBucket, RateLimitStore, RateScope } from '../rate-window';
import { getRateLimitStore, peekRateLimitStore, resetRateLimitStoreForTests } from '../rate-window-store';

import { LINK_CAP_PER_IP, LINK_CAP_PER_SITE, LINK_WINDOW_MS } from './constants';

// Newsletter throttle (capabilities newsletter-signup, abuse-protection; spec/api.md POST
// /api/newsletter). Three fixed-window buckets, all per site, counted in the throttle store
// (Postgres by default — survives restarts, shared across instances):
//   - per client IP:  10 / hour — ONLY when the IP is known (BLOG0_TRUSTED_PROXY_HOPS > 0 and an
//     address was derived). With hops=0 every request maps to "direct"; bucketing on that would let
//     one visitor lock the whole site out, so an unknown IP skips this bucket.
//   - per email:       3 / hour — always.
//   - site-wide:     300 / hour — always.
// `attempt()` is atomic in the store: refused when any applicable bucket is full (nothing counted),
// else counted in all. Callers invoke it only after validation (rejected-before-validation requests
// don't count). This module holds no counts of its own — only the (test-overridable) limits.

export const NEWSLETTER_MAX_PER_WINDOW = 10;
export const NEWSLETTER_MAX_PER_EMAIL = 3;
export const NEWSLETTER_MAX_SITE_WIDE = 300;
export const NEWSLETTER_WINDOW_MS = 60 * 60 * 1000;

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

const BUCKET_OF: Partial<Record<RateScope, NewsletterBucket>> = {
  'newsletter.ip': 'ip',
  'newsletter.email': 'email',
  'newsletter.site': 'site',
};

/** The buckets one signup counts in (the per-IP one only for a known client IP). */
export function newsletterBuckets(key: NewsletterThrottleKey, limits: NewsletterThrottleLimits = DEFAULT_NEWSLETTER_LIMITS): RateBucket[] {
  const buckets: RateBucket[] = [];
  if (isKnownClientIp(key.ip)) buckets.push({ scope: 'newsletter.ip', key: key.ip, max: limits.perIp, windowMs: limits.windowMs });
  buckets.push({ scope: 'newsletter.email', key: key.email, max: limits.perEmail, windowMs: limits.windowMs });
  buckets.push({ scope: 'newsletter.site', key: key.siteId, max: limits.siteWide, windowMs: limits.windowMs });
  return buckets;
}

export class NewsletterThrottle {
  readonly limits: NewsletterThrottleLimits;
  readonly #store: RateLimitStore | null;

  /** `store` defaults to the process-wide store (`getRateLimitStore()`, resolved per call). */
  constructor(limits: Partial<NewsletterThrottleLimits> = {}, store?: RateLimitStore) {
    this.limits = { ...DEFAULT_NEWSLETTER_LIMITS, ...limits };
    this.#store = store ?? null;
  }

  /** Counts one signup in every applicable bucket, or none when any bucket is full. */
  async attempt(key: NewsletterThrottleKey, now: number = Date.now()): Promise<NewsletterThrottleCheck> {
    const store = this.#store ?? getRateLimitStore();
    const check = await store.attempt(key.siteId, newsletterBuckets(key, this.limits), now);
    if (!check.limited) return { limited: false };
    return { limited: true, retryAfterSec: check.retryAfterSec, bucket: BUCKET_OF[check.scope] ?? 'site' };
  }
}

const limitsKey = Symbol.for('blog0.newsletterLimits');
type GlobalWithLimits = typeof globalThis & { [limitsKey]?: NewsletterThrottleLimits };

/** The newsletter throttle on the process-wide store, with the current limits. */
export function getNewsletterThrottle(): NewsletterThrottle {
  return new NewsletterThrottle((globalThis as GlobalWithLimits)[limitsKey] ?? DEFAULT_NEWSLETTER_LIMITS);
}

/**
 * Tests: `limits` overrides individual caps (e.g. a small site-wide cap); in-memory counts start
 * fresh (a test that opted into the database store keeps it — its rows are wiped by the table reset).
 */
export function resetNewsletterRateLimiterForTests(limits: Partial<NewsletterThrottleLimits> = {}): void {
  (globalThis as GlobalWithLimits)[limitsKey] = { ...DEFAULT_NEWSLETTER_LIMITS, ...limits };
  if (peekRateLimitStore()?.kind !== 'db') resetRateLimitStoreForTests();
}

// ---------------------------------------------------------------------------------------------
// Phase 7 — the confirm / unsubscribe link throttle (spec/architecture.md §6 "Newsletter link
// throttling"): 30 per known client IP per hour (skipped for direct/unknown, exactly like signup)
// and 1 000 per site per hour. Callers shape-check the token first — a malformed token answers 404
// without counting; a well-formed one counts whether or not it turns out valid.

export interface LinkThrottleLimits {
  perIp: number;
  siteWide: number;
  windowMs: number;
}

export const DEFAULT_LINK_LIMITS: LinkThrottleLimits = { perIp: LINK_CAP_PER_IP, siteWide: LINK_CAP_PER_SITE, windowMs: LINK_WINDOW_MS };

export interface LinkThrottleKey {
  ip: string;
  siteId: string;
}

export function linkBuckets(key: LinkThrottleKey, limits: LinkThrottleLimits = DEFAULT_LINK_LIMITS): RateBucket[] {
  const buckets: RateBucket[] = [];
  if (isKnownClientIp(key.ip)) buckets.push({ scope: 'newsletter.link.ip', key: key.ip, max: limits.perIp, windowMs: limits.windowMs });
  buckets.push({ scope: 'newsletter.link.site', key: key.siteId, max: limits.siteWide, windowMs: limits.windowMs });
  return buckets;
}

export class NewsletterLinkThrottle {
  readonly limits: LinkThrottleLimits;
  readonly #store: RateLimitStore | null;

  constructor(limits: Partial<LinkThrottleLimits> = {}, store?: RateLimitStore) {
    this.limits = { ...DEFAULT_LINK_LIMITS, ...limits };
    this.#store = store ?? null;
  }

  async attempt(key: LinkThrottleKey, now: number = Date.now()): Promise<NewsletterThrottleCheck> {
    const store = this.#store ?? getRateLimitStore();
    const check = await store.attempt(key.siteId, linkBuckets(key, this.limits), now);
    if (!check.limited) return { limited: false };
    return { limited: true, retryAfterSec: check.retryAfterSec, bucket: check.scope === 'newsletter.link.ip' ? 'ip' : 'site' };
  }
}

const linkLimitsKey = Symbol.for('blog0.newsletterLinkLimits');
type GlobalWithLinkLimits = typeof globalThis & { [linkLimitsKey]?: LinkThrottleLimits };

export function getNewsletterLinkThrottle(): NewsletterLinkThrottle {
  return new NewsletterLinkThrottle((globalThis as GlobalWithLinkLimits)[linkLimitsKey] ?? DEFAULT_LINK_LIMITS);
}

/** Tests: override the link caps; in-memory counts start fresh. */
export function resetNewsletterLinkRateLimiterForTests(limits: Partial<LinkThrottleLimits> = {}): void {
  (globalThis as GlobalWithLinkLimits)[linkLimitsKey] = { ...DEFAULT_LINK_LIMITS, ...limits };
  if (peekRateLimitStore()?.kind !== 'db') resetRateLimitStoreForTests();
}
