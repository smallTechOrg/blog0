import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView, type ArticleInitialMode } from '@/components/reader/ArticleView';
import { articleRouteMetadata } from '@/server/public/metadata';
import { loadArticlePage } from '@/server/public/page-data';

// The three addresses of one article — /p/<slug> (Read), /p/<slug>/tldr (deck open on load) and
// /p/<slug>/listen (Listen open on load) — are the same server-rendered page with a different
// initial mode, so a reload keeps the mode open. Closing a mode returns the address to /p/<slug>
// via history.replaceState (ArticleView); without the published format the page falls back to Read.
// Unknown, malformed and unpublished slugs are rewritten by src/proxy.ts to the root not-found
// (404 with the site chrome); the notFound() below is the fallback for a race.

interface Props {
  params: Promise<{ slug: string }>;
}

export function articleRoute(initialMode: ArticleInitialMode) {
  return {
    /** "<Title> — <wordmark>", description = dek, OG article tags; canonical = the Read address
     *  (only /tldr's og:url is the deck link). */
    async generateMetadata({ params }: Props): Promise<Metadata> {
      const { slug } = await params;
      return articleRouteMetadata(await loadArticlePage(slug), initialMode === 'tldr' ? 'tldr' : 'read');
    },
    async Page({ params }: Props) {
      const { slug } = await params;
      const page = await loadArticlePage(slug);
      if (!page) notFound();
      return <ArticleView article={page.article} initialMode={initialMode} brand={page.site.wordmark} />;
    },
  };
}
