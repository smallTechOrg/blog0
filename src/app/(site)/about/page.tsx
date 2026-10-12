import type { Metadata } from 'next';

import { StubNotice } from '@/components/StubNotice';
import { getConfig } from '@/server/config';
import { pageTitle, sitePageMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// About (spec/ui.md §3): Phase 1 ships the page header (wordmark from the site record) + a
// labelled stub. Phase 2 builds the design's About page (stand, strap, body; admin-editable).

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return sitePageMetadata({
    title: pageTitle('About', site.wordmark),
    description: site.aboutStand,
    url: getConfig().publicBaseUrl.replace(/\/+$/, '') + '/about',
    siteName: site.wordmark,
  });
}

export default async function AboutPage() {
  const site = await getCurrentSite();
  return (
    <main className="col">
      <header className="pagehead">
        <h1>{'About ' + site.wordmark}</h1>
      </header>
      <div className="home-sec">
        <StubNotice>The About page arrives in Phase 2: who we are, what we publish, and why.</StubNotice>
      </div>
    </main>
  );
}
