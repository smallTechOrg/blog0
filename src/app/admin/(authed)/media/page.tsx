import type { Metadata } from 'next';

import { MediaLibraryView } from '@/components/admin/media/MediaLibraryView';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Admin → Media /admin/media (spec/ui.md §4 "Media"; capability media-library): every uploaded
// image with the articles that show it; copy its Markdown or link, or replace the file so every
// article using it shows the new one.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = await getCurrentSite();
  return { title: `Media · ${site.wordmark}` };
}

export default async function MediaPage() {
  await requireAdminPage('/admin/media');
  const site = await getCurrentSite();
  return <MediaLibraryView timeZone={site.timezone} />;
}
