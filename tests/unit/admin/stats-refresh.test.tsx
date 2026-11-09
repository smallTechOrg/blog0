import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IssueStats, STATS_REFRESH_FAILED, TRACKING_NOT_PUBLIC } from '@/components/admin/newsletter/IssueStats';
import { STATS_REFRESH_MS, startStatsAutoRefresh, type RefreshEnv } from '@/components/admin/newsletter/stats-refresh';
import { loginErrorMessage } from '@/components/admin/LoginForm';
import type { IssueStatsDto } from '@/lib/api/dto';

// Stage A item 10 (spec/ui.md §4 "Issue" → Stats): a sent issue refreshes its stats once on open and
// every 60 s while the tab is visible; hidden pauses; visible again refreshes at once when ≥ 60 s
// have passed; one request in flight; stopped on unmount. Plus the trackingPublic note.

function fakeEnv() {
  let visible = true;
  const listeners = new Set<() => void>();
  const env: RefreshEnv = {
    now: () => Date.now(),
    isVisible: () => visible,
    onVisibilityChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  return {
    env,
    setVisible(v: boolean) {
      visible = v;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
}

describe('startStatsAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes once on open, then every 60 s while visible', async () => {
    const { env } = fakeEnv();
    const run = vi.fn(async () => {});
    const stop = startStatsAutoRefresh(run, env);

    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STATS_REFRESH_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STATS_REFRESH_MS);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
    expect(STATS_REFRESH_MS).toBe(60_000);
  });

  it('pauses while hidden; visible again refreshes at once only when ≥ 60 s passed since the last', async () => {
    const f = fakeEnv();
    const run = vi.fn(async () => {});
    const stop = startStatsAutoRefresh(run, f.env);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    f.setVisible(false);
    await vi.advanceTimersByTimeAsync(5 * STATS_REFRESH_MS);
    expect(run).toHaveBeenCalledTimes(1);

    f.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    // hidden and back within the minute → no extra request, the schedule resumes
    await vi.advanceTimersByTimeAsync(20_000);
    f.setVisible(false);
    f.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it('keeps one request in flight and keeps going after a failure', async () => {
    const f = fakeEnv();
    let resolve!: () => void;
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)))
      .mockImplementationOnce(async () => {
        throw new Error('provider down');
      })
      .mockImplementation(async () => {});
    const stop = startStatsAutoRefresh(run, f.env);

    await vi.advanceTimersByTimeAsync(3 * STATS_REFRESH_MS);
    f.setVisible(false);
    f.setVisible(true);
    expect(run).toHaveBeenCalledTimes(1);
    // the overdue refresh runs as soon as the slow one settles
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    // that one fails; the schedule carries on
    await vi.advanceTimersByTimeAsync(STATS_REFRESH_MS);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops on unmount: no more requests and the visibility listener is removed', async () => {
    const f = fakeEnv();
    const run = vi.fn(async () => {});
    const stop = startStatsAutoRefresh(run, f.env);
    stop();
    expect(f.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * STATS_REFRESH_MS);
    f.setVisible(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('opened in a hidden tab → waits for the tab to show, then refreshes', async () => {
    const f = fakeEnv();
    f.setVisible(false);
    const run = vi.fn(async () => {});
    const stop = startStatsAutoRefresh(run, f.env);
    expect(run).toHaveBeenCalledTimes(0);
    f.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('IssueStats notes', () => {
  const stats: IssueStatsDto = { recipients: 2, sent: 2, delivered: null, opens: null, clicks: 1, bounces: 0, unsubscribes: null, fetchedAt: '2026-10-12T11:55:00Z' };
  const now = new Date('2026-10-12T12:00:00Z');

  it('shows the tracking note only when trackingPublic is false', () => {
    expect(TRACKING_NOT_PUBLIC).toBe("Opens can't be counted: Listmonk's public URL isn't reachable from the internet.");
    expect(renderToStaticMarkup(<IssueStats stats={stats} now={now} timeZone="UTC" trackingPublic={false} />)).toContain(
      'Opens can&#x27;t be counted: Listmonk&#x27;s public URL isn&#x27;t reachable from the internet.',
    );
    expect(renderToStaticMarkup(<IssueStats stats={stats} now={now} timeZone="UTC" trackingPublic />)).not.toContain('Opens can');
  });

  it('a failed refresh keeps the tiles and adds "Couldn’t refresh stats" beside "as of …"', () => {
    const html = renderToStaticMarkup(<IssueStats stats={stats} now={now} timeZone="UTC" trackingPublic refreshFailed />);
    expect(STATS_REFRESH_FAILED).toBe('Couldn’t refresh stats');
    expect(html).toContain('as of ');
    expect(html).toContain('Couldn’t refresh stats');
    expect(html.match(/class="statbox"/g)).toHaveLength(6);
  });
});

describe('sign-in rate-limit copy (Stage A item 8)', () => {
  it('reads Retry-After seconds as seconds under a minute and minutes from 60 s', () => {
    const limited = (sec: unknown) => ({ code: 'RATE_LIMITED', message: 'server text', details: { retryAfterSec: sec } });
    expect(loginErrorMessage(limited(1))).toBe('Too many attempts — try again in 1 second.');
    expect(loginErrorMessage(limited(8))).toBe('Too many attempts — try again in 8 seconds.');
    expect(loginErrorMessage(limited(59))).toBe('Too many attempts — try again in 59 seconds.');
    expect(loginErrorMessage(limited(60))).toBe('Too many attempts — try again in 1 minute.');
    expect(loginErrorMessage(limited(14 * 60 + 1))).toBe('Too many attempts — try again in 15 minutes.');
  });

  it('falls back to the server message without a usable retryAfterSec, and maps the other codes', () => {
    expect(loginErrorMessage({ code: 'RATE_LIMITED', message: 'Too many attempts — try again in 3 minutes.' })).toBe(
      'Too many attempts — try again in 3 minutes.',
    );
    expect(loginErrorMessage({ code: 'VALIDATION_FAILED', message: 'x' })).toBe('Enter a valid email address and your password.');
    expect(loginErrorMessage({ code: 'BAD_CREDENTIALS', message: 'Email or password is incorrect.' })).toBe('Email or password is incorrect.');
  });
});
