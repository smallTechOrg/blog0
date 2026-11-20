'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect } from 'react';

import { ARTICLE_TYPE_ROUTE, setTypingRoute, shouldType } from '@/components/design/motion';
import { typePage } from '@/components/design/page-typer';

/* Mounted once by the site layout. On every route (document load or client navigation) it
   re-decides the typing mark and, on Home, Archive, About and an article's Read page, types the whole page in — before
   the new page paints, so no text flashes in first. `data-typer` tells additions.css the engine
   has taken over from the pre-paint hide. */
export function PageTyper() {
  const pathname = usePathname();
  /* opening the deck rewrites /p/<slug> to /p/<slug>/tldr in place — the same page */
  const route = pathname.replace(/\/tldr$/, '');

  /* the typing decision reads the real path, so a deck opened straight from /p/<slug>/tldr never
     types the article behind it; opening it in place keeps `route`, so the effect does not re-run */
  useLayoutEffect(() => {
    setTypingRoute(pathname);
    const root = document.getElementById('blog0-root');
    /* lift the pre-paint hide first so the typewriter measures the real paint, with transitions
       held (a colour mid-transition would read as transparent); all in this frame */
    const html = document.documentElement;
    html.setAttribute('data-typer-measure', '');
    html.setAttribute('data-typer', '');
    const stop = shouldType() && root ? typePage(root, { windowTop: () => document.querySelector('.sitehead')?.getBoundingClientRect().bottom ?? 0, pinned: document.querySelector('.sitehead'), untilFold: ARTICLE_TYPE_ROUTE.test(route) }) : () => {};
    void document.body.offsetWidth; // apply the hidden ink before transitions come back
    html.removeAttribute('data-typer-measure');
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per page (`route`), not when the deck opens in place
  }, [route]);

  return null;
}
