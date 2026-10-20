import { describe, expect, it } from 'vitest';

import {
  NARROW_PX,
  clickTagPath,
  menuPlacement,
  nativeShareFallback,
  paragraphIdFromHash,
  prefersNativeShare,
  shareClickIgnored,
} from '@/lib/share-surface';

// spec/capabilities/paragraph-share.md "Business Rules" + spec/ui.md §3 Share "Surface selection".

describe('prefersNativeShare', () => {
  it('uses the native sheet on a touch device that has navigator.share', () => {
    expect(prefersNativeShare({ hasShare: true, coarsePointer: true, viewportWidth: 1024 })).toBe(true);
  });
  it('uses the native sheet on a narrow viewport (< 720 px) with navigator.share', () => {
    expect(prefersNativeShare({ hasShare: true, coarsePointer: false, viewportWidth: 390 })).toBe(true);
    expect(prefersNativeShare({ hasShare: true, coarsePointer: false, viewportWidth: NARROW_PX - 1 })).toBe(true);
  });
  it('keeps the menu on a wide pointer-fine desktop even with navigator.share (720 px is not narrow)', () => {
    expect(NARROW_PX).toBe(720);
    expect(prefersNativeShare({ hasShare: true, coarsePointer: false, viewportWidth: 720 })).toBe(false);
    expect(prefersNativeShare({ hasShare: true, coarsePointer: false, viewportWidth: 1440 })).toBe(false);
  });
  it('falls back to the menu wherever navigator.share is absent', () => {
    expect(prefersNativeShare({ hasShare: false, coarsePointer: true, viewportWidth: 390 })).toBe(false);
  });
});

describe('nativeShareFallback', () => {
  it('does nothing more when the reader dismissed the sheet (AbortError)', () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(nativeShareFallback(abort)).toBe('none');
    expect(nativeShareFallback({ name: 'AbortError' })).toBe('none');
  });
  it('opens the menu on any other failure', () => {
    expect(nativeShareFallback(new Error('x'))).toBe('menu');
    expect(nativeShareFallback(Object.assign(new Error('no'), { name: 'NotAllowedError' }))).toBe('menu');
    expect(nativeShareFallback(undefined)).toBe('menu');
    expect(nativeShareFallback('weird')).toBe('menu');
  });
});

describe('paragraphIdFromHash', () => {
  it('reads #p-xxxxxxxx and duplicate-suffixed ids', () => {
    expect(paragraphIdFromHash('#p-0a1b2c3d')).toBe('p-0a1b2c3d');
    expect(paragraphIdFromHash('#p-0a1b2c3d-3')).toBe('p-0a1b2c3d-3');
  });
  it('ignores everything else', () => {
    expect(paragraphIdFromHash('')).toBeNull();
    expect(paragraphIdFromHash('#')).toBeNull();
    expect(paragraphIdFromHash('#hl=p-0a1b2c3d-s0')).toBeNull();
    expect(paragraphIdFromHash('#p-XYZ')).toBeNull();
    expect(paragraphIdFromHash('#p-0a1b2c3d"><img')).toBeNull();
    expect(paragraphIdFromHash('#fn-1')).toBeNull();
  });
});

describe('menuPlacement (design placeFor: 272 px menu, 12 px pad)', () => {
  const vp = { width: 1280, height: 800 };
  const rect = (left: number, top: number, bottom: number) => ({ left, top, bottom });

  it('opens 10 px below the last line, at its left edge', () => {
    expect(menuPlacement([rect(100, 200, 230)], rect(100, 200, 230), vp)).toEqual({ x: 100, y: 240 });
  });
  it('clamps to the viewport horizontally', () => {
    expect(menuPlacement([], rect(1200, 100, 120), vp).x).toBe(1280 - 272 - 12);
    expect(menuPlacement([], rect(-40, 100, 120), vp).x).toBe(12);
  });
  it('flips above the first line when there is no room below', () => {
    const first = rect(100, 600, 630);
    expect(menuPlacement([first, rect(100, 640, 670)], rect(100, 640, 670), vp)).toEqual({ x: 100, y: 600 - 236 });
  });
  it('never goes above the top pad', () => {
    expect(menuPlacement([rect(10, 100, 700)], rect(10, 680, 790), { width: 320, height: 800 }).y).toBe(12);
  });
});

describe('shareClickIgnored', () => {
  it('ignores clicks on links, buttons, form controls and figures', () => {
    for (const tag of ['a', 'button', 'input', 'textarea', 'select', 'label', 'summary', 'figure', 'video', 'audio']) {
      expect(shareClickIgnored([tag, 'p'])).toBe(true);
    }
  });
  it('takes plain text clicks (spans, em, code inside a paragraph)', () => {
    expect(shareClickIgnored(['em', 'p'])).toBe(false);
    expect(shareClickIgnored(['code', 'li'])).toBe(false);
    expect(shareClickIgnored(['p'])).toBe(false);
  });
});

describe('clickTagPath', () => {
  type El = { tagName: string; parentElement: El | null };
  const para: El = { tagName: 'P', parentElement: { tagName: 'DIV', parentElement: null } };
  const em: El = { tagName: 'EM', parentElement: para };
  const link: El = { tagName: 'A', parentElement: em };

  it('lists the lower-cased tags from the target up to, not including, the stop element', () => {
    expect(clickTagPath(link, para)).toEqual(['a', 'em']);
    expect(clickTagPath(em, para)).toEqual(['em']);
    expect(clickTagPath(para, para)).toEqual([]);
  });
  it('walks to the root when the stop element is not an ancestor, and is empty for no target', () => {
    expect(clickTagPath(em, null)).toEqual(['em', 'p', 'div']);
    expect(clickTagPath(null, para)).toEqual([]);
  });
});
