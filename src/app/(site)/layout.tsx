import { and, desc, eq, max, ne } from 'drizzle-orm';
import type { ReactNode } from 'react';

import { Footer } from '@/components/site/Footer';
import { Masthead } from '@/components/site/Masthead';
import { PrintIn } from '@/components/site/PrintIn';
import { yearInZone } from '@/lib/format-date';
import { siteViewModelFrom } from '@/lib/view-models';
import { getDb } from '@/server/db/client';
import { article } from '@/server/db/schema';
import { getCurrentSite } from '@/server/site/current';

// Public chrome (spec/ui.md §3 "Chrome"): #blog0-root → Masthead → page → Footer, with the
// print-in running on every pathname change. Brand values come from the site record.

export const dynamic = 'force-dynamic';

/* Topics are the tags the published articles actually carry, newest tag first,
   so the row can never advertise a section with nothing behind it (design TOPICS). */
async function publishedTopics(siteId: string): Promise<string[]> {
  const latest = max(article.firstPublishedAt);
  const rows = await getDb()
    .select({ topic: article.topic, latest })
    .from(article)
    .where(and(eq(article.siteId, siteId), eq(article.status, 'published'), ne(article.topic, '')))
    .groupBy(article.topic)
    .orderBy(desc(latest));
  return rows.map((r) => r.topic);
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
