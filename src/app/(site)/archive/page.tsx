import type { Metadata } from 'next';

import { ArchiveList } from '@/components/site/archive/ArchiveList';
import { topicFromQuery } from '@/components/site/archive/archive-model';
import { getConfig } from '@/server/config';
import { listPublishedPostCards } from '@/server/public/articles';
import { pageTitle, sitePageMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// Archive /archive (spec/ui.md §3; design `Archive`): every published article, newest first,
// grouped by month of first publication; topic pills filter, `?topic=` pre-filters (footer topics).
// A load failure falls to (site)/error.tsx.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return sitePageMetadata({
    title: pageTitle('Archive', site.wordmark),
    description: 'Every article, grouped by month and filterable by topic.',
    url: getConfig().publicBaseUrl.replace(/\/+$/, '') + '/archive',
    siteName: site.wordmark,
  });
}

export default async function ArchivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { topic } = await searchParams;
  const posts = await listPublishedPostCards();
  return <ArchiveList posts={posts} topic={topicFromQuery(topic)} />;
}
