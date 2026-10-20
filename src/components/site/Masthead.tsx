'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { Icon } from '@/components/design/Icon';
import { cx, prefersReducedMotion } from '@/components/design/motion';
import { Typewriter } from '@/components/design/Typewriter';
import { Wordmark } from '@/components/design/Wordmark';

/** localStorage key the root layout's no-flash script reads (divergence 16). */
export const THEME_KEY = 'blog0.theme';
export type Theme = 'light' | 'dark';

function readTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function subscribeTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

export function setTheme(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage blocked — the toggle still works for this page */
  }
}

export function scrollToNewsletter(): void {
  const el = document.getElementById('newsletter');
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  const input = el.querySelector<HTMLInputElement>('input[type="email"]');
  if (input && !input.disabled) {
    window.setTimeout(() => {
      try {
        input.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }, 500);
  }
}

export interface MastheadProps {
  /** Site wordmark from the site record (e.g. "blog0"). */
  wordmark: string;
  /** Site tagline, typed in under the wordmark. */
  tagline: string;
}

/* ============================================================
   Masthead + tab bar. No search (divergence 4): the tools area
   holds only the theme toggle.
   ============================================================ */
export function Masthead({ wordmark, tagline }: MastheadProps) {
  const pathname = usePathname();
  const headRef = useRef<HTMLElement>(null);
  // 'light' on the server and while hydrating; then the attribute the theme script set.
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'light' as Theme);

  /* The bar compacts on scroll. This toggles a class on the node rather than
     holding the scroll position in state: nothing below re-renders. */
  useEffect(() => {
    let on = false;
    function tick() {
      const el = headRef.current;
      if (!el) return;
      const y = window.pageYOffset || document.documentElement.scrollTop || 0;
      /* hysteresis, so a bar that sits near the threshold doesn't flicker */
      const next = on ? y > 22 : y > 56;
      if (next !== on) {
        on = next;
        el.classList.toggle('is-compact', on);
      }
    }
    let queued = false;
    function onScroll() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        tick();
      });
    }
    tick();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="sitehead" ref={headRef}>
      <div className="sitehead__in">
        <nav className="tabs" aria-label="Main">
          {/* About lives on the homepage, so the nav is Archive + Subscribe */}
          <Link href="/archive" className={cx('tab', pathname === '/archive' && 'is-on')}>
            Archive
          </Link>
          <a
            href="#newsletter"
            className="tab"
            onClick={(e) => {
              e.preventDefault();
              scrollToNewsletter();
            }}
          >
            Subscribe
          </a>
        </nav>
        <div className="brand">
          <Link className="brandlink" href="/" aria-label={wordmark + ' — home'}>
            <span className="brandmark__logo" aria-hidden="true" />
            <Wordmark text={wordmark} />
          </Link>
          {/* the design's 480 ms lead, doubled with the slower typing (UI review 2026-10-20) */}
          <Typewriter tag="span" className="tagline" text={tagline} delay={960} />
        </div>
        <div className="tools">
          <button
            type="button"
            className="iconbtn"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
      </div>
    </header>
  );
}
