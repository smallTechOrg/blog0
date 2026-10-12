import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { FeaturedStack } from '@/components/site/home/FeaturedStack';
import { HomeAbout } from '@/components/site/home/HomeAbout';
import { HomeEmpty } from '@/components/site/home/HomeEmpty';
import { LatestFeed } from '@/components/site/home/LatestFeed';
import { siteViewModelFrom } from '@/lib/view-models';
import { SESSION_COOKIE_NAME } from '@/server/auth/session';
import { getConfig } from '@/server/config';
import { getHomeSections } from '@/server/public/home';
import { sitePageMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// Home (spec/ui.md §3 "Home", Phase 2): exactly the design's Home — About (site record texts,
// typed on the shared clock), the Featured Editorial pinned head + scroll stack, and Latest with
// See More / View all articles. Nothing published → the Latest head with an empty state.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return sitePageMetadata({
    title: site.wordmark,
    description: site.tagline,
    url: getConfig().publicBaseUrl.replace(/\/+$/, '') + '/',
    siteName: site.wordmark,
  });
}

export default async function HomePage() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  const site = await getCurrentSite();
  const about = siteViewModelFrom(site, { topics: [], year: 0 });
  const { featured, latest, signedIn } = await getHomeSections(token);
  const empty = featured.length === 0 && latest.length === 0;

  return (
    <main className="col">
      <HomeAbout strap={about.aboutStrap} stand={about.aboutStand} bodyParagraphs={about.aboutBodyParagraphs} />
      {empty ? <HomeEmpty signedIn={signedIn} /> : null}
      <FeaturedStack posts={featured} />
      {latest.length ? <LatestFeed posts={latest} /> : null}
    </main>
  );
}
