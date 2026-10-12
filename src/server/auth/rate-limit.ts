import 'server-only';

// Login throttling (spec/architecture.md §6; capability admin-auth):
// - 5 failed attempts for the same (lower-cased email, client IP) within 15 minutes, and
// - 20 failed attempts for the same lower-cased email across all IPs within 15 minutes
// → further attempts are refused for the rest of that window. `attempt()` checks AND reserves a
// failure synchronously, so concurrent requests cannot all pass the check before any of them is
// counted; a correct password then calls `recordSuccess()`. Phase 1 keeps the counters in memory
// per process (single instance — see the roadmap assumption); Phase 5 moves them to Postgres.

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_EMAIL_MAX_FAILURES = 20;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface Entry {
  windowStart: number;
  failures: number;
}

export type RateLimitCheck = { limited: false } | { limited: true; retryAfterSec: number };

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function pairKey(email: string, ip: string): string {
  return `${normalize(email)}\u0000${ip}`;
}

/** Fixed-window failure counters keyed by string, bounded in size. */
class WindowCounter {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly max: number) {}

  /** Seconds until unlock when `key` is at its cap in the current window, else null. */
  lockedFor(key: string, now: number): number | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    const endsAt = entry.windowStart + LOGIN_WINDOW_MS;
    if (now >= endsAt) {
      this.#entries.delete(key);
      return null;
    }
    if (entry.failures < this.max) return null;
    return Math.max(1, Math.ceil((endsAt - now) / 1000));
  }

  add(key: string, now: number): void {
    const entry = this.#entries.get(key);
    if (!entry || now >= entry.windowStart + LOGIN_WINDOW_MS) {
      if (this.#entries.size >= MAX_ENTRIES) this.prune(now);
      this.#entries.set(key, { windowStart: now, failures: 1 });
      return;
    }
    entry.failures += 1;
  }

  /** Undo one reservation (never below zero; an emptied entry is dropped). */
  refund(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.failures -= 1;
    if (entry.failures <= 0) this.#entries.delete(key);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now >= entry.windowStart + LOGIN_WINDOW_MS) this.#entries.delete(key);
    }
    if (this.#entries.size >= MAX_ENTRIES) {
      const overflow = this.#entries.size - MAX_ENTRIES + 1;
      let removed = 0;
      for (const key of this.#entries.keys()) {
        if (removed >= overflow) break;
        this.#entries.delete(key);
        removed += 1;
      }
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

export class LoginRateLimiter {
  readonly #pairs = new WindowCounter(LOGIN_MAX_FAILURES);
  readonly #emails = new WindowCounter(LOGIN_EMAIL_MAX_FAILURES);

  /** Whether an attempt for (email, ip) is currently refused, and for how long. Does not count. */
  check(email: string, ip: string, now: number = Date.now()): RateLimitCheck {
    const pair = this.#pairs.lockedFor(pairKey(email, ip), now);
    const perEmail = this.#emails.lockedFor(normalize(email), now);
    if (pair === null && perEmail === null) return { limited: false };
    return { limited: true, retryAfterSec: Math.max(pair ?? 0, perEmail ?? 0) };
  }

  /**
   * Check + reserve in one synchronous step: when allowed, the attempt is counted as a failure
   * immediately (before the caller awaits anything). Call `recordSuccess` if the password matches.
   */
  attempt(email: string, ip: string, now: number = Date.now()): RateLimitCheck {
    const result = this.check(email, ip, now);
    if (!result.limited) this.recordFailure(email, ip, now);
    return result;
  }

  recordFailure(email: string, ip: string, now: number = Date.now()): void {
    this.#pairs.add(pairKey(email, ip), now);
    this.#emails.add(normalize(email), now);
  }

  /** Clears the (email, ip) count and refunds the reservation this attempt made on the email cap. */
  recordSuccess(email: string, ip: string): void {
    this.#pairs.delete(pairKey(email, ip));
    this.#emails.refund(normalize(email));
  }

  /** Drops expired windows (and, if still over capacity, the oldest entries). */
  prune(now: number = Date.now()): void {
    this.#pairs.prune(now);
    this.#emails.prune(now);
  }

  /** Number of tracked (email, IP) pairs. */
  size(): number {
    return this.#pairs.size;
  }
}

/** "Too many attempts — try again in N minutes." (N rounded up, at least 1). */
export function rateLimitMessage(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Too many attempts — try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

const globalKey = Symbol.for('blog0.loginRateLimiter');
type GlobalWithLimiter = typeof globalThis & { [globalKey]?: LoginRateLimiter };

/** Process-wide limiter (kept on globalThis so dev-mode module reloads share it). */
export function getLoginRateLimiter(): LoginRateLimiter {
  const g = globalThis as GlobalWithLimiter;
  g[globalKey] ??= new LoginRateLimiter();
  return g[globalKey];
}

export function resetLoginRateLimiterForTests(): void {
  (globalThis as GlobalWithLimiter)[globalKey] = new LoginRateLimiter();
}
