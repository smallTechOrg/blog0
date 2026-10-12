// Tap-along state machine (spec/capabilities/listen-sync.md → Business rules "Sync walks the
// list in order"). Pure reducer; the hook wraps it with the <audio> side effects.
import { describe, expect, it } from 'vitest';

import {
  initialTapState,
  marksOf,
  tapSyncReducer,
  timesFromMarks,
  unmarkedCount,
  type TapState,
} from '@/components/admin/listen/useTapSync';
import { TAP_DEBOUNCE_MS, validateMarks } from '@/lib/listen/marks';

const PIDS = ['p1', 'p2', 'p3', 'p4'];
const DURATION = 20_000;
const ctx = { pids: PIDS, durationMs: DURATION };

function run(state: TapState, actions: Parameters<typeof tapSyncReducer>[1][]): TapState {
  return actions.reduce((s, a) => tapSyncReducer(s, a, ctx), state);
}

describe('tapSyncReducer', () => {
  it('starts with paragraph 1 next and no marks', () => {
    const s = run(initialTapState(PIDS, []), [{ type: 'start' }]);
    expect(s.phase).toBe('syncing');
    expect(s.nextIndex).toBe(0);
    expect(s.times).toEqual([null, null, null, null]);
  });

  it('each tap stamps the next paragraph and advances; the last tap completes', () => {
    let s = run(initialTapState(PIDS, []), [{ type: 'start' }]);
    s = run(s, [
      { type: 'tap', tMs: 500, now: 1000 },
      { type: 'tap', tMs: 4000, now: 2000 },
      { type: 'tap', tMs: 9000, now: 3000 },
    ]);
    expect(s.phase).toBe('syncing');
    expect(s.nextIndex).toBe(3);
    s = run(s, [{ type: 'tap', tMs: 15_000, now: 4000 }]);
    expect(s.phase).toBe('complete');
    expect(marksOf(s, PIDS)).toEqual([
      { pid: 'p1', tMs: 500 },
      { pid: 'p2', tMs: 4000 },
      { pid: 'p3', tMs: 9000 },
      { pid: 'p4', tMs: 15_000 },
    ]);
    expect(validateMarks(marksOf(s, PIDS), PIDS, DURATION)).toEqual({ ok: true });
    // Further taps after completion are ignored.
    expect(run(s, [{ type: 'tap', tMs: 16_000, now: 5000 }])).toBe(s);
  });

  it('ignores taps closer than the debounce, non-increasing times, and taps when not syncing', () => {
    const idle = initialTapState(PIDS, []);
    expect(run(idle, [{ type: 'tap', tMs: 100, now: 0 }])).toBe(idle);

    let s = run(idle, [{ type: 'start' }, { type: 'tap', tMs: 500, now: 1000 }]);
    const quick = run(s, [{ type: 'tap', tMs: 700, now: 1000 + TAP_DEBOUNCE_MS - 1 }]);
    expect(quick).toBe(s);
    s = run(s, [{ type: 'tap', tMs: 500, now: 5000 }]); // same time as the last mark → not increasing
    expect(s.nextIndex).toBe(1);
    s = run(s, [{ type: 'tap', tMs: 501.7, now: 9000 }]); // fractional currentTime → integer ms
    expect(s.times[1]).toBe(501);
  });

  it('undo removes the last mark and points at it again, even after completion', () => {
    let s = run(initialTapState(PIDS, []), [
      { type: 'start' },
      { type: 'tap', tMs: 500, now: 1000 },
      { type: 'tap', tMs: 4000, now: 2000 },
      { type: 'tap', tMs: 9000, now: 3000 },
      { type: 'tap', tMs: 15_000, now: 4000 },
    ]);
    expect(s.phase).toBe('complete');
    s = run(s, [{ type: 'undo' }]);
    expect(s.phase).toBe('syncing');
    expect(s.nextIndex).toBe(3);
    expect(s.times).toEqual([500, 4000, 9000, null]);
    s = run(s, [{ type: 'undo' }, { type: 'undo' }, { type: 'undo' }]);
    expect(s.times).toEqual([null, null, null, null]);
    expect(run(s, [{ type: 'undo' }])).toBe(s); // nothing left to undo
  });

  it('restart clears every mark; stop keeps them and leaves syncing', () => {
    let s = run(initialTapState(PIDS, []), [{ type: 'start' }, { type: 'tap', tMs: 500, now: 1000 }, { type: 'tap', tMs: 4000, now: 2000 }]);
    const stopped = run(s, [{ type: 'stop' }]);
    expect(stopped.phase).toBe('idle');
    expect(stopped.times).toEqual([500, 4000, null, null]);
    s = run(s, [{ type: 'restart' }]);
    expect(s.phase).toBe('syncing');
    expect(s.times).toEqual([null, null, null, null]);
    expect(s.nextIndex).toBe(0);
  });

  it('redo from paragraph k discards marks k…end and resumes there', () => {
    const server = [
      { pid: 'p1', tMs: 500 },
      { pid: 'p2', tMs: 4000 },
      { pid: 'p3', tMs: 9000 },
      { pid: 'p4', tMs: 15_000 },
    ];
    let s = initialTapState(PIDS, server);
    expect(s.phase).toBe('idle');
    expect(s.times).toEqual([500, 4000, 9000, 15_000]);
    s = run(s, [{ type: 'redoFrom', index: 2 }]);
    expect(s.phase).toBe('syncing');
    expect(s.nextIndex).toBe(2);
    expect(s.times).toEqual([500, 4000, null, null]);
    // the next tap must come after paragraph 2's mark
    expect(run(s, [{ type: 'tap', tMs: 3000, now: 1000 }]).times[2]).toBeNull();
    expect(run(s, [{ type: 'tap', tMs: 8000, now: 1000 }]).times[2]).toBe(8000);
    expect(run(s, [{ type: 'redoFrom', index: 9 }])).toBe(s);
  });

  it('marks the audio ending before the last paragraph', () => {
    let s = run(initialTapState(PIDS, []), [{ type: 'start' }, { type: 'tap', tMs: 500, now: 1000 }]);
    s = run(s, [{ type: 'ended' }]);
    expect(s.phase).toBe('ended');
    expect(s.nextIndex).toBe(1);
    // ended when idle is a no-op
    const idle = initialTapState(PIDS, []);
    expect(run(idle, [{ type: 'ended' }])).toBe(idle);
  });

  it('nudges one mark by ±250 ms and refuses a nudge that breaks order or bounds', () => {
    const server = [
      { pid: 'p1', tMs: 0 },
      { pid: 'p2', tMs: 200 },
      { pid: 'p3', tMs: 9000 },
      { pid: 'p4', tMs: 19_900 },
    ];
    const s = initialTapState(PIDS, server);
    expect(run(s, [{ type: 'nudge', index: 2, deltaMs: 250 }]).times[2]).toBe(9250);
    expect(run(s, [{ type: 'nudge', index: 2, deltaMs: -250 }]).times[2]).toBe(8750);
    expect(run(s, [{ type: 'nudge', index: 0, deltaMs: -250 }])).toBe(s); // < 0
    expect(run(s, [{ type: 'nudge', index: 1, deltaMs: -250 }])).toBe(s); // would be ≤ p1
    expect(run(s, [{ type: 'nudge', index: 3, deltaMs: 250 }])).toBe(s); // ≥ duration
    expect(run(s, [{ type: 'nudge', index: 1, deltaMs: 250 }]).times[1]).toBe(450);
  });

  it('load adopts server marks (orphans dropped, gaps kept) and reports what is unmarked', () => {
    const stale = [
      { pid: 'p1', tMs: 500 },
      { pid: 'gone', tMs: 2000 },
      { pid: 'p3', tMs: 9000 },
    ];
    expect(timesFromMarks(PIDS, stale)).toEqual([500, null, 9000, null]);
    const s = run(initialTapState(PIDS, []), [{ type: 'start' }, { type: 'load', marks: stale }]);
    expect(s.phase).toBe('idle');
    expect(s.times).toEqual([500, null, 9000, null]);
    expect(unmarkedCount(s)).toBe(2);
    expect(marksOf(s, PIDS)).toEqual([
      { pid: 'p1', tMs: 500 },
      { pid: 'p3', tMs: 9000 },
    ]);
    // Re-sync from the first change: redo from paragraph 2 keeps p1 only.
    const redo = run(s, [{ type: 'redoFrom', index: 1 }]);
    expect(redo.times).toEqual([500, null, null, null]);
    expect(redo.nextIndex).toBe(1);
  });
});
