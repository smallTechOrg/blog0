'use client';

import { useEffect, useLayoutEffect, useState } from 'react';

// Shared behaviour of the full-viewport overlays (the TLDR deck and the card's Listen sheet).

/** Where the site header ends (px), so an overlay starts under it and the header stays in view.
 *  Measured rather than assumed: the header is taller before it compacts. */
export function useHeadTop(): number {
  const [headTop, setHeadTop] = useState(0);
  useLayoutEffect(() => {
    function measure() {
      const el = document.querySelector('.sitehead');
      setHeadTop(el ? Math.max(0, Math.round(el.getBoundingClientRect().bottom)) : 0);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return headTop;
}

function scrollOffset(): number {
  return window.pageYOffset || document.documentElement.scrollTop || 0;
}

/**
 * Locks the page underneath while the overlay is open (`overscroll` also stops the rubber-band).
 * Locking can clamp the page's scroll, so the offset is recorded on open and put back on close —
 * the reader lands exactly where they left off.
 */
export function usePageLock({ overscroll = false }: { overscroll?: boolean } = {}): void {
  useEffect(() => {
    const at = scrollOffset();
    const root = document.documentElement;
    const prevOverflow = document.body.style.overflow;
    const prevOverscroll = root.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    if (overscroll) root.style.overscrollBehavior = 'none';
    return () => {
      document.body.style.overflow = prevOverflow;
      if (overscroll) root.style.overscrollBehavior = prevOverscroll;
      window.requestAnimationFrame(() => {
        if (Math.abs(scrollOffset() - at) <= 2) return;
        try {
          window.scrollTo({ top: at, behavior: 'auto' });
        } catch {
          window.scrollTo(0, at);
        }
      });
    };
  }, [overscroll]);
}
