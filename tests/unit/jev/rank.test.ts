import { describe, expect, it } from 'vitest';

import { rankScores, topK } from '@/server/jev/rank';
import type { JevScore } from '@/server/jev/state';

const s = (index: number, relevance: number): JevScore => ({ index, sid: `s${index}`, relevance });

describe('rankScores', () => {
  it('sorts by relevance descending, ties to the earlier sentence', () => {
    const scores = [s(0, 0.2), s(1, 0.9), s(2, 0.5), s(3, 0.9), s(4, 0.5)];
    expect(rankScores(scores).map((x) => x.index)).toEqual([1, 3, 2, 4, 0]);
  });

  it('does not mutate its input', () => {
    const scores = [s(0, 0.1), s(1, 0.9)];
    rankScores(scores);
    expect(scores.map((x) => x.index)).toEqual([0, 1]);
  });
});

describe('topK', () => {
  it('takes the k best and returns them in document order', () => {
    const scores = [s(0, 0.1), s(1, 0.95), s(2, 0.3), s(3, 0.8), s(4, 0.99), s(5, 0.2)];
    expect(topK(scores, 3).map((x) => x.index)).toEqual([1, 3, 4]);
  });

  it('breaks a tie at the k-th place in favour of the earlier sentence', () => {
    const scores = [s(0, 0.5), s(1, 0.9), s(2, 0.5), s(3, 0.5)];
    expect(topK(scores, 2).map((x) => x.index)).toEqual([0, 1]);
  });

  it('clamps k to N and to ≥ 0', () => {
    const scores = [s(0, 0.5), s(1, 0.9)];
    expect(topK(scores, 8).map((x) => x.index)).toEqual([0, 1]);
    expect(topK(scores, 0)).toEqual([]);
    expect(topK([], 4)).toEqual([]);
  });

  it('selected lowest score ≥ every unselected score', () => {
    const scores = Array.from({ length: 30 }, (_, i) => s(i, ((i * 7919) % 101) / 100));
    const sel = topK(scores, 6);
    const chosen = new Set(sel.map((x) => x.sid));
    const minSel = Math.min(...sel.map((x) => x.relevance));
    const maxRest = Math.max(...scores.filter((x) => !chosen.has(x.sid)).map((x) => x.relevance));
    expect(minSel).toBeGreaterThanOrEqual(maxRest);
  });
});
