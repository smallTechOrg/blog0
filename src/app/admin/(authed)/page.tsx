import type { Metadata } from 'next';

import { DeskView } from '@/components/admin/DeskView';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Desk /admin (spec/ui.md §4): article table with per-format status chips.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Desk · blog0' };

export default async function DeskPage() {
  await requireAdminPage('/admin');
  const site = await getCurrentSite();
  return <DeskView timeZone={site.timezone} />;
}
