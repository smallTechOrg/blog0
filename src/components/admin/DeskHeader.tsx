'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { apiRequest } from './api';

// Admin header bar (spec/ui.md §4 DeskHeader): small wordmark "blog0 · desk", links Desk, Site,
// Subscribers (Phase 2), the signed-in writer's name, Sign out. Phase 4 adds AI usage, Team.

const LINKS = [
  { href: '/admin', label: 'Desk' },
  { href: '/admin/site', label: 'Site' },
  { href: '/admin/subscribers', label: 'Subscribers' },
] as const;

/** The link that is current for a pathname: Desk owns /admin and the article screens. */
export function deskSection(pathname: string): (typeof LINKS)[number]['href'] | null {
  if (pathname === '/admin/site' || pathname.startsWith('/admin/site/')) return '/admin/site';
  if (pathname === '/admin/subscribers' || pathname.startsWith('/admin/subscribers/')) return '/admin/subscribers';
  if (pathname === '/admin' || pathname.startsWith('/admin/articles')) return '/admin';
  return null;
}

export interface DeskHeaderProps {
  wordmark: string;
  userName: string;
}

export function DeskHeader({ wordmark, userName }: DeskHeaderProps) {
  const pathname = usePathname() ?? '/admin';
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'pending' | 'error'>('idle');
  const head = wordmark.slice(0, -1);
  const last = wordmark.slice(-1);
  const current = deskSection(pathname);

  async function signOut(): Promise<void> {
    setState('pending');
    const res = await apiRequest<{ signedOut: true }>('/api/auth/logout', { method: 'POST' });
    if (res.ok || res.error.code === 'UNAUTHENTICATED') {
      router.replace('/admin/login');
      router.refresh();
      return;
    }
    setState('error');
  }

  return (
    <header className="deskhead">
      <div className="deskhead__in">
        <Link href="/admin" className="deskhead__brand" aria-label={`${wordmark} desk — home`}>
          <span className="wordmark deskhead__mark">
            {head}
            <span className="wordmark__o">{last}</span>
          </span>
          <span className="deskhead__desk mono">· desk</span>
        </Link>
        <nav className="deskhead__nav" aria-label="Desk">
          {LINKS.map((l) => {
            const on = current === l.href;
            const exact = pathname === l.href;
            return (
              <Link key={l.href} href={l.href} className={on ? 'tab is-on' : 'tab'} aria-current={exact ? 'page' : undefined}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="deskhead__user">
          <span className="deskhead__name">{userName}</span>
          <button type="button" className="admin-btn admin-btn--ghost" onClick={signOut} disabled={state === 'pending'}>
            {state === 'pending' ? 'Signing out…' : 'Sign out'}
          </button>
          {state === 'error' ? (
            <span className="admin-error" role="alert">
              Couldn’t sign out — try again.
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
}
