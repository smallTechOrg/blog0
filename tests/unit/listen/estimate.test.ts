import { describe, expect, it } from 'vitest';

import {
  ASSUMED_WPM,
  countWords,
  estimateMarks,
  PARAGRAPH_PAUSE_MS,
  PAUSE_WORDS,
  resolveMarks,
  toTimedParagraphs,
  type TimedParagraph,
} from '@/lib/listen/estimate';
import { activeMarkIndex, type Mark } from '@/lib/listen/marks';

// Estimated Listen timing (spec/capabilities/listen-sync.md → Business Rules, Success Criteria;
// spec/architecture.md §9.4). Pure: the recording's duration distributed over the paragraphs by
// word count + a trailing pause weight per paragraph; stored marks win only when they cover the text.

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function times(marks: readonly Mark[]): number[] {
  return marks.map((m) => m.tMs);
}

describe('constants', () => {
  it('assume 150 wpm and a 0.6 s pause = 1.5 word-equivalents', () => {
    expect(ASSUMED_WPM).toBe(150);
    expect(PARAGRAPH_PAUSE_MS).toBe(600);
    expect(PAUSE_WORDS).toBe(1.5);
  });
});

describe('countWords', () => {
  it('counts whitespace tokens holding at least one letter or digit', () => {
    expect(countWords('Hello, world — 42 times.')).toBe(4);
    expect(countWords('  café   naïve\tdéjà\nvu ')).toBe(4);
    expect(countWords('日本語 テキスト')).toBe(2);
  });

  it('is 0 for punctuation/symbol-only or empty text', () => {
    expect(countWords('* * *')).toBe(0);
    expect(countWords('—')).toBe(0);
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });
});

describe('toTimedParagraphs', () => {
  it('maps pid + countWords(text), in order', () => {
    expect(toTimedParagraphs([{ pid: 'a', text: 'One two three.' }, { pid: 'b', text: '* * *' }])).toEqual([
      { pid: 'a', words: 3 },
      { pid: 'b', words: 0 },
    ]);
  });
});

describe('estimateMarks', () => {
  it('is [] with no paragraphs', () => {
    expect(estimateMarks([], 10_000)).toEqual([]);
  });

  it('gives one paragraph a single mark at 0', () => {
    expect(estimateMarks([{ pid: 'a', words: 12 }], 10_000)).toEqual([{ pid: 'a', tMs: 0 }]);
  });

  it('is exact for the worked example (weights 11.5, 1.5, 21.5) — zero-word paragraphs get a pause-wide slot', () => {
    const marks = estimateMarks(
      [
        { pid: 'a', words: 10 },
        { pid: 'b', words: 0 },
        { pid: 'c', words: 20 },
      ],
      10_000,
    );
    expect(marks).toEqual([
      { pid: 'a', tMs: 0 },
      { pid: 'b', tMs: 3333 },
      { pid: 'c', tMs: 3768 },
    ]);
    // the zero-word paragraph still has a non-zero width
    expect(marks[2].tMs - marks[1].tMs).toBeGreaterThan(0);
  });

  it('is [] for an invalid duration (0, negative, NaN, ±Infinity, < 1 ms)', () => {
    const paras: TimedParagraph[] = [
      { pid: 'a', words: 10 },
      { pid: 'b', words: 5 },
    ];
    for (const d of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.9]) {
      expect(estimateMarks(paras, d)).toEqual([]);
    }
  });

  it('treats non-finite / negative word counts as 0 words', () => {
    const marks = estimateMarks(
      [
        { pid: 'a', words: Number.NaN },
        { pid: 'b', words: -4 },
        { pid: 'c', words: 0 },
      ],
      3_000,
    );
    expect(times(marks)).toEqual([0, 1000, 2000]);
  });

  it('floors a fractional duration', () => {
    expect(times(estimateMarks([{ pid: 'a', words: 1 }, { pid: 'b', words: 1 }], 1000.9))).toEqual([0, 500]);
  });

  it('very short audio: 50 paragraphs in 20 ms → 50 integer marks in [0, 20), non-decreasing (ties allowed)', () => {
    const paras = Array.from({ length: 50 }, (_, i) => ({ pid: `p${i}`, words: (i * 7) % 13 }));
    const marks = estimateMarks(paras, 20);
    expect(marks).toHaveLength(50);
    expect(marks.map((m) => m.pid)).toEqual(paras.map((p) => p.pid));
    for (let i = 0; i < marks.length; i++) {
      expect(Number.isInteger(marks[i].tMs)).toBe(true);
      expect(marks[i].tMs).toBeGreaterThanOrEqual(0);
      expect(marks[i].tMs).toBeLessThan(20);
      if (i > 0) expect(marks[i].tMs).toBeGreaterThanOrEqual(marks[i - 1].tMs);
    }
    // ties exist → the live paragraph is the last tied one
    const tie = marks.findIndex((m, i) => i > 0 && m.tMs === marks[i - 1].tMs);
    expect(tie).toBeGreaterThan(0);
    const lastTied = marks.map((m) => m.tMs).lastIndexOf(marks[tie].tMs);
    expect(activeMarkIndex(marks, marks[tie].tMs)).toBe(lastTied);
  });

  it('is proportional: start times follow the cumulative weight share', () => {
    const marks = estimateMarks(
      [
        { pid: 'a', words: 98.5 },
        { pid: 'b', words: 48.5 },
        { pid: 'c', words: 48.5 },
      ],
      60_000,
    );
    // weights 100, 50, 50 → starts at 0, 1/2, 3/4 of the recording
    expect(times(marks)).toEqual([0, 30_000, 45_000]);
  });

  it('property: 1–200 seeded-random paragraphs at 150 wpm → strictly increasing, starts at 0, last < duration', () => {
    const rand = mulberry32(0xb10600);
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(rand() * 200);
      const paras = Array.from({ length: n }, (_, i) => ({ pid: `p${run}-${i}`, words: Math.floor(rand() * 301) }));
      const W = paras.reduce((s, p) => s + p.words + PAUSE_WORDS, 0);
      const durationMs = Math.round(W * 400); // 400 ms per word = 150 wpm
      const marks = estimateMarks(paras, durationMs);
      expect(marks).toHaveLength(n);
      expect(marks[0].tMs).toBe(0);
      expect(marks[n - 1].tMs).toBeLessThan(durationMs);
      for (let i = 1; i < n; i++) expect(marks[i].tMs).toBeGreaterThan(marks[i - 1].tMs);
    }
  });
});

