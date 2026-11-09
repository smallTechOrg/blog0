import type { DeleteArticleResponse, GetArticleResponse, UpdateArticleResponse } from '@/lib/api/dto';
import { actorOf, idParam, summarizeArticle } from '@/server/articles/http';
import { updateArticleBody } from '@/server/articles/schemas';
import { deleteArticle, getArticleDetail, updateArticle } from '@/server/articles/service';
import { withApi } from '@/server/http/api';

// GET    /api/admin/articles/:id — editor state.
// PATCH  /api/admin/articles/:id — save (a revision only when title/dek/body changed); CONFLICT on a stale base.
// DELETE /api/admin/articles/:id — never-published drafts only (NOT_DELETABLE otherwise).

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'admin', summarizeOutput: summarizeArticle },
  async ({ auth, params }): Promise<GetArticleResponse> => ({ article: await getArticleDetail(auth.user.siteId, idParam(params)) }),
);

export const PATCH = withApi(
  {
    auth: 'admin',
    body: updateArticleBody,
    summarizeInput: (b) => ({
      baseRevisionId: b.baseRevisionId,
      fields: Object.keys(b).filter((k) => k !== 'baseRevisionId'),
      bodyChars: b.bodyMd?.length,
    }),
    summarizeOutput: (d) => ({ ...summarizeArticle(d), revisionCreated: (d as UpdateArticleResponse).revisionCreated }),
  },
  async ({ auth, params, body }): Promise<UpdateArticleResponse> => updateArticle(actorOf(auth), idParam(params), body),
);

export const DELETE = withApi(
  { auth: 'admin' },
  async ({ auth, params }): Promise<DeleteArticleResponse> => deleteArticle(actorOf(auth), idParam(params)),
);
