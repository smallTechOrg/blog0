import type { UnpublishResponse } from '@/lib/api/dto';
import { actorOf, idParam, summarizeArticle } from '@/server/articles/http';
import { unpublishArticle } from '@/server/articles/service';
import { withApi } from '@/server/http/api';

// POST /api/admin/articles/:id/unpublish — hides the article (readers get 404); pointers are kept.

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', summarizeOutput: summarizeArticle },
  async ({ auth, params }): Promise<UnpublishResponse> => ({ article: await unpublishArticle(actorOf(auth), idParam(params)) }),
);
