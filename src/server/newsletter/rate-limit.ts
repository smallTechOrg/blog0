import 'server-only';

// Newsletter throttle (capability newsletter-signup): at most NEWSLETTER_MAX_PER_WINDOW submissions
// per client per hour. Fixed window, in memory per process (same model as the login limiter;
// Phase 5 moves limits to Postgres). `attempt()` checks AND counts synchronously, so concurrent
// requests cannot all slip past the check. The client key comes from clientIpFromRequest()
// (spec/architecture.md §6): with BLOG0_TRUSTED_PROXY_HOPS=0 every request maps to "direct".

export const NEWSLETTER_MAX_PER_WINDOW = 10;
export const NEWSLETTER_WINDOW_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface Entry {
  windowStart: number;
  count: number;
}

export type NewsletterRateCheck = { limited: false } | { limited: true; retryAfterSec: number };

export class NewsletterRateLimiter {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly max: number = NEWSLETTER_MAX_PER_WINDOW,
    private readonly windowMs: number = NEWSLETTER_WINDOW_MS,
  ) {}

  /** Counts one submission for `key` unless it is already at the cap for the current window. */
  attempt(key: string, now: number = Date.now()): NewsletterRateCheck {
    const entry = this.#entries.get(key);
    if (!entry || now >= entry.windowStart + this.windowMs) {
      if (!entry && this.#entries.size >= MAX_ENTRIES) this.prune(now);
      this.#entries.set(key, { windowStart: now, count: 1 });
      return { limited: false };
    }
    if (entry.count >= this.max) {
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil((entry.windowStart + this.windowMs - now) / 1000)) };
    }
    entry.count += 1;
    return { limited: false };
  }

  prune(now: number = Date.now()): void {
    for (const [key, entry] of this.#entries) {
      if (now >= entry.windowStart + this.windowMs) this.#entries.delete(key);
    }
    if (this.#entries.size >= MAX_ENTRIES) {
      let overflow = this.#entries.size - MAX_ENTRIES + 1;
      for (const key of this.#entries.keys()) {
        if (overflow-- <= 0) break;
        this.#entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

const globalKey = Symbol.for('blog0.newsletterRateLimiter');
type GlobalWithLimiter = typeof globalThis & { [globalKey]?: NewsletterRateLimiter };

/** Process-wide limiter (on globalThis so dev-mode module reloads share it). */
export function getNewsletterRateLimiter(): NewsletterRateLimiter {
  const g = globalThis as GlobalWithLimiter;
  g[globalKey] ??= new NewsletterRateLimiter();
  return g[globalKey];
}

export function resetNewsletterRateLimiterForTests(): void {
  (globalThis as GlobalWithLimiter)[globalKey] = new NewsletterRateLimiter();
}
