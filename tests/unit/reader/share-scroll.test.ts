import { describe, expect, it } from 'vitest';

import { SCROLL_CLOSE_PX, SCROLL_GRACE_MS, shareScrollDecision } from '@/components/reader/share-scroll';

// spec/ui.md §3 Share — the menu closes on a reader's scroll, not on the page's own
// scroll-into-view or a smooth deep-link scroll right after opening.

const at = (y: number, x = 0) => ({ x, y });

describe('shareScrollDecision', () => {
  it('uses a 300 ms grace window and a 24 px threshold', () => {
    expect(SCROLL_GRACE_MS).toBe(300);
    expect(SCROLL_CLOSE_PX).toBe(24);
  });

  it('absorbs (rebases on) any scroll inside the grace window, however far', () => {
    expect(shareScrollDecision({ openedAt: 1000, now: 1000, anchor: at(0), current: at(800) })).toBe('rebase');
    expect(shareScrollDecision({ openedAt: 1000, now: 1000 + SCROLL_GRACE_MS - 1, anchor: at(0), current: at(5) })).toBe('rebase');
  });

  it('keeps the menu for small drift after the grace window (boundary: exactly 24 px stays open)', () => {
    expect(shareScrollDecision({ openedAt: 0, now: SCROLL_GRACE_MS, anchor: at(500), current: at(500) })).toBe('keep');
    expect(shareScrollDecision({ openedAt: 0, now: 5000, anchor: at(500), current: at(524) })).toBe('keep');
    expect(shareScrollDecision({ openedAt: 0, now: 5000, anchor: at(500), current: at(476) })).toBe('keep');
  });

  it('closes once the page moves more than 24 px from the reference, in either axis or direction', () => {
    expect(shareScrollDecision({ openedAt: 0, now: 5000, anchor: at(500), current: at(525) })).toBe('close');
    expect(shareScrollDecision({ openedAt: 0, now: 5000, anchor: at(500), current: at(400) })).toBe('close');
    expect(shareScrollDecision({ openedAt: 0, now: 5000, anchor: at(500, 0), current: at(500, 30) })).toBe('close');
  });
});
