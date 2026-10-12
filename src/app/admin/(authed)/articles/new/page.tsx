import type { Metadata } from 'next';

import { NewArticleForm } from '@/components/admin/NewArticleForm';
import { requireAdminPage } from '@/server/auth/guard';

// New article /admin/articles/new (spec/ui.md §4): Title, Topic, Dek, Markdown → Create.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'New article · blog0' };

export default async function NewArticlePage() {
  await requireAdminPage('/admin/articles/new');
  return <NewArticleForm />;
}
