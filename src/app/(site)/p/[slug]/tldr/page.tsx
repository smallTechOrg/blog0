import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '@/components/reader/ArticleView';
import { articlePageMetadata, loadArticlePage } from '@/server/public/page-data';

// Deep link to the TLDR deck (/p/<slug>/tldr): the same article page with the deck open on
// load, so a reload keeps it open. Closing it (X, Esc, Read) returns the address to /p/<slug>
// via history.replaceState (ArticleView). Without a published deck the page falls back to Read.

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return articlePageMetadata(slug, 'tldr');
}

export default async function ArticleTldrPage({ params }: Props) {
  const { slug } = await params;
  const page = await loadArticlePage(slug);
  if (!page) notFound();
  return <ArticleView article={page.article} initialMode="tldr" />;
}
