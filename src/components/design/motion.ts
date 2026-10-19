// Entrance motion + the page's single typing clock, ported from spec/design/design-app.js
// (prefersReducedMotion, useEnter, SPLIT_*, splitPieces, dekDelay, typeClock/typeNow/typeStep).
// Everything still renders fully with reduced motion; the design CSS forces the end state too.
// Imported only by client components (it pulls React hooks); not a boundary itself.

import { useEffect, useSyncExternalStore, type RefObject } from 'react';

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!(window.matchMedia && window.matchMedia(REDUCE_QUERY).matches);
  } catch {
    return false;
  }
}

/* Stage A — the intro (boot line typing, wordmark/tagline/About typing, print-in) plays only on
   the visit's first load of `/` (spec/ui.md §1 rule 4). The root layout's pre-paint script decides
   it and marks `<html data-intro="1">`; the first client navigation ends it, so every later page
   renders its text at first paint. */
export function introActive(): boolean {
  try {
    return typeof document !== 'undefined' && document.documentElement.dataset.intro === '1';
  } catch {
    return false;
  }
}

/** Ends the intro for the rest of this document (additions.css then shows every typed char). */
export function endIntro(): void {
  if (typeof document === 'undefined') return;
  delete document.documentElement.dataset.intro;
}

/** Whether a typed text should animate now: only during the intro, never with reduced motion. */
export function shouldType(): boolean {
  return introActive() && !prefersReducedMotion();
}

function subscribeReduce(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** Hydration-safe reduced-motion flag: `false` on the server and during hydration, then the
 *  real preference (so server HTML and the first client render always agree). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, prefersReducedMotion, () => false);
}

/* Adds .is-in once the element is on screen. Identical observer contract to
   useRevealFallback; it just does not defer to the view() timeline, because
   these elements start in view. */
export function useEnter(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
      el.classList.add('is-in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            el.classList.add('is-in');
            io.disconnect();
          }
        });
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
}

export const SPLIT_STAGGER = 55;
export const SPLIT_DUR = 620;
export const SPLIT_BUFFER = 40;
export const SPLIT_MAX = 1300;

export type SplitBy = 'word' | 'char';

export function splitPieces(text: string, by: SplitBy): string[] {
  return by === 'char' ? String(text).split('') : String(text).split(/\s+/).filter(Boolean);
}

/* The dek waits for the actual headline to finish, so a nine-word title does
   not get cut off by a delay tuned for a three-word one. */
export function dekDelay(text: string, by: SplitBy = 'word'): number {
  const n = splitPieces(text, by).length;
  return Math.min((n - 1) * SPLIT_STAGGER + SPLIT_DUR + SPLIT_BUFFER, SPLIT_MAX);
}

/* One clock for the whole load sequence.

   Each line used to start its own timer from its own mount, so the
   masthead and the About block were two independent animations that
   drifted apart, and anything that remounted replayed from zero. Every
   line now measures against a single origin: a line that mounts late
   catches up to where the sequence already is instead of restarting,
   which is what makes the whole page land as one choreographed beat. */
let TYPE_T0: number | null = null;

export function typeNow(): number {
  return typeof window !== 'undefined' && window.performance && window.performance.now
    ? window.performance.now()
    : Date.now();
}

export function typeClock(): number {
  if (TYPE_T0 === null) TYPE_T0 = typeNow();
  return TYPE_T0;
}

/* Long lines type faster, so every line takes about the same beat
   however many characters it holds. */
export const TYPE_RUN_MS = 820;

export function typeStep(len: number): number {
  if (!len) return 26;
  return Math.max(7, Math.min(26, TYPE_RUN_MS / len));
}

export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}
