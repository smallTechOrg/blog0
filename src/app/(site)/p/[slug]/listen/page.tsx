import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '@/components/reader/ArticleView';
import { articleRouteMetadata } from '@/server/public/metadata';
import { loadArticlePage } from '@/server/public/page-data';

// Deep link to the Listen view (/p/<slug>/listen): the same article page with Listen open on
// load, so a reload keeps it open. Closing it (X, Esc, Read) returns the address to /p/<slug>
// via history.replaceState (ArticleView). Without a published Listen the page falls back to Read
// at /p/<slug>. Metadata = the Read address's (canonical stays the Read URL, as for /tldr).

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return articleRouteMetadata(await loadArticlePage(slug), 'read');
}

export default async function ArticleListenPage({ params }: Props) {
  const { slug } = await params;
  const page = await loadArticlePage(slug);
  if (!page) notFound();
  return <ArticleView article={page.article} initialMode="listen" brand={page.site.wordmark} />;
}
