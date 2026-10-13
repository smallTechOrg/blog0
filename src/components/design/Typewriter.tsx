'use client';

import { createElement, useEffect, useState } from 'react';

import { cx, prefersReducedMotion, typeClock, typeNow, typeStep } from './motion';

/* ------------------------------------------------------------------
   Typewriter — characters land in sequence on load. Every character is
   in the DOM from the first frame and only its visibility changes, so
   the line keeps its final width and nothing around it reflows as it
   types. Reduced motion gets the whole string at once.
   ------------------------------------------------------------------ */
export interface TypewriterProps {
  text: string;
  tag?: 'span' | 'p' | 'h1' | 'h2' | 'h3';
  className?: string;
  id?: string;
  /** ms after the page clock's origin before this line starts typing. */
  delay?: number;
}

export function Typewriter({ text: rawText, tag = 'span', className, id, delay = 0 }: TypewriterProps) {
  const text = String(rawText || '');
  const chars = text.split('');
  // Server HTML and the hydrating render both start at 0 (the CSS shows everything under reduced
  // motion); the first frame catches up to the shared clock.
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const len = text.length;
    const step = typeStep(len);
    /* mounting late is not a reason to start from the beginning */
    function caughtUp(): number {
      const el = typeNow() - (typeClock() + delay);
      if (el <= 0) return 0;
      return Math.min(len, Math.floor(el / step));
    }
    let raf = 0;
    let done = false;
    if (prefersReducedMotion()) {
      raf = window.requestAnimationFrame(() => setShown(len));
      return () => window.cancelAnimationFrame(raf);
    }
    function tick() {
      const want = caughtUp();
      setShown(want);
      if (want < len && !done) raf = window.requestAnimationFrame(tick);
    }
    raf = window.requestAnimationFrame(tick);
    return () => {
      done = true;
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [text, delay]);

  /* Spaces are emitted as bare text nodes, not as spans.

     A line split into per-character inline spans has nowhere to wrap if
     the spaces sit inside spans too: the browser sees one unbreakable run
     and a long line shoots off the side of the screen. A real text node
     between the characters is what gives it a break opportunity, and a
     space has no glyph, so nothing is lost by leaving it out of the fade. */
  const parts = chars.map((c, ci) =>
    c === ' ' ? (
      ' '
    ) : (
      <span key={ci} className={cx('typed__c', ci < shown && 'is-in')} aria-hidden="true">
        {c}
      </span>
    ),
  );
  return createElement(tag, { className: cx('typed', className), id, 'aria-label': text }, parts);
}
