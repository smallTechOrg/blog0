import type { Metadata } from 'next';

import { IssueList } from '@/components/admin/newsletter/IssueList';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Newsletter /admin/newsletter (spec/ui.md §4 "Newsletter"; capability newsletter-issues):
// the issue list with status, origin and counts; New issue; Settings (→ Site → Newsletter).

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `Newsletter · ${site.wordmark}` };
}

export default async function NewsletterPage() {
  await requireAdminPage('/admin/newsletter');
  const site = await getCurrentSite();
  return <IssueList timeZone={site.timezone} />;
}