describe('resolveMarks', () => {
  const paras: TimedParagraph[] = [
    { pid: 'a', words: 10 },
    { pid: 'b', words: 0 },
    { pid: 'c', words: 20 },
  ];
  const D = 10_000;
  const estimated = estimateMarks(paras, D);

  it('uses stored marks (synced) when they cover every pid; marks for unknown pids are dropped', () => {
    const stored = [
      { pid: 'a', tMs: 100 },
      { pid: 'gone', tMs: 200 },
      { pid: 'b', tMs: 2_000 },
      { pid: 'c', tMs: 5_000 },
    ];
    expect(resolveMarks(stored, paras, D)).toEqual({
      marks: [
        { pid: 'a', tMs: 100 },
        { pid: 'b', tMs: 2_000 },
        { pid: 'c', tMs: 5_000 },
      ],
      timing: 'synced',
    });
  });

  it('estimates when stored is []', () => {
    expect(resolveMarks([], paras, D)).toEqual({ marks: estimated, timing: 'estimated' });
  });

  it('estimates when one pid is uncovered', () => {
    const stored = [
      { pid: 'a', tMs: 0 },
      { pid: 'c', tMs: 5_000 },
    ];
    expect(resolveMarks(stored, paras, D)).toEqual({ marks: estimated, timing: 'estimated' });
  });

  it('estimates when the covering set is not strictly increasing, duplicated, or out of range', () => {
    const notIncreasing = [
      { pid: 'a', tMs: 0 },
      { pid: 'b', tMs: 3_000 },
      { pid: 'c', tMs: 3_000 },
    ];
    const duplicated = [
      { pid: 'a', tMs: 0 },
      { pid: 'b', tMs: 1_000 },
      { pid: 'b', tMs: 2_000 },
      { pid: 'c', tMs: 3_000 },
    ];
    const outOfRange = [
      { pid: 'a', tMs: 0 },
      { pid: 'b', tMs: 1_000 },
      { pid: 'c', tMs: D },
    ];
    for (const stored of [notIncreasing, duplicated, outOfRange]) {
      expect(resolveMarks(stored, paras, D)).toEqual({ marks: estimated, timing: 'estimated' });
    }
  });

  it('with no paragraphs → [] estimated (even with stored marks)', () => {
    expect(resolveMarks([{ pid: 'a', tMs: 0 }], [], D)).toEqual({ marks: [], timing: 'estimated' });
  });

  it('returns copies, never the caller’s objects', () => {
    const stored = [
      { pid: 'a', tMs: 0 },
      { pid: 'b', tMs: 1 },
      { pid: 'c', tMs: 2 },
    ];
    const out = resolveMarks(stored, paras, D);
    expect(out.timing).toBe('synced');
    expect(out.marks[0]).not.toBe(stored[0]);
  });
});

describe('activeMarkIndex with ties', () => {
  it('returns the last of tied marks', () => {
    expect(activeMarkIndex([{ pid: 'a', tMs: 0 }, { pid: 'b', tMs: 5 }, { pid: 'c', tMs: 5 }], 5)).toBe(2);
  });
});
