'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect } from 'react';

import { prefersReducedMotion } from '@/components/design/motion';

export const BOOT_LINE_MS = 70; /* gap between one block landing and the next */

/* Selector list verbatim from the design's usePrintIn. */
const PRINT_SELECTOR =
  '.sitehead, main .home-sec > *, main .col > .pagehead, main .col > .archfilter, main .col > section > *, ' +
  'main .col > .aboutbody, .artwrap > *, .readhead, .listenview, .readbody > *, .prose > *, .rx, .artfoot, .modedock, .site-footer';

/** Lifts the first-load hold the root layout's script puts on `#blog0-root` (see additions.css). */
function releaseHold() {
  document.documentElement.removeAttribute('data-printing');
}

/* Every block on the page, in document order, gets a staggered delay. The
   candidates include containers and their children; only the innermost of
   each nesting prints on its own, so a paragraph is a line but the column
   that holds it is not. The classes come off again once the run is over,
   so nothing stays bound to the animation. */
export function PrintIn() {
  const pathname = usePathname();
  /* opening the deck rewrites /p/<slug> to /p/<slug>/tldr in place — that is
     the same page, not a new one, so it must not print again */
  const route = pathname.replace(/\/tldr$/, '');

  useLayoutEffect(() => {
    if (prefersReducedMotion()) {
      releaseHold();
      return;
    }
    const root = document.getElementById('blog0-root');
    if (!root) {
      releaseHold();
      return;
    }
    const all = Array.from(root.querySelectorAll<HTMLElement>(PRINT_SELECTOR));
    const leaves = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
    /* a short beat, then the page prints top to bottom */
    const lead = 160;
    leaves.forEach((el, i) => {
      el.classList.add('ln');
      el.style.animationDelay = lead + i * BOOT_LINE_MS + 'ms';
    });
    releaseHold();
    const total = lead + leaves.length * BOOT_LINE_MS + 200;
    const t = window.setTimeout(() => {
      leaves.forEach((el) => {
        el.classList.remove('ln');
        el.style.animationDelay = '';
      });
    }, total);
    return () => {
      window.clearTimeout(t);
      leaves.forEach((el) => {
        el.classList.remove('ln');
        el.style.animationDelay = '';
      });
    };
  }, [route]);

  return null;
}
