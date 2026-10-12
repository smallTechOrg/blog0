import 'server-only';

import type { Metadata } from 'next';
import { cache } from 'react';

import { loadPublishedArticle, type PublishedArticlePage } from './articles';
import { articleMetadata } from './metadata';

// Request-scoped loaders for the article routes: `generateMetadata` and the page body share one
// DB read per request through React's `cache` (server components only).

export const loadArticlePage = cache(
  async (slug: string): Promise<PublishedArticlePage | null> => loadPublishedArticle(slug),
);

/** Metadata for `/p/<slug>` (`mode: 'read'`) or `/p/<slug>/tldr`; empty for unknown slugs (the page 404s). */
export async function articlePageMetadata(slug: string, mode: 'read' | 'tldr'): Promise<Metadata> {
  const page = await loadArticlePage(slug);
  if (!page) return {};
  return articleMetadata(page.article, {
    wordmark: page.site.wordmark,
    mode,
    publishedAt: page.publishedAt,
    updatedAt: page.updatedAt,
  });
}
