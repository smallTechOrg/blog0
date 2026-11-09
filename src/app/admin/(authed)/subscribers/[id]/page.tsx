import type { Metadata } from 'next';

import { SubscriberDetail } from '@/components/admin/subscribers/SubscriberDetail';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Subscriber /admin/subscribers/[id] (spec/ui.md §4 "Subscriber"): the per-subscriber
// audit view. The client view loads GET /api/admin/subscribers/:id and handles NOT_FOUND itself.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `Subscriber · ${site.wordmark}` };
}

export default async function SubscriberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminPage('/admin/subscribers/' + encodeURIComponent(id));
  const site = await getCurrentSite();
  return <SubscriberDetail key={id} id={id} timeZone={site.timezone} />;
}
