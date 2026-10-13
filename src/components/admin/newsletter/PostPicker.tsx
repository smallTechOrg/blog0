'use client';

import type { ArticleListItemDto } from '@/lib/api/dto';

import { safeDate } from '../subscribers/subscribers-api';

import { MAX_POSTS, moveId, toggleId } from './issue-edit';

// Post picker (spec/ui.md §4 "New issue"): a checklist of published articles (newest first:
// title · topic · date), then the checked ones in issue order with ↑ ↓ to reorder (1–10).

export interface PostPickerProps {
  /** already filtered to published + sorted newest first (publishedArticles) */
  articles: ArticleListItemDto[];
  selected: string[];
  onChange: (ids: string[]) => void;
  timeZone: string;
  disabled?: boolean;
}

export function PostPicker({ articles, selected, onChange, timeZone, disabled = false }: PostPickerProps) {
  if (articles.length === 0) return <p className="admin-muted">No published posts yet.</p>;
  const full = selected.length >= MAX_POSTS;
  const byId = new Map(articles.map((a) => [a.id, a]));

  return (
    <div className="postpick">
      <ul className="postpick__list">
        {articles.map((a) => {
          const on = selected.includes(a.id);
          return (
            <li key={a.id} className={on ? 'postpick__item is-on' : 'postpick__item'}>
              <label className="admin-check">
                <input type="checkbox" checked={on} disabled={disabled || (!on && full)} onChange={() => onChange(toggleId(selected, a.id))} />
                <span>
                  <span className="postpick__title">{a.title}</span>
                  <span className="admin-faint">
                    {' '}
                    · {a.topic || '—'} · {a.firstPublishedAt ? safeDate(a.firstPublishedAt, timeZone) : '—'}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="admin-hint" aria-live="polite">
        {selected.length} of {MAX_POSTS} picked
      </p>
      {selected.length > 0 ? (
        <ol className="postpick__order" aria-label="Order in the issue">
          {selected.map((id, i) => {
            const title = byId.get(id)?.title ?? id;
            return (
              <li key={id} className="postpick__row">
                <span className="postpick__title">{title}</span>
                <span className="postpick__tools">
                  <button
                    type="button"
                    className="deck__btn"
                    aria-label={`Move ${title} up`}
                    disabled={disabled || i === 0}
                    onClick={() => onChange(moveId(selected, i, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="deck__btn"
                    aria-label={`Move ${title} down`}
                    disabled={disabled || i === selected.length - 1}
                    onClick={() => onChange(moveId(selected, i, 1))}
                  >
                    ↓
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
