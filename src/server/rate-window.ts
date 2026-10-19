import 'server-only';

import { delayDecision, LOGIN_DELAY_RESET_MS } from './auth/login-delay';

// Throttle core (spec/architecture.md §6, capability abuse-protection):
// - FixedWindowCounter: first-hit windows keyed by string, in memory per process, bounded in size;
// - RateLimitStore: the async store the login and newsletter throttles call. MemoryRateLimitStore
//   (here) wraps FixedWindowCounters; DbRateLimitStore (rate-window-store.ts) counts in Postgres so
//   caps survive restarts and are shared across instances.

const MAX_ENTRIES = 10_000;

interface Entry {
  windowStart: number;
  count: number;
}

export class FixedWindowCounter {
  readonly #entries = new Map<string, Entry>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Seconds until `key` unlocks when it is at its cap in the current window, else null. Does not count. */
  lockedFor(key: string, now: number): number | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    const endsAt = entry.windowStart + this.windowMs;
    if (now >= endsAt) {
      this.#entries.delete(key);
      return null;
    }
    return entry.count < this.max ? null : Math.max(1, Math.ceil((endsAt - now) / 1000));
  }

  /** Counts one hit for `key` (a new window starts when the old one is over). */
  add(key: string, now: number): void {
    const entry = this.#entries.get(key);
    if (entry && now < entry.windowStart + this.windowMs) {
      entry.count += 1;
      return;
    }
    if (!entry && this.#entries.size >= MAX_ENTRIES) this.prune(now);
    this.#entries.set(key, { windowStart: now, count: 1 });
  }

  /** Undo one hit (an emptied entry is dropped). */
  refund(key: string): void {
    const entry = this.#entries.get(key);
    if (entry && --entry.count <= 0) this.#entries.delete(key);
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** Drops expired windows (and, if still at capacity, the oldest entries); returns how many. */
  prune(now: number): number {
    const before = this.#entries.size;
    for (const [key, entry] of this.#entries) {
      if (now >= entry.windowStart + this.windowMs) this.#entries.delete(key);
    }
    let overflow = this.#entries.size - MAX_ENTRIES + 1;
    for (const key of this.#entries.keys()) {
      if (overflow-- <= 0) break;
      this.#entries.delete(key);
    }
    return before - this.#entries.size;
  }

  get size(): number {
    return this.#entries.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Async store in front of the counters (Phase 5).

export type RateScope =
  | 'login.pair'
  | 'login.email'
  | 'newsletter.ip'
  | 'newsletter.email'
  | 'newsletter.site'
  // Phase 7: the confirm + unsubscribe links (pages and JSON routes share these two buckets).
  | 'newsletter.link.ip'
  | 'newsletter.link.site'
  // Stage A: login hard caps per real IP + the progressive per-email delay (login.email is no longer written).
  | 'login.ip'
  | 'login.delay';

export interface RateBucket {
  scope: RateScope;
  /** The raw key (email, IP, pair, site id). The database store keeps only its SHA-256. */
  key: string;
  max: number;
  windowMs: number;
}

export type RateCheck = { limited: false } | { limited: true; retryAfterSec: number; scope: RateScope };

export interface RateLimitStore {
  readonly kind: 'memory' | 'db';
  /** Atomic: any bucket at its cap → limited (nothing counted; the longest wait is reported); else +1 in every bucket. */
  attempt(siteId: string, buckets: readonly RateBucket[], now: number): Promise<RateCheck>;
  /** −1 in the window containing `now` (never below 0; missing → no-op). */
  refund(siteId: string, bucket: RateBucket, now: number): Promise<void>;
  /** Removes the bucket's count for the window containing `now`. */
  clear(siteId: string, bucket: RateBucket, now: number): Promise<void>;
  /** Deletes expired windows; returns how many. */
  prune(now: number): Promise<number>;
  /**
   * Stage A — progressive delay (scope `login.delay`), atomic check-and-reserve for one key: inside the
   * wait of the key's schedule (auth/login-delay.ts) → limited, nothing counted; else n + 1 and
   * "last attempt" = now. A key idle for 15 minutes starts again at n = 0.
   */
  attemptDelay(siteId: string, key: string, now: number): Promise<RateCheck>;
  /** Forgets the key's delay (a correct password, a password reset). */
  clearDelay(siteId: string, key: string): Promise<void>;
}

/**
 * In-process store: one FixedWindowCounter per (scope, max, windowMs), keyed `siteId\0key`. Its
 * windows start at the first hit (not epoch-aligned). Check-and-count is synchronous, so concurrent
 * attempts in one process cannot overrun a cap; nothing is shared across processes or restarts.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly kind = 'memory' as const;
  readonly #counters = new Map<string, FixedWindowCounter>();
  /** login.delay state per `siteId\0key`: attempts since the last success + the last attempt's time. */
  readonly #delays = new Map<string, { count: number; last: number }>();

  #counter(bucket: RateBucket): FixedWindowCounter {
    const id = `${bucket.scope}\u0000${bucket.max}\u0000${bucket.windowMs}`;
    let counter = this.#counters.get(id);
    if (!counter) {
      counter = new FixedWindowCounter(bucket.max, bucket.windowMs);
      this.#counters.set(id, counter);
    }
    return counter;
  }

  async attempt(siteId: string, buckets: readonly RateBucket[], now: number): Promise<RateCheck> {
    return this.attemptSync(siteId, buckets, now);
  }

  /** The synchronous core of `attempt` (no await between the check and the count). */
  attemptSync(siteId: string, buckets: readonly RateBucket[], now: number): RateCheck {
    let worst: RateCheck = { limited: false };
    for (const bucket of buckets) {
      const wait = this.#counter(bucket).lockedFor(memoryKey(siteId, bucket), now);
      if (wait !== null && (!worst.limited || wait > worst.retryAfterSec)) {
        worst = { limited: true, retryAfterSec: wait, scope: bucket.scope };
      }
    }
    if (worst.limited) return worst;
    for (const bucket of buckets) this.#counter(bucket).add(memoryKey(siteId, bucket), now);
    return worst;
  }

  async refund(siteId: string, bucket: RateBucket, now: number): Promise<void> {
    const counter = this.#counter(bucket);
    const key = memoryKey(siteId, bucket);
    // lockedFor drops an expired window first, so a refund never reaches into a newer window.
    counter.lockedFor(key, now);
    counter.refund(key);
  }

  async clear(siteId: string, bucket: RateBucket, now: number): Promise<void> {
    const counter = this.#counter(bucket);
    const key = memoryKey(siteId, bucket);
    counter.lockedFor(key, now);
    counter.delete(key);
  }

  async prune(now: number): Promise<number> {
    let removed = 0;
    for (const counter of this.#counters.values()) removed += counter.prune(now);
    return removed + this.#pruneDelays(now);
  }

  async attemptDelay(siteId: string, key: string, now: number): Promise<RateCheck> {
    return this.attemptDelaySync(siteId, key, now);
  }

  /** The synchronous core of `attemptDelay` (no await between the check and the reservation). */
  attemptDelaySync(siteId: string, key: string, now: number): RateCheck {
    const id = `${siteId}\u0000${key}`;
    const entry = this.#delays.get(id);
    const live = entry !== undefined && now < entry.last + LOGIN_DELAY_RESET_MS;
    const n = live ? entry.count : 0;
    const decision = delayDecision(n, live ? entry.last : null, now);
    if (decision.limited) return { limited: true, retryAfterSec: decision.retryAfterSec, scope: 'login.delay' };
    if (!entry && this.#delays.size >= MAX_ENTRIES) this.#pruneDelays(now);
    this.#delays.delete(id); // re-insert so Map order stays oldest-first for the overflow prune
    this.#delays.set(id, { count: n + 1, last: now });
    return { limited: false };
  }

  async clearDelay(siteId: string, key: string): Promise<void> {
    this.#delays.delete(`${siteId}\u0000${key}`);
  }

  /** Drops idle delay keys (and, if still at capacity, the oldest); returns how many. */
  #pruneDelays(now: number): number {
    const before = this.#delays.size;
    for (const [id, entry] of this.#delays) {
      if (now >= entry.last + LOGIN_DELAY_RESET_MS) this.#delays.delete(id);
    }
    let overflow = this.#delays.size - MAX_ENTRIES + 1;
    for (const id of this.#delays.keys()) {
      if (overflow-- <= 0) break;
      this.#delays.delete(id);
    }
    return before - this.#delays.size;
  }

  /** Tracked windows across every counter plus delay keys (tests: memory stays bounded). */
  get size(): number {
    let total = this.#delays.size;
    for (const counter of this.#counters.values()) total += counter.size;
    return total;
  }
}

function memoryKey(siteId: string, bucket: RateBucket): string {
  return `${siteId}\u0000${bucket.key}`;
}
