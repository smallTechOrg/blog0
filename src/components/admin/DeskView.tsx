'use client';

import Link from 'next/link';

import type { ArticleListResponse } from '@/lib/api/dto';

import { AdminLoadError, stamped, useAdminLoad } from './AdminLoad';
import { apiRequest } from './api';
import { ArticleTable } from './ArticleTable';

// Desk /admin (spec/ui.md §4). States: loading, error + Retry, empty, populated.

const fetchDesk = () => stamped(apiRequest<ArticleListResponse>('/api/admin/articles'));

export function DeskView({ timeZone }: { timeZone: string }) {
  const { load: state, reload } = useAdminLoad(fetchDesk);
  const articles = state.kind === 'ready' ? state.data.articles : null;

  return (
    <main className="desk-main">
      <div className="desk-page">
        <div className="desk-page__head">
          <h1 className="desk-page__title">Desk</h1>
          {articles?.length ? (
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

        {state.kind === 'error' ? <AdminLoadError error={state} what="the articles" onRetry={reload} signInPath="/admin" /> : null}

        {articles && articles.length === 0 ? (
          <div className="desk-empty">
            <p>No articles yet. Paste your Markdown and see it exactly as readers will.</p>
            <Link href="/admin/articles/new" className="admin-btn admin-btn--primary">
              New article
            </Link>
          </div>
        ) : null}

        {state.kind === 'ready' && state.data.articles.length > 0 ? (
          <ArticleTable articles={state.data.articles} timeZone={timeZone} now={state.data.now} />
        ) : null}
      </div>
    </main>
  );
}
