'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { prefersReducedMotion } from '@/components/design/motion';
import { paragraphLink, quoteSubject } from '@/lib/share-links';
import { paragraphIdFromHash, shareClickIgnored } from '@/lib/share-surface';

import { placeAgainst, type ShareController } from './ShareMenu';

/* ============================================================
   Paragraph share (design HLProvider + AnnotationLayer, unit =
   paragraph, divergence 2)
   ------------------------------------------------------------
   One delegated listener covers every .para in the reading column,
   however it got there (the pipeline's injected html). The highlight
   is toggled straight on the DOM so the memoised prose never
   re-renders. A tap/click shares the paragraph; a drag-selection of
   3+ characters shares the selected words with the link of the
   paragraph it starts in; #p-… in the address scrolls to and lights
   that paragraph on arrival.
   ============================================================ */

export interface ParagraphShareProps {
  /** The reading column (`.readbody`); only its `.para` elements are shareable. */
  scopeRef: RefObject<HTMLElement | null>;
  /** Absolute article URL — paragraph links are `<articleUrl>#<pid>`. */
  articleUrl: string;
  brand: string;
  /** The host's share surface (one per page, shared with Share article). */
  controller: ShareController;
}

/** Paragraph text without footnote reference markers. */
function paragraphText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('a[data-footnote-ref]').forEach((a) => (a.closest('sup') ?? a).remove());
  return clone.textContent ?? '';
}

function setHash(hash: string) {
  try {
    const base = window.location.pathname + window.location.search;
    window.history.replaceState(window.history.state, '', hash ? base + '#' + hash : base);
  } catch {
    /* history unavailable (sandboxed frames) — sharing still works */
  }
}

export function ParagraphShare({ scopeRef, articleUrl, brand, controller }: ParagraphShareProps) {
  const activeRef = useRef<string | null>(null);
  const live = useRef({ articleUrl, brand, controller });
  useLayoutEffect(() => {
    live.current = { articleUrl, brand, controller };
  });

  useEffect(() => {
    function scope(): HTMLElement | null {
      return scopeRef.current;
    }
    function paraOf(node: Node | null): HTMLElement | null {
      const root = scope();
      const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
      const p = el?.closest<HTMLElement>('.para') ?? null;
      return p && p.id && root && root.contains(p) ? p : null;
    }
    function byId(pid: string | null): HTMLElement | null {
      const root = scope();
      const el = pid ? document.getElementById(pid) : null;
      return el && root && root.contains(el) ? el : null;
    }

    function setActive(pid: string | null) {
      const prev = activeRef.current;
      if (prev && prev !== pid) {
        const pe = byId(prev) ?? document.getElementById(prev);
        pe?.classList.remove('is-hl');
      }
      activeRef.current = pid;
      byId(pid)?.classList.add('is-hl');
    }

    const ignore = (t: Element) => paraOf(t) != null;

    function pick(p: HTMLElement, keyboard: boolean) {
      const { controller: c, articleUrl: url, brand: b } = live.current;
      // the lit paragraph again: clear it and close the menu
      if (activeRef.current === p.id) {
        setActive(null);
        c.close();
        setHash('');
        return;
      }
      setActive(p.id);
      const subject = quoteSubject('paragraph', paragraphText(p), paragraphLink(url, p.id), b);
      c.share(subject, { place: () => placeAgainst(p), ignore, returnFocus: keyboard ? p : null });
      setHash(p.id);
    }

    function selectedText(): string {
      const g = window.getSelection();
      return g && !g.isCollapsed ? String(g).trim() : '';
    }

    function onClick(e: MouseEvent) {
      const p = paraOf(e.target as Node);
      if (!p) return;
      // links, buttons and figures inside a paragraph keep their own behaviour
      const path: string[] = [];
      for (let n = e.target as Element | null; n && n !== p; n = n.parentElement) path.push(n.tagName.toLowerCase());
      if (shareClickIgnored(path)) return;
      // a drag that left a selection is the selection gesture, not a tap
      if (selectedText().length > 2) return;
      pick(p, false);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target as Element | null;
      if (!t || !(t instanceof HTMLElement) || !t.classList.contains('para')) return;
      const p = paraOf(t);
      if (!p) return;
      e.preventDefault();
      pick(p, true);
    }

    function onUp(e: Event) {
      const t = e.target as Element | null;
      if (t && t instanceof Element && t.closest('.hlmenu')) return;
      window.setTimeout(() => {
        const g = window.getSelection();
        if (!g || g.isCollapsed || g.rangeCount === 0) return;
        const text = String(g).trim();
        if (text.length < 3) return;
        const range = g.getRangeAt(0);
        // a selection spanning paragraphs belongs to the one it starts in
        const p = paraOf(range.startContainer);
        if (!p) return;
        const rect = range.getBoundingClientRect();
        if (!rect || !rect.width) return;
        const { controller: c, articleUrl: url, brand: b } = live.current;
        setActive(p.id);
        const subject = quoteSubject('selection', text, paragraphLink(url, p.id), b);
        c.share(subject, { place: () => placeAgainst(range), ignore });
        setHash(p.id);
      }, 0);
    }

    /* deep link: #p-… scrolls to and lights that paragraph, menu closed */
    function fromHash() {
      const pid = paragraphIdFromHash(window.location.hash);
      const el = byId(pid);
      if (!pid || !el) return;
      el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
      setActive(pid);
    }

    /* every paragraph is reachable by keyboard (Enter/Space opens it) */
    scope()
      ?.querySelectorAll<HTMLElement>('.para[id]')
      .forEach((p) => {
        if (!p.hasAttribute('tabindex')) p.tabIndex = 0;
      });

    const t = window.setTimeout(fromHash, 180);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    window.addEventListener('hashchange', fromHash);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
      window.removeEventListener('hashchange', fromHash);
      setActive(null);
    };
  }, [scopeRef, articleUrl]);

  return null;
}
