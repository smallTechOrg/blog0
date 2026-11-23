import type { Metadata } from 'next';

import { NewArticleStart } from '@/components/admin/NewArticleStart';
import { requireAdminPage } from '@/server/auth/guard';

// New article /admin/articles/new (SMA-50): creates an empty draft and opens it in the editor.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'New article · blog0' };

export default async function NewArticlePage() {
  await requireAdminPage('/admin/articles/new');
  return <NewArticleStart />;
}
