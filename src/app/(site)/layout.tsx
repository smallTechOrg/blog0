import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Footer } from '@/components/site/Footer';
import { Masthead } from '@/components/site/Masthead';
import { PrintIn } from '@/components/site/PrintIn';
import { yearInZone } from '@/lib/format-date';
import { siteViewModelFrom } from '@/lib/view-models';
import { publishedTopics } from '@/server/public/home';
import { siteDefaultMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// Public chrome (spec/ui.md §3 "Chrome"): #blog0-root → Masthead → page → Footer, with PrintIn
// driving the intro and the per-route typing. Brand values come from the site record. (The boot
// strip was dropped — owner decision, UI review 2026-10-20.)

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
      <Masthead wordmark={vm.wordmark} tagline={vm.tagline} />
      {children}
      <Footer site={vm} />
      <PrintIn />
    </div>
  );
}
