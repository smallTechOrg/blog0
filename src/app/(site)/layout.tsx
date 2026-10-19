import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Boot } from '@/components/site/Boot';
import { Footer } from '@/components/site/Footer';
import { Masthead } from '@/components/site/Masthead';
import { PrintIn } from '@/components/site/PrintIn';
import { yearInZone } from '@/lib/format-date';
import { siteViewModelFrom } from '@/lib/view-models';
import { publishedTopics } from '@/server/public/home';
import { siteDefaultMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// Public chrome (spec/ui.md §3 "Chrome"): #blog0-root → Boot strip (divergence 6) → Masthead →
// page → Footer, with the print-in running on every route change. Brand values come from the
// site record.

export const dynamic = 'force-dynamic';

/** Stage A: metadataBase + the default share image / large card for every public page. */
export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return siteDefaultMetadata(site.wordmark);
}

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const site = await getCurrentSite();
  const topics = await publishedTopics(site.id);
  const vm = siteViewModelFrom(site, { topics, year: yearInZone(new Date(), site.timezone) });

  return (
    <div id="blog0-root">
      <Boot brand={vm.wordmark} />
      <Masthead wordmark={vm.wordmark} tagline={vm.tagline} />
      {children}
      <Footer site={vm} />
      <PrintIn />
    </div>
  );
}
