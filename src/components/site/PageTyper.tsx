'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect } from 'react';

import { setTypingRoute, shouldType } from '@/components/design/motion';
import { typePage } from '@/components/design/page-typer';

/* Mounted once by the site layout. On every route (document load or client navigation) it
   re-decides the typing mark and, on Home, Archive and About, types the whole page in — before
   the new page paints, so no text flashes in first. `data-typer` tells additions.css the engine
   has taken over from the pre-paint hide. */
export function PageTyper() {
  const pathname = usePathname();
  /* opening the deck rewrites /p/<slug> to /p/<slug>/tldr in place — the same page */
  const route = pathname.replace(/\/tldr$/, '');

  useLayoutEffect(() => {
    setTypingRoute(route);
    const root = document.getElementById('blog0-root');
    const stop = shouldType() && root ? typePage(root, { windowTop: () => document.querySelector('.sitehead')?.getBoundingClientRect().bottom ?? 0 }) : () => {};
    document.documentElement.setAttribute('data-typer', '');
    return stop;
  }, [route]);

  return null;
}
