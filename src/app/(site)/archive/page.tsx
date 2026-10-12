import type { Metadata } from 'next';
import Link from 'next/link';

import { StubNotice } from '@/components/StubNotice';
import { getConfig } from '@/server/config';
import { pageTitle, sitePageMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// Archive (spec/ui.md §3): Phase 1 ships the page header + a labelled stub. Phase 2 builds the
// design's month groups and topic pills (`?topic=`).

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return sitePageMetadata({
    title: pageTitle('Archive', site.wordmark),
    url: getConfig().publicBaseUrl.replace(/\/+$/, '') + '/archive',
    siteName: site.wordmark,
  });
}

export default function ArchivePage() {
  return (
    <main className="col">
      <header className="pagehead">
        <h1>Archive</h1>
        <p>Every article, grouped by month and filterable by topic.</p>
      </header>
      <div className="home-sec">
        <StubNotice>
          The archive arrives in Phase 2. Until then, every published article is listed under{' '}
          <Link className="inline" href="/">
            Latest
          </Link>{' '}
          on the home page.
        </StubNotice>
      </div>
    </main>
  );
}
