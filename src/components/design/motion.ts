// Entrance motion + the page's single typing clock, ported from spec/design/design-app.js
// (prefersReducedMotion, useEnter, SPLIT_*, splitPieces, dekDelay).
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

/* Typing scope (owner decision, UI review 2026-10-20): Home, /archive and /about type the whole
   page in (components/design/page-typer.ts) on every arrival — a document load (the pre-paint
   script marks `<html data-typing="1">`) or a client navigation (`setTypingRoute`). Everywhere
   else the page is complete at first paint. */
export const TYPE_ROUTES = ['/', '/archive', '/about'] as const;

export function isTypeRoute(pathname: string): boolean {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  return (TYPE_ROUTES as readonly string[]).includes(p);
}

/** `<html data-typing="1">`: this page types in. */
export function typingActive(): boolean {
  try {
    return typeof document !== 'undefined' && document.documentElement.dataset.typing === '1';
  } catch {
    return false;
  }
}

/** Whether the page should type now: on a typing page, never with reduced motion. */
export function shouldType(): boolean {
  return typingActive() && !prefersReducedMotion();
}

/** Called on every client route change: marks typing routes or clears the mark. */
export function setTypingRoute(pathname: string): void {
  if (typeof document === 'undefined') return;
  if (isTypeRoute(pathname) && !prefersReducedMotion()) document.documentElement.dataset.typing = '1';
  else delete document.documentElement.dataset.typing;
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

export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}
