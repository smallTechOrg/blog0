import type { Metadata } from 'next';

import { IssueCompose } from '@/components/admin/newsletter/IssueCompose';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Newsletter → New issue /admin/newsletter/new (spec/ui.md §4 "New issue"): title, intro,
// 1–10 published posts in order → Create draft.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `New issue · ${site.wordmark}` };
}

export default async function NewIssuePage() {
  await requireAdminPage('/admin/newsletter/new');
  const site = await getCurrentSite();
  return <IssueCompose timeZone={site.timezone} />;
}
