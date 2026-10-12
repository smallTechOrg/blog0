import { describe, expect, it } from 'vitest';

import {
  activeMarkIndex,
  AUTOSCROLL_PAUSE_MS,
  fmtClock,
  fmtClockMs,
  listenDiff,
  listenMinutes,
  NUDGE_MS,
  nudgeMark,
  SEEK_STEP_S,
  TAP_DEBOUNCE_MS,
  validateMarks,
  type Mark,
} from '@/lib/listen/marks';

// Pure helpers shared by the server (validation + stale diff), the admin tap-sync and the
// reader highlight (spec/architecture.md §9.4, spec/capabilities/listen-sync.md).

const PIDS = ['p-aaaa0001', 'p-bbbb0002', 'p-cccc0003', 'p-dddd0004'];
const DURATION = 20_000;
const complete: Mark[] = [
  { pid: PIDS[0], tMs: 500 },
  { pid: PIDS[1], tMs: 4_200 },
  { pid: PIDS[2], tMs: 9_000 },
  { pid: PIDS[3], tMs: 15_750 },
];

function reasons(marks: Mark[], pids: readonly string[] = PIDS, duration = DURATION) {
  const result = validateMarks(marks, pids, duration);
  if (result.ok) throw new Error('expected invalid marks');
  return result.reasons;
}

describe('validateMarks', () => {
  it('accepts a complete, in-order, strictly increasing set below the duration (first mark may be > 0)', () => {
    expect(validateMarks(complete, PIDS, DURATION)).toEqual({ ok: true });
    expect(validateMarks([{ pid: 'p-x', tMs: 0 }], ['p-x'], 1)).toEqual({ ok: true });
  });

  it('accepts an empty set for an article with no paragraphs', () => {
    expect(validateMarks([], [], DURATION)).toEqual({ ok: true });
  });

  it('lists UNKNOWN_PID with the offending index', () => {
    const marks = [...complete.slice(0, 3), { pid: 'p-nope0000', tMs: 15_750 }];
    expect(reasons(marks)).toEqual([
      { code: 'UNKNOWN_PID', pid: 'p-nope0000', index: 3 },
      { code: 'MISSING_PID', pid: PIDS[3] },
    ]);
  });

  it('lists every MISSING_PID in document order', () => {
    expect(reasons([complete[0], complete[2]])).toEqual([
      { code: 'MISSING_PID', pid: PIDS[1] },
      { code: 'MISSING_PID', pid: PIDS[3] },
    ]);
  });

  it('lists DUPLICATE_PID at the second occurrence', () => {
    const marks = [complete[0], complete[1], { pid: PIDS[1], tMs: 9_000 }, complete[3]];
    expect(reasons(marks)).toEqual([
      { code: 'DUPLICATE_PID', pid: PIDS[1], index: 2 },
      { code: 'MISSING_PID', pid: PIDS[2] },
    ]);
  });

  it('lists OUT_OF_ORDER when the marks do not follow document order', () => {
    const marks = [complete[0], { pid: PIDS[2], tMs: 4_200 }, { pid: PIDS[1], tMs: 9_000 }, complete[3]];
    expect(reasons(marks)).toEqual([{ code: 'OUT_OF_ORDER', pid: PIDS[1], index: 2 }]);
  });

  it('lists NOT_INCREASING for equal and for decreasing times, naming the later index', () => {
    const equal = [complete[0], complete[1], { pid: PIDS[2], tMs: 4_200 }, complete[3]];
    expect(reasons(equal)).toEqual([{ code: 'NOT_INCREASING', pid: PIDS[2], index: 2 }]);
    const decreasing = [complete[0], complete[1], complete[2], { pid: PIDS[3], tMs: 8_999 }];
    expect(reasons(decreasing)).toEqual([{ code: 'NOT_INCREASING', pid: PIDS[3], index: 3 }]);
  });

  it('lists OUT_OF_RANGE for tMs ≥ duration, negative, non-integer and non-finite values', () => {
    const atDuration = [...complete.slice(0, 3), { pid: PIDS[3], tMs: DURATION }];
    expect(reasons(atDuration)).toEqual([{ code: 'OUT_OF_RANGE', pid: PIDS[3], index: 3 }]);
    const negative = [{ pid: PIDS[0], tMs: -1 }, ...complete.slice(1)];
    expect(reasons(negative)).toEqual([{ code: 'OUT_OF_RANGE', pid: PIDS[0], index: 0 }]);
    const fractional = [complete[0], { pid: PIDS[1], tMs: 4_200.5 }, complete[2], complete[3]];
    expect(reasons(fractional)).toEqual([{ code: 'OUT_OF_RANGE', pid: PIDS[1], index: 1 }]);
    const nan = [complete[0], complete[1], complete[2], { pid: PIDS[3], tMs: Number.NaN }];
    expect(reasons(nan)).toEqual([{ code: 'OUT_OF_RANGE', pid: PIDS[3], index: 3 }]);
  });

  it('reports several problems at once (every reason listed)', () => {
    const marks = [complete[0], { pid: 'p-nope0000', tMs: 300 }, complete[2], { pid: PIDS[3], tMs: 999_999 }];
    const codes = reasons(marks).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['UNKNOWN_PID', 'NOT_INCREASING', 'OUT_OF_RANGE', 'MISSING_PID']));
    expect(codes).toHaveLength(4);
  });
});

