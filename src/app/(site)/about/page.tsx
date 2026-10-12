import type { Metadata } from 'next';

import { AboutView } from '@/components/site/about/AboutView';
import { aboutParagraphs } from '@/components/site/about/about-text';
import { getConfig } from '@/server/config';
import { pageTitle, sitePageMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// About /about (spec/ui.md §3; design `About`): wordmark heading, stand, strap, body — all from
// the site record, edited in Admin → Site. A load failure falls to (site)/error.tsx.

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
  return <AboutView wordmark={site.wordmark} stand={site.aboutStand} strap={site.aboutStrap} paragraphs={aboutParagraphs(site.aboutBodyMd)} />;
}
