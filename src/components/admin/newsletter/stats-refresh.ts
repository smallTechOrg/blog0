// Issue stats auto-refresh (Stage A — spec/ui.md §4 "Issue" → Stats): once on open, then every 60 s
// while the tab is visible. Hidden pauses; visible again refreshes at once when ≥ 60 s passed since
// the last refresh started, otherwise resumes the schedule. One request in flight at a time; a
// failed run is swallowed here (the caller shows "Couldn’t refresh stats") and the schedule goes on.
// The clock and visibility source are injectable for tests.

export const STATS_REFRESH_MS = 60_000;

export interface RefreshEnv {
  now(): number;
  isVisible(): boolean;
  onVisibilityChange(fn: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function browserRefreshEnv(): RefreshEnv {
  return {
    now: () => Date.now(),
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
  };
}

/** Starts the schedule; returns the stop function (call it on unmount). */
export function startStatsAutoRefresh(run: () => Promise<unknown>, env: RefreshEnv = browserRefreshEnv()): () => void {
  let stopped = false;
  let inFlight = false;
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  const clear = (): void => {
    if (timer !== null) {
      env.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (): void => {
    clear();
    if (stopped || inFlight || !env.isVisible()) return;
    timer = env.setTimeout(tick, Math.max(0, last + STATS_REFRESH_MS - env.now()));
  };
  function tick(): void {
    timer = null;
    if (stopped || inFlight || !env.isVisible()) return;
    inFlight = true;
    last = env.now();
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(run());
    } catch (err) {
      pending = Promise.reject(err);
    }
    void pending
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        schedule();
      });
  }

  const off = env.onVisibilityChange(() => {
    if (stopped) return;
    if (env.isVisible()) schedule();
    else clear();
  });
  tick();
  return () => {
    stopped = true;
    clear();
    off();
  };
}