describe('activeMarkIndex', () => {
  it('is -1 before the first mark, k between marks, and the last index at/after the last mark', () => {
    expect(activeMarkIndex(complete, 0)).toBe(-1);
    expect(activeMarkIndex(complete, 499)).toBe(-1);
    expect(activeMarkIndex(complete, 500)).toBe(0);
    expect(activeMarkIndex(complete, 4_199)).toBe(0);
    expect(activeMarkIndex(complete, 4_200)).toBe(1);
    expect(activeMarkIndex(complete, 9_000)).toBe(2);
    expect(activeMarkIndex(complete, 15_750)).toBe(3);
    expect(activeMarkIndex(complete, 1_000_000)).toBe(3);
  });

  it('is -1 for an empty mark list', () => {
    expect(activeMarkIndex([], 5_000)).toBe(-1);
  });
});

describe('nudgeMark', () => {
  it('moves one mark by ±250 ms and leaves the input untouched', () => {
    const forward = nudgeMark(complete, 1, 250, DURATION);
    expect(forward?.[1]).toEqual({ pid: PIDS[1], tMs: 4_450 });
    expect(forward?.[0]).toEqual(complete[0]);
    expect(complete[1].tMs).toBe(4_200);
    const back = nudgeMark(complete, 1, -250, DURATION);
    expect(back?.[1].tMs).toBe(3_950);
  });

  it('refuses when ordering would break', () => {
    const tight: Mark[] = [
      { pid: PIDS[0], tMs: 1_000 },
      { pid: PIDS[1], tMs: 1_200 },
    ];
    expect(nudgeMark(tight, 0, 250, DURATION)).toBeNull();
    expect(nudgeMark(tight, 1, -250, DURATION)).toBeNull();
    expect(nudgeMark(tight, 1, 250, DURATION)?.[1].tMs).toBe(1_450);
  });

  it('refuses below 0 and at/over the duration', () => {
    expect(nudgeMark([{ pid: PIDS[0], tMs: 100 }], 0, -250, DURATION)).toBeNull();
    expect(nudgeMark([{ pid: PIDS[0], tMs: DURATION - 250 }], 0, 250, DURATION)).toBeNull();
    expect(nudgeMark([{ pid: PIDS[0], tMs: DURATION - 251 }], 0, 250, DURATION)?.[0].tMs).toBe(DURATION - 1);
  });

  it('refuses an index outside the list', () => {
    expect(nudgeMark(complete, 4, 250, DURATION)).toBeNull();
    expect(nudgeMark(complete, -1, 250, DURATION)).toBeNull();
  });
});

describe('listenDiff', () => {
  it('is empty for a complete set', () => {
    expect(listenDiff(complete, PIDS)).toEqual({ missingPids: [], orphanPids: [] });
  });

  it('lists current paragraphs without a mark and marks whose paragraph vanished', () => {
    const edited = [PIDS[0], 'p-new00001', PIDS[2], PIDS[3], 'p-new00002'];
    expect(listenDiff(complete, edited)).toEqual({ missingPids: ['p-new00001', 'p-new00002'], orphanPids: [PIDS[1]] });
  });

  it('treats no marks as every paragraph missing', () => {
    expect(listenDiff([], PIDS)).toEqual({ missingPids: PIDS, orphanPids: [] });
  });
});

describe('clocks and minutes', () => {
  it('listenMinutes matches the design audioMinutes (max(1, round(ms / 60000)))', () => {
    expect(listenMinutes(0)).toBe(1);
    expect(listenMinutes(29_999)).toBe(1);
    expect(listenMinutes(30_000)).toBe(1);
    expect(listenMinutes(150_000)).toBe(3);
    expect(listenMinutes(1_799_999)).toBe(30);
  });

  it('fmtClock renders m:ss like the design, flooring seconds', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(61_000)).toBe('1:01');
    expect(fmtClock(59_999)).toBe('0:59');
    expect(fmtClock(600_000)).toBe('10:00');
    expect(fmtClock(-5)).toBe('0:00');
    expect(fmtClock(Number.NaN)).toBe('0:00');
  });

  it('fmtClockMs renders m:ss.mmm for the admin mark list', () => {
    expect(fmtClockMs(0)).toBe('0:00.000');
    expect(fmtClockMs(4_250)).toBe('0:04.250');
    expect(fmtClockMs(61_005)).toBe('1:01.005');
  });

  it('keeps the shared constants', () => {
    expect(NUDGE_MS).toBe(250);
    expect(TAP_DEBOUNCE_MS).toBe(300);
    expect(SEEK_STEP_S).toBe(5);
    expect(AUTOSCROLL_PAUSE_MS).toBe(4000);
  });
});
