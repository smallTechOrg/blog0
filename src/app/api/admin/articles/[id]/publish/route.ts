import type { PublishResponse } from '@/lib/api/dto';
import { actorOf, idParam, summarizeArticle } from '@/server/articles/http';
import { revisionBody } from '@/server/articles/schemas';
import { publishArticle } from '@/server/articles/service';
import { withApi } from '@/server/http/api';

// POST /api/admin/articles/:id/publish — publishes the current revision + each format's draft.
// PUBLISH_BLOCKED (422) with reasons; CONFLICT when revisionId is not current. Never calls the AI.

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', body: revisionBody, summarizeInput: (b) => ({ revisionId: b.revisionId }), summarizeOutput: summarizeArticle },
  async ({ auth, params, body, requestId }): Promise<PublishResponse> => ({
    article: await publishArticle(actorOf(auth), idParam(params), body.revisionId, new Date(), { requestId }),
  }),
);
