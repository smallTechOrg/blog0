import type { ArticleListResponse, CreateArticleResponse } from '@/lib/api/dto';
import { actorOf, summarizeArticle } from '@/server/articles/http';
import { createArticleBody } from '@/server/articles/schemas';
import { createArticle, listArticles } from '@/server/articles/service';
import { apiResult, withApi } from '@/server/http/api';

// GET /api/admin/articles — the desk list (newest updatedAt first).
// POST /api/admin/articles — create (revision 1, slug derived from the title) → 201.

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ articles: (d as ArticleListResponse).articles.length }) },
  async ({ auth }): Promise<ArticleListResponse> => ({ articles: await listArticles(auth.user.siteId) }),
);

export const POST = withApi(
  {
    auth: 'admin',
    body: createArticleBody,
    summarizeInput: (b) => ({ titleChars: b.title.length, bodyChars: b.bodyMd?.length ?? 0, hasTopic: !!b.topic }),
    summarizeOutput: summarizeArticle,
  },
  async ({ auth, body }) => {
    const data: CreateArticleResponse = { article: await createArticle(actorOf(auth), body) };
    return apiResult(data, { status: 201 });
  },
);
