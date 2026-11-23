import { describe, expect, it } from 'vitest';

import { reconcileSlides } from '@/lib/deck/reconcile';

const line = (sid: string, text: string) => ({ sid, text });
const slide = (sid: string, text: string) => ({ sid, text, source: 'writer' as const });

describe('reconcileSlides (SMA-52)', () => {
  it('leaves an unchanged deck untouched (same objects)', () => {
    const slides = [slide('a-s0', 'One'), slide('b-s0', 'Two')];
    const r = reconcileSlides(slides, [line('a-s0', 'One'), line('b-s0', 'Two')]);

    expect(r.slides).toEqual(slides);
    expect(r.slides[0]).toBe(slides[0]);
    expect(r.missing).toEqual([]);
    expect(r.rebased).toBe(false);
  });

  it('re-attaches a slide whose sentence got a new id (paragraph edited / lines shifted)', () => {
    const r = reconcileSlides([slide('old-s1', 'Keep me.')], [line('new-s0', 'Something new.'), line('new-s1', 'Keep me.')]);

    expect(r.slides[0].sid).toBe('new-s1');
    expect(r.missing).toEqual([]);
    expect(r.rebased).toBe(true);
  });

  it('flags only the slide whose text is gone, keeping its place in the deck', () => {
    const r = reconcileSlides([slide('a', 'Stays'), slide('b', 'Edited away'), slide('c', 'Also stays')], [line('x', 'Stays'), line('z', 'Also stays')]);

    expect(r.slides.map((s) => s.sid)).toEqual(['x', 'b', 'z']);
    expect(r.missing).toEqual(['b']);
  });

  it('never gives two slides the same line, and gives a missing slide a sid of its own when its old one was taken', () => {
    // slide A's old sentence X now holds the text slide B wants; A's own text is gone
    const r = reconcileSlides([slide('X', 'A is gone'), slide('Y', 'B text')], [line('X', 'B text')]);

    expect(new Set(r.slides.map((s) => s.sid)).size).toBe(2);
    expect(r.slides[1].sid).toBe('X');
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).not.toBe('X');
  });

  it('keeps duplicate texts on their own lines, and ignores image slides', () => {
    const img = { sid: 'img:1', text: '', image: { assetId: '1' } };
    const r = reconcileSlides([slide('a', 'Same.'), img, slide('b', 'Same.')], [line('a', 'Same.'), line('b', 'Same.')]);

    expect(r.slides.map((s) => s.sid)).toEqual(['a', 'img:1', 'b']);
    expect(r.missing).toEqual([]);
  });
});
