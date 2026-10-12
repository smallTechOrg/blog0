import 'server-only';

// Fixed-window counters keyed by string, in memory per process and bounded in size — the shared
// core of the login and newsletter throttles (single instance in v0.1; see the roadmap assumption).

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

  /** Drops expired windows (and, if still at capacity, the oldest entries). */
  prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now >= entry.windowStart + this.windowMs) this.#entries.delete(key);
    }
    let overflow = this.#entries.size - MAX_ENTRIES + 1;
    for (const key of this.#entries.keys()) {
      if (overflow-- <= 0) break;
      this.#entries.delete(key);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
