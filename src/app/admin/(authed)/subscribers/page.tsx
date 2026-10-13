import type { Metadata } from 'next';

import { SubscribersView } from '@/components/admin/subscribers/SubscribersView';
import { parseStatusFilter } from '@/components/admin/subscribers/subscribers-api';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Subscribers /admin/subscribers (spec/ui.md §4 "Subscribers"; capability newsletter-list):
// status filter pills with counts, search, table, legacy banner, Export CSV + audit JSON. The
// filter and search come from `?status=&q=` so a reload keeps them.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `Subscribers · ${site.wordmark}` };
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export default async function SubscribersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminPage('/admin/subscribers');
  const [site, sp] = await Promise.all([getCurrentSite(), searchParams]);
  return <SubscribersView timeZone={site.timezone} initialStatus={parseStatusFilter(first(sp.status))} initialQuery={first(sp.q).slice(0, 100)} />;
}
