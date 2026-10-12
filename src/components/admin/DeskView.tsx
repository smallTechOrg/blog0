'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import type { ArticleListItemDto, ArticleListResponse } from '@/lib/api/dto';

import { apiRequest, signInHref } from './api';
import { ArticleTable } from './ArticleTable';

// Desk /admin (spec/ui.md §4). States: loading, error + Retry, empty, populated.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; signedOut: boolean }
  | { kind: 'ready'; articles: ArticleListItemDto[]; now: Date };

async function fetchDesk(): Promise<State> {
  const res = await apiRequest<ArticleListResponse>('/api/admin/articles');
  if (res.ok) return { kind: 'ready', articles: res.data.articles, now: new Date() };
  return { kind: 'error', message: res.error.message, signedOut: res.error.code === 'UNAUTHENTICATED' };
}

export function DeskView({ timeZone }: { timeZone: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await fetchDesk());
  }, []);

  useEffect(() => {
    let live = true;
    void fetchDesk().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  const hasArticles = state.kind === 'ready' && state.articles.length > 0;

  return (
    <main className="desk-main">
      <div className="desk-page">
        <div className="desk-page__head">
          <h1 className="desk-page__title">Desk</h1>
          {hasArticles ? (
            <Link href="/admin/articles/new" className="admin-btn admin-btn--primary">
              New article
            </Link>
          ) : null}
        </div>

        {state.kind === 'loading' ? (
          <p className="admin-muted" role="status" aria-live="polite">
            Loading articles…
          </p>
        ) : null}

        {state.kind === 'error' ? (
          <div className="admin-alert" role="alert">
            <p>Couldn’t load the articles: {state.message}</p>
            {state.signedOut ? (
              <a className="admin-btn" href={signInHref('/admin')}>
                Sign in again
              </a>
            ) : (
              <button type="button" className="admin-btn" onClick={() => void load()}>
                Retry
              </button>
            )}
          </div>
        ) : null}

        {state.kind === 'ready' && state.articles.length === 0 ? (
          <div className="desk-empty">
            <p>No articles yet. Paste your Markdown and see it exactly as readers will.</p>
            <Link href="/admin/articles/new" className="admin-btn admin-btn--primary">
              New article
            </Link>
          </div>
        ) : null}

        {state.kind === 'ready' && state.articles.length > 0 ? (
          <ArticleTable articles={state.articles} timeZone={timeZone} now={state.now} />
        ) : null}
      </div>
    </main>
  );
}
