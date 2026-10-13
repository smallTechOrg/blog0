import type { Metadata } from 'next';

import { SiteSettingsView } from '@/components/admin/site/SiteSettingsView';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Site /admin/site (spec/ui.md §4; capability reader-site): any admin edits the tagline,
// contact mail, About texts and social URLs; home and /about show the change on the next load.
// Phase 7: the Newsletter card (#newsletter; capability newsletter-issues).

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `Site · ${site.wordmark}` };
}

export default async function SitePage() {
  await requireAdminPage('/admin/site');
  const site = await getCurrentSite();
  return <SiteSettingsView wordmark={site.wordmark} timeZone={site.timezone} />;
}
