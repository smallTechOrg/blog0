'use client';

import { useEffect, useState } from 'react';

import { cx, prefersReducedMotion, typeClock, typeNow } from './motion';

/* The wordmark types itself in, and its final round letter keeps turning
   until the reader scrolls — an idle state for the landing, not a
   scroll-driven effect. */
export interface WordmarkProps {
  /** The site's wordmark (site record, e.g. "log0"). */
  text: string;
  /** the colophon just needs the name — no typing, no turning letter */
  plain?: boolean;
}

const WORDMARK_STEP_MS = 60;

export function Wordmark({ text: rawText, plain }: WordmarkProps) {
  const text = String(rawText);
  // Starts at 0 on the server and while hydrating; the effect catches up to the page clock.
  const [shown, setShown] = useState(0);

  /* same page clock as every other typed line, so the masthead and the
     About block below it read as one sequence rather than two */
  useEffect(() => {
    if (plain) return;
    const len = text.length;
    let raf = 0;
    let done = false;
    if (prefersReducedMotion()) {
      raf = window.requestAnimationFrame(() => setShown(len));
      return () => window.cancelAnimationFrame(raf);
    }
    function tick() {
      const want = Math.min(len, Math.max(0, Math.floor((typeNow() - typeClock()) / WORDMARK_STEP_MS)));
      setShown(want);
      if (want < len && !done) raf = window.requestAnimationFrame(tick);
    }
    raf = window.requestAnimationFrame(tick);
    return () => {
      done = true;
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [text, plain]);

  if (plain) return <span className="wordmark">{text}</span>;

  const head = text.slice(0, -1);
  const tail = text.slice(-1);
  /* The nought turns at all times now — it used to stop on the first
     scroll. Reduced motion still holds it still (the design CSS stops
     .wordmark__o.is-spin under prefers-reduced-motion). */
  return (
    <span className="wordmark" aria-label={text}>
      {/* a space in the head is a no-break space, as in the design: a bare space inside an
          inline span would collapse to nothing and the wordmark would lose its gap */}
      {head.split('').map((c, i) => (
        <span key={i} className={cx('typed__c', i < shown && 'is-in')} aria-hidden="true">
          {c === ' ' ? '\u00A0' : c}
        </span>
      ))}
      <span className={cx('typed__c', 'wordmark__o', shown >= text.length && 'is-in', 'is-spin')} aria-hidden="true">
        {tail}
      </span>
    </span>
  );
}
