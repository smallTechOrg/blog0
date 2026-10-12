'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

import { apiRequest } from './api';

// Admin header bar (spec/ui.md §4 DeskHeader): small wordmark "log0 · desk", Desk link,
// the signed-in writer's name, Sign out. Later phases add Site, Subscribers, AI usage, Team.

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
  const onDesk = pathname === '/admin';

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
          <Link href="/admin" className={onDesk ? 'tab is-on' : 'tab'} aria-current={onDesk ? 'page' : undefined}>
            Desk
          </Link>
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
