import type { Metadata } from 'next';

import { IssueDetail } from '@/components/admin/newsletter/IssueDetail';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Newsletter → Issue /admin/newsletter/[id] (spec/ui.md §4 "Issue"). The client view loads
// GET /api/admin/newsletter/issues/:id and handles NOT_FOUND itself. The sibling
// `[id]/preview/route.ts` (slice S7.3) serves the full-page HTML preview.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `Issue · ${site.wordmark}` };
}

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminPage('/admin/newsletter/' + encodeURIComponent(id));
  const site = await getCurrentSite();
  return <IssueDetail key={id} id={id} timeZone={site.timezone} />;
}
