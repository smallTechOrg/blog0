// Progressive per-email login delay — the pure schedule (Stage A; spec/architecture.md §6,
// capability admin-auth). Shared by both throttle stores (rate-window.ts memory, rate-window-store.ts
// database) and re-exported by auth/rate-limit.ts, so it imports nothing.
//
// n = attempts counted for an email since its last success (forgotten after 15 quiet minutes).
// The next attempt must come at least delay(n) seconds after the previous one:
//   delay(n) = n < 5 ? 0 : min(60, 2^(n − 5))   →  5th failure: 1 s, then 2, 4, 8, 16, 32, 60, 60 …
// > Assumed (spec/architecture.md §6): 5 free attempts, 1 s doubling to a 60 s cap, 15 min reset.

export const LOGIN_FREE_ATTEMPTS = 5;
export const LOGIN_DELAY_CAP_SEC = 60;
/** A key idle for this long starts again at n = 0 (the DB row's `expires_at` = last attempt + this). */
export const LOGIN_DELAY_RESET_MS = 15 * 60 * 1000;

/** Seconds the next attempt must wait after the previous one, given `n` attempts so far. */
export function loginDelaySec(n: number): number {
  if (!Number.isFinite(n) || n < LOGIN_FREE_ATTEMPTS) return 0;
  return Math.min(LOGIN_DELAY_CAP_SEC, 2 ** (n - LOGIN_FREE_ATTEMPTS));
}

export type DelayDecision = { limited: false } | { limited: true; retryAfterSec: number };

/**
 * The wait check for one key: `n` attempts so far, the previous one at `lastMs` (null = none / reset).
 * Limited → `retryAfterSec` = whole seconds left (≥ 1). A previous attempt stamped in the future (clock
 * skew between instances) never makes the wait longer than the schedule.
 */
export function delayDecision(n: number, lastMs: number | null, now: number): DelayDecision {
  if (lastMs === null || n <= 0) return { limited: false };
  const waitMs = loginDelaySec(n) * 1000;
  if (waitMs === 0) return { limited: false };
  const remaining = Math.min(waitMs, lastMs + waitMs - now);
  if (remaining <= 0) return { limited: false };
  return { limited: true, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) };
}
