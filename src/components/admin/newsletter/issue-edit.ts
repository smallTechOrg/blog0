// Issue compose / edit helpers (pure, isomorphic): which articles can go in an issue, the ordered
// pick (1–10) with ↑ ↓, client checks against NEWSLETTER_SETTINGS_LIMITS and the
// ISSUE_POSTS_INVALID message (spec/ui.md §4 "New issue"; spec/api.md POST/PATCH …/issues).

import { NEWSLETTER_SETTINGS_LIMITS as L, type ArticleListItemDto } from '@/lib/api/dto';

export const MAX_POSTS = L.issuePosts[1];

export interface ComposeFields {
  title: string;
  introMd: string;
  articleIds: string[];
}

export type ComposeErrors = Partial<Record<keyof ComposeFields, string>>;

function time(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Published articles, newest first publish first (only those can go in an issue). */
export function publishedArticles(articles: ArticleListItemDto[]): ArticleListItemDto[] {
  return articles.filter((a) => a.status === 'published').sort((a, b) => time(b.firstPublishedAt) - time(a.firstPublishedAt));
}

/** Check / uncheck keeping the pick order; a full pick (10) ignores new ids. */
export function toggleId(ids: readonly string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= MAX_POSTS) return [...ids];
  return [...ids, id];
}

/** Move the id at `index` by `delta` (−1 up, +1 down); out of range → unchanged. */
export function moveId(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function validateCompose(f: ComposeFields): ComposeErrors {
  const errors: ComposeErrors = {};
  const title = f.title.trim();
  if (!title) errors.title = 'A title is required.';
  else if (title.length > L.issueTitle) errors.title = `At most ${L.issueTitle} characters.`;
  if (f.introMd.length > L.issueIntroMd) errors.introMd = `At most ${L.issueIntroMd.toLocaleString('en-US')} characters.`;
  if (f.articleIds.length < L.issuePosts[0] || f.articleIds.length > L.issuePosts[1]) {
    errors.articleIds = `Pick between ${L.issuePosts[0]} and ${L.issuePosts[1]} published posts.`;
  }
  return errors;
}

/** 422 ISSUE_POSTS_INVALID `details.articleIds` → "These posts can’t go in an issue: <titles>." */
export function postsInvalidMessage(details: unknown, articles: ReadonlyArray<Pick<ArticleListItemDto, 'id' | 'title'>>): string | null {
  if (!details || typeof details !== 'object') return null;
  const ids = (details as { articleIds?: unknown }).articleIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const names = ids.filter((x): x is string => typeof x === 'string').map((id) => articles.find((a) => a.id === id)?.title ?? id);
  return names.length ? `These posts can’t go in an issue: ${names.join(', ')}.` : null;
}
