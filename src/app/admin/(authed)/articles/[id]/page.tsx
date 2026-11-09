import type { Metadata } from 'next';

import { ArticleEditor } from '@/components/admin/editor/ArticleEditor';
import { requireAdminPage } from '@/server/auth/guard';
import { getCurrentSite } from '@/server/site/current';

// Editor /admin/articles/[id] (spec/ui.md §4). The client editor loads the article through
// GET /api/admin/articles/:id and handles NOT_FOUND itself.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Editor · blog0' };

export default async function ArticleEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdminPage('/admin/articles/' + encodeURIComponent(id));
  const site = await getCurrentSite();
  return <ArticleEditor key={id} articleId={id} timeZone={site.timezone} />;
}
