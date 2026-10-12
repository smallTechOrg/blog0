'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { Icon } from '@/components/design/Icon';
import { cx } from '@/components/design/motion';
import {
  clipboardText,
  menuLabel,
  nativeShareData,
  shareStatus,
  shareTargets,
  type ShareKind,
  type ShareSubject,
} from '@/lib/share-links';
import { menuPlacement, nativeShareFallback, prefersNativeShare } from '@/lib/share-surface';

import { copyToClipboard } from './clipboard';

/* ============================================================
   Share — one menu for a paragraph, the article and the deck
   ------------------------------------------------------------
   The design's HLProvider menu (.hlmenu), widened to six targets
   (divergence 3). Every share copies its text + link first; touch
   or narrow screens with a native sheet get the sheet, everything
   else (and a sheet that fails) gets the popover.
   ============================================================ */

/** Used only when a host renders the reader without the site record's wordmark (the admin
 *  deck preview); public pages pass `site.wordmark`. */
export const FALLBACK_BRAND = 'blog0';

export interface ShareMenuProps {
  subject: ShareSubject;
  brand: string;
  /** Clipboard result for the subject's text + link: `null` while pending. */
  copied: boolean | null;
  x: number;
  y: number;
  menuRef?: RefObject<HTMLDivElement | null>;
}

/** The popover itself (design `.hlmenu`): status line, six options, foot. Fixed-positioned. */
export function ShareMenu({ subject, brand, copied, x, y, menuRef }: ShareMenuProps) {
  const [linkCopied, setLinkCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  function copyLink() {
    void copyToClipboard(subject.link).then((ok) => {
      if (!ok) return;
      setLinkCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setLinkCopied(false), 1800);
    });
  }

  return (
    <div
      ref={menuRef}
      className="hlmenu"
      role="dialog"
      aria-label={menuLabel(subject.kind)}
      style={{ left: x + 'px', top: y + 'px' }}
    >
      <div className="hlmenu__status" aria-live="polite">
        {copied === false ? null : <Icon name={copied ? 'check' : 'copy'} size={14} />}
        {shareStatus(subject.kind, copied)}
      </div>
      <div className="hlmenu__grid">
        {shareTargets(subject, brand).map((o) =>
          o.href == null ? (
            <button
              key={o.key}
              type="button"
              className={cx('hlmenu__opt', linkCopied && 'is-done')}
              onClick={copyLink}
              aria-label={linkCopied ? 'Link copied' : 'Copy link'}
            >
              <Icon name={linkCopied ? 'check' : o.icon} size={18} />
              {linkCopied ? 'Link copied' : o.label}
            </button>
          ) : (
            <a
              key={o.key}
              className="hlmenu__opt"
              href={o.href}
              target={o.newTab ? '_blank' : undefined}
              rel={o.newTab ? 'noopener noreferrer' : undefined}
            >
              <Icon name={o.icon} size={18} />
              {o.label}
            </a>
          ),
        )}
      </div>
      <div className="hlmenu__foot">No sign-in needed.</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface OpenMenu {
  subject: ShareSubject;
  x: number;
  y: number;
  copied: boolean | null;
}

export interface ShareOptions {
  /** Where the menu goes, measured when it opens (design `placeFor`). */
  place: () => { x: number; y: number };
  /** Pointer-downs on these targets do not close the menu (e.g. the paragraphs, which re-pick). */
  ignore?: (target: Element) => boolean;
  /** Keyboard-opened: focus the first option, and hand focus back here on Escape. */
  returnFocus?: HTMLElement | null;
}

export interface ShareController {
  /** Copies the subject, then opens the native sheet or the menu (spec/ui.md §3 surface rule). */
  share: (subject: ShareSubject, opts: ShareOptions) => void;
  close: () => void;
  isOpen: boolean;
  /** The open menu's subject kind (for `aria-expanded` on the button that opened it). */
  openKind: ShareKind | null;
  /** Render this where the menu should live (inside `.tdeck` for the deck). */
  menu: ReactNode;
}

/** Places the menu against an element's client rects (last line; flips above the first). */
export function placeAgainst(el: Element | Range): { x: number; y: number } {
  const rects = el.getClientRects();
  const r = rects.length ? rects[rects.length - 1] : el.getBoundingClientRect();
  return menuPlacement(rects, r, { width: window.innerWidth, height: window.innerHeight });
}

function nativeShareWanted(): boolean {
  try {
    return prefersNativeShare({
      hasShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
      coarsePointer: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
      viewportWidth: window.innerWidth,
    });
  } catch {
    return false;
  }
}

/** One share surface: state, clipboard, native sheet, and the close rules (outside pointer,
 *  Escape — which stops there, so a host deck stays open — and scroll). */
export function useShare(brand: string): ShareController {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optsRef = useRef<ShareOptions | null>(null);
  const brandRef = useRef(brand);
  useLayoutEffect(() => {
    brandRef.current = brand;
  });

  const close = useCallback(() => setOpen(null), []);

  const share = useCallback((subject: ShareSubject, opts: ShareOptions) => {
    optsRef.current = opts;
    // Both start inside the reader's gesture: the clipboard write and (on touch) the sheet.
    const copying = copyToClipboard(clipboardText(subject));
    function showMenu() {
      const at = opts.place();
      setOpen({ subject, x: at.x, y: at.y, copied: null });
      void copying.then((ok) =>
        setOpen((cur) => (cur && cur.subject === subject ? { ...cur, copied: ok } : cur)),
      );
    }
    if (nativeShareWanted()) {
      setOpen(null);
      let p: Promise<void>;
      try {
        p = navigator.share(nativeShareData(subject, brandRef.current));
      } catch (err) {
        p = Promise.reject(err);
      }
      p.catch((err: unknown) => {
        if (nativeShareFallback(err) === 'menu') showMenu();
      });
      return;
    }
    showMenu();
  }, []);

  const isOpen = open != null;

  /* keyboard-opened menus take focus so Tab walks the options */
  useEffect(() => {
    if (isOpen && optsRef.current?.returnFocus) {
      menuRef.current?.querySelector<HTMLElement>('.hlmenu__opt')?.focus({ preventScroll: true });
    }
  }, [isOpen]);

  /* close on outside pointer, Escape or scroll — a paragraph highlight stays */
  useEffect(() => {
    if (!isOpen) return;
    function onDown(e: Event) {
      const t = e.target as Element | null;
      if (!t || !(t instanceof Element)) return;
      if (menuRef.current && menuRef.current.contains(t)) return;
      if (optsRef.current?.ignore?.(t)) return;
      setOpen(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Escape closes only the menu — not the deck it may sit in.
      e.stopPropagation();
      e.preventDefault();
      setOpen(null);
      optsRef.current?.returnFocus?.focus({ preventScroll: true });
    }
    function onScroll() {
      setOpen(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll);
    };
  }, [isOpen]);

  const menu = open ? (
    <ShareMenu
      key={open.subject.kind + open.subject.link + open.subject.text}
      subject={open.subject}
      brand={brand}
      copied={open.copied}
      x={open.x}
      y={open.y}
      menuRef={menuRef}
    />
  ) : null;

  return { share, close, isOpen, openKind: open ? open.subject.kind : null, menu };
}
