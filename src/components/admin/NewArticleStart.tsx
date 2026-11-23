'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { CreateArticleResponse } from '@/lib/api/dto';

import { apiRequest } from './api';

// New article (SMA-50): there is no separate "new" form any more. Opening it creates an empty
// draft titled "Untitled" and lands in the same editor an existing article opens in — the
// assistant, Settings, TLDR, Listen and History are then exactly the same, because it is the
// same editor. The title field is focused and selected so typing replaces "Untitled".

export const NEW_ARTICLE_TITLE = 'Untitled';

export function NewArticleStart() {
  const router = useRouter();
  const started = useRef(false); // React strict mode runs effects twice in dev: create once
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void apiRequest<CreateArticleResponse>('/api/admin/articles', { method: 'POST', body: { title: NEW_ARTICLE_TITLE } }).then((res) => {
      if (res.ok) router.replace(`/admin/articles/${res.data.article.id}`);
      else setError(res.error.message);
    });
  }, [router]);

  return (
    <main className="desk-main">
      <div className="desk-page desk-page--narrow">
        <p className="admin-crumb">
          <Link href="/admin">← Desk</Link>
        </p>
        {error ? (
          <p className="admin-error" role="alert">
            Couldn’t start a new article: {error}
          </p>
        ) : (
          <p className="admin-muted" role="status">
            Starting a new article…
          </p>
        )}
      </div>
    </main>
  );
}
