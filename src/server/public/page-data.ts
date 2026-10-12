import 'server-only';

import { cache } from 'react';

import { loadPublishedArticle, type PublishedArticlePage } from './articles';

// Request-scoped loaders for the article routes: `generateMetadata` and the page body share one
// DB read per request through React's `cache` (server components only).

export const loadArticlePage = cache(
  async (slug: string): Promise<PublishedArticlePage | null> => loadPublishedArticle(slug),
);
