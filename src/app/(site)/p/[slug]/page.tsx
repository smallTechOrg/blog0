import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ArticleView } from '@/components/reader/ArticleView';
import { articleRouteMetadata } from '@/server/public/metadata';
import { loadArticlePage } from '@/server/public/page-data';

// Public article, Read view (spec/ui.md §3 "Article"): server-rendered from the published
// revision; the bottom capsule opens the TLDR deck (address → /p/<slug>/tldr) or the Listen stub.
// Unknown, malformed and unpublished slugs are rewritten by src/proxy.ts to the root not-found
// (404 with the site chrome server-rendered); the notFound() below is the fallback for a race.

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // "<Title> — <wordmark>", description = dek, OG article tags (published/modified times, site
  // name from the site record), canonical = the absolute Read address (BLOG0_PUBLIC_BASE_URL).
  return articleRouteMetadata(await loadArticlePage(slug), 'read');
}

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const page = await loadArticlePage(slug);
  if (!page) notFound();
  return <ArticleView article={page.article} initialMode="read" />;
}
