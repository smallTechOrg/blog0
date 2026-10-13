import type { Metadata } from 'next';

import { PrivacyView } from '@/components/site/privacy/PrivacyView';
import { aboutParagraphs } from '@/components/site/about/about-text';
import { pageTitle, sitePageRouteMetadata } from '@/server/public/metadata';
import { getCurrentSite } from '@/server/site/current';

// Privacy /privacy (spec/ui.md §3, fix pass): the `privacyText` site setting as plain paragraphs
// (edited in Admin → Site), plus the contact line for erasure requests.

export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return sitePageRouteMetadata('/privacy', (site) => ({ title: pageTitle('Privacy', site.wordmark) }));
}

export default async function PrivacyPage() {
  const site = await getCurrentSite();
  return <PrivacyView paragraphs={aboutParagraphs(site.privacyText)} contactEmail={site.contactEmail} />;
}
