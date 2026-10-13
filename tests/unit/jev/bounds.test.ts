import { describe, expect, it } from 'vitest';

import { computeBounds } from '@/server/jev/bounds';

const sentences = (n: number, totalWords: number) =>
  Array.from({ length: n }, (_, i) => ({ words: Math.floor(totalWords / n) + (i < totalWords % n ? 1 : 0) }));

describe('computeBounds', () => {
  it.each([
    // [N, W, min, max, target]
    [20, 300, 4, 6, 5],
    [40, 700, 5, 7, 6],
    [60, 1500, 7, 8, 8],
    [200, 5000, 7, 8, 8],
    [10, 100, 4, 5, 4],
    [10, 250, 4, 5, 4],
    [10, 251, 4, 6, 5],
    [3, 60, 3, 3, 3],
    [1, 8, 1, 1, 1],
    [5, 2000, 5, 5, 5],
    [0, 0, 0, 0, 0],
  ])('N=%i W=%i → min %i, max %i, target %i', (n, w, min, max, target) => {
    expect(computeBounds(sentences(n, w))).toEqual({ min, max, target });
  });
});
