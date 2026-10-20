// When does a scroll close the open share menu? (Pure — unit-tested in tests/unit/reader.)
// Opening a menu often triggers the page's own scroll: a scroll-into-view of the picked paragraph,
// or a smooth deep-link scroll still settling. So for SCROLL_GRACE_MS after opening, scrolls are
// absorbed and the reference position follows them ('rebase'); afterwards the menu closes only
// once the page has moved more than SCROLL_CLOSE_PX from that reference.

export const SCROLL_GRACE_MS = 300;
export const SCROLL_CLOSE_PX = 24;

export interface ScrollPoint {
  x: number;
  y: number;
}

export type ShareScrollDecision = 'rebase' | 'keep' | 'close';

export function shareScrollDecision(input: {
  openedAt: number;
  now: number;
  anchor: ScrollPoint;
  current: ScrollPoint;
}): ShareScrollDecision {
  const { openedAt, now, anchor, current } = input;
  if (now - openedAt < SCROLL_GRACE_MS) return 'rebase';
  const moved = Math.max(Math.abs(current.x - anchor.x), Math.abs(current.y - anchor.y));
  return moved > SCROLL_CLOSE_PX ? 'close' : 'keep';
}
