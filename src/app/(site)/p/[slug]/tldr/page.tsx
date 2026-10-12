import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '@/components/reader/ArticleView';
import { articleRouteMetadata } from '@/server/public/metadata';
import { loadArticlePage } from '@/server/public/page-data';

// Deep link to the TLDR deck (/p/<slug>/tldr): the same article page with the deck open on
// load, so a reload keeps it open. Closing it (X, Esc, Read) returns the address to /p/<slug>
// via history.replaceState (ArticleView). Without a published deck the page falls back to Read.

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // "<Title> — <wordmark>", description = dek, OG article tags (published/modified times, site
  // name from the site record), canonical = the absolute Read address (BLOG0_PUBLIC_BASE_URL).
  return articleRouteMetadata(await loadArticlePage(slug), 'tldr');
}

export default async function ArticleTldrPage({ params }: Props) {
  const { slug } = await params;
  const page = await loadArticlePage(slug);
  if (!page) notFound();
  return <ArticleView article={page.article} initialMode="tldr" />;
}
