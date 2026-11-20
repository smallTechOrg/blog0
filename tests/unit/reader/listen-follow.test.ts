import { describe, expect, it } from 'vitest';

import { glideStep, paragraphProgress, READING_LINE, scrollTargetFor } from '@/components/reader/listen-follow';

const marks = [
  { pid: 'a', tMs: 0 },
  { pid: 'b', tMs: 10_000 },
  { pid: 'c', tMs: 30_000 },
];

describe('paragraphProgress (SMA-36)', () => {
  it('interpolates inside the live paragraph, up to the next mark or the end of the recording', () => {
    expect(paragraphProgress(marks, 0, 40_000)).toEqual({ index: 0, pid: 'a', fraction: 0 });
    expect(paragraphProgress(marks, 5_000, 40_000)).toEqual({ index: 0, pid: 'a', fraction: 0.5 });
    expect(paragraphProgress(marks, 20_000, 40_000)).toEqual({ index: 1, pid: 'b', fraction: 0.5 });
    expect(paragraphProgress(marks, 35_000, 40_000)).toEqual({ index: 2, pid: 'c', fraction: 0.5 });
    expect(paragraphProgress(marks, 99_000, 40_000)!.fraction).toBe(1);
  });

  it('is null before the first mark and clamps a zero-length paragraph to read', () => {
    expect(paragraphProgress([{ pid: 'a', tMs: 1_000 }], 500, 9_000)).toBeNull();
    expect(paragraphProgress([{ pid: 'a', tMs: 0 }, { pid: 'b', tMs: 0 }], 0, 9_000)).toMatchObject({ pid: 'b' });
    expect(paragraphProgress([{ pid: 'a', tMs: 5_000 }], 5_000, 5_000)!.fraction).toBe(1);
  });
});

describe('glideStep / scrollTargetFor', () => {
  it('eases towards the target without overshooting and snaps once within half a pixel', () => {
    const one = glideStep(0, 1000, 16);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(50);
    expect(glideStep(999.8, 1000, 16)).toBe(1000);
    expect(glideStep(100, 100, 16)).toBe(100);
    expect(glideStep(100, 200, 0)).toBe(100);
    let y = 0;
    for (let i = 0; i < 600; i++) y = glideStep(y, 1000, 16);
    expect(y).toBe(1000);
  });

  it('puts the line on the reading line of the band, never above the page top', () => {
    const anchor = 100 + (900 - 100) * READING_LINE;
    expect(scrollTargetFor(500, anchor, 100, 900)).toBe(500);
    expect(scrollTargetFor(500, anchor + 40, 100, 900)).toBe(540);
    expect(scrollTargetFor(10, 0, 100, 900)).toBe(0);
  });
});
