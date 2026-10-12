'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import type { ArticleListResponse, CreateArticleRequest, CreateArticleResponse } from '@/lib/api/dto';

import { apiRequest } from './api';

// New article (spec/ui.md §4): Title (required), Topic (datalist of existing topics), Dek,
// Markdown (optional) → Create → POST /api/admin/articles → the editor.

export const TITLE_MAX = 200;
export const DEK_MAX = 400;
export const TOPIC_MAX = 40;
export const BODY_MAX = 200_000;

export function NewArticleForm() {
  const router = useRouter();
  const [topics, setTopics] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void apiRequest<ArticleListResponse>('/api/admin/articles').then((res) => {
      if (!live || !res.ok) return; // suggestions only — the form works without them
      const seen = Array.from(new Set(res.data.articles.map((a) => a.topic).filter(Boolean)));
      setTopics(seen.sort((a, b) => a.localeCompare(b)));
    });
    return () => {
      live = false;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) {
      setError('Give the article a title.');
      return;
    }
    const body: CreateArticleRequest = { title };
    const dek = String(form.get('dek') ?? '').trim();
    const topic = String(form.get('topic') ?? '').trim();
    const bodyMd = String(form.get('bodyMd') ?? '');
    if (dek) body.dek = dek;
    if (topic) body.topic = topic;
    if (bodyMd.trim()) body.bodyMd = bodyMd;

    setPending(true);
    setError(null);
    const res = await apiRequest<CreateArticleResponse>('/api/admin/articles', { method: 'POST', body });
    if (res.ok) {
      router.push(`/admin/articles/${res.data.article.id}`);
      return;
    }
    setPending(false);
    setError(res.error.message);
  }

  return (
    <main className="desk-main">
      <div className="desk-page desk-page--narrow">
        <p className="admin-crumb">
          <Link href="/admin">← Desk</Link>
        </p>
        <h1 className="desk-page__title">New article</h1>
        <form className="admin-form" onSubmit={onSubmit} noValidate>
          <label className="admin-field">
            <span className="admin-label">Title</span>
            <input className="admin-input admin-input--title" name="title" required maxLength={TITLE_MAX} autoFocus disabled={pending} />
          </label>
          <label className="admin-field">
            <span className="admin-label">Topic</span>
            <input className="admin-input" name="topic" list="new-article-topics" maxLength={TOPIC_MAX} disabled={pending} />
            <datalist id="new-article-topics">
              {topics.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="admin-field">
            <span className="admin-label">Dek</span>
            <textarea className="admin-input admin-input--dek" name="dek" rows={2} maxLength={DEK_MAX} disabled={pending} />
          </label>
          <label className="admin-field">
            <span className="admin-label">
              Markdown <span className="admin-faint">(optional — you can paste it in the editor too)</span>
            </span>
            <textarea className="admin-input mdedit__area" name="bodyMd" rows={12} maxLength={BODY_MAX} spellCheck={false} disabled={pending} />
          </label>
          <div className="admin-form__actions">
            <button type="submit" className="admin-btn admin-btn--primary" disabled={pending} aria-busy={pending}>
              {pending ? 'Creating…' : 'Create'}
            </button>
            <Link href="/admin" className="admin-btn admin-btn--ghost">
              Cancel
            </Link>
          </div>
          <p className="admin-error" role="alert" aria-live="polite">
            {error}
          </p>
        </form>
      </div>
    </main>
  );
}
