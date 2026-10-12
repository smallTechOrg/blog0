'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef } from 'react';

import { prefersReducedMotion } from '@/components/design/motion';

/* ------------------------------------------------------------------
   Boot: "> start of <brand>" types in at the top of every page, and the
   page's blocks then print in one after another, top to bottom.
   ------------------------------------------------------------------ */
/** Divergence 6: the design ships the strip but its App never renders it; we do. */
export const SHOW_BOOT_STRIP = true;

export const BOOT_TYPE_MS = 45; /* per character of the boot line */
export const BOOT_LINE_MS = 70; /* gap between one block landing and the next */
/** How long the typed line has the screen to itself. Declared by the design but never applied
 *  there (its print-in starts on its own 160 ms lead); kept verbatim and unused, like the design. */
export const BOOT_HOLD_MS = 420;

/** The design's route for a pathname: 'home' | 'archive' | 'about' | <article slug>.
 *  `/p/<slug>`, `/p/<slug>/tldr` and `/p/<slug>/listen` are one route (opening the deck
 *  rewrites the address in place, which is not a new page). */
export function bootRouteKey(pathname: string): string {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path === '') return 'home';
  if (path === '/archive') return 'archive';
  if (path === '/about') return 'about';
  const art = /^\/p\/([^/]+)(?:\/(?:tldr|listen))?$/.exec(path);
  if (art) return decodeURIComponent(art[1]);
  return path.replace(/^\/+/, '');
}

/* The strip is a one-line terminal pinned above the header. The first
   thing it ever prints is "> start of <brand>"; after that every move to a
   new page is typed as a command before the page itself prints. */
export function bootCommand(route: string, opts: { first: boolean; brand: string }): string {
  if (opts.first) return '> start of ' + opts.brand;
  if (route === 'home') return '> cd ~';
  if (route === 'archive') return '> ls archive';
  if (route === 'about') return '> cat about';
  return '> open ' + route;
}

/* One session = one page load: the module lives until a full reload. */
let bootFirst = true;

export interface BootProps {
  /** Site wordmark (site record), e.g. "blog0". */
  brand: string;
}

export function Boot({ brand }: BootProps) {
  const pathname = usePathname();
  const route = bootRouteKey(pathname);
  const ref = useRef<HTMLSpanElement>(null);
  /* the line chosen for this route — so a dev-mode effect replay retypes the
     same command instead of mistaking itself for a later navigation */
  const chosen = useRef<{ route: string; line: string } | null>(null);

  /* A layout effect, so the prompt is reset before the first paint (the
     server HTML carries the whole start line for readers without JS). */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let line: string;
    if (chosen.current && chosen.current.route === route) {
      line = chosen.current.line;
    } else {
      line = bootCommand(route, { first: bootFirst, brand });
      chosen.current = { route, line };
    }
    bootFirst = false;
    if (prefersReducedMotion()) {
      el.textContent = line;
      return;
    }
    /* a new command replaces the old one from the prompt onward */
    el.textContent = '>';
    let i = 1;
    const t = window.setInterval(() => {
      el.textContent = line.slice(0, ++i);
      if (i >= line.length) window.clearInterval(t);
    }, BOOT_TYPE_MS);
    return () => window.clearInterval(t);
  }, [route, brand]);

  if (!SHOW_BOOT_STRIP) return null;
  return (
    <div className="boot" aria-hidden="true">
      <div className="boot__in">
        <span ref={ref} suppressHydrationWarning>
          {'> start of ' + brand}
        </span>
        <span className="boot__us">_</span>
      </div>
    </div>
  );
}
