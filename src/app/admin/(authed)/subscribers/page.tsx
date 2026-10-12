import type { Metadata } from 'next';

import { SubscribersView } from '@/components/admin/subscribers/SubscribersView';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Subscribers /admin/subscribers (spec/ui.md §4; capability newsletter-signup):
// count, table (newest first), Export CSV.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `Subscribers · ${site.wordmark}` };
}

export default async function SubscribersPage() {
  await requireAdminPage('/admin/subscribers');
  const site = await getCurrentSite();
  return <SubscribersView timeZone={site.timezone} />;
}
