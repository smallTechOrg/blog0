import { z } from 'zod';

import type { IssueDetailResponse, IssueListResponse } from '@/lib/api/dto';
import { apiResult, withApi } from '@/server/http/api';
import { issueStatusQuery } from '@/server/newsletter/issues/http';
import { createIssue, listIssues } from '@/server/newsletter/issues/service';
import { issueCreate } from '@/server/newsletter/schemas';

// GET  /api/admin/newsletter/issues[?status=] — IssueListResponse, newest first.
// POST /api/admin/newsletter/issues — a manual draft (201, event `created`); ISSUE_POSTS_INVALID
//      for 0 / > 10 / duplicate / unpublished / unknown articles.

export const dynamic = 'force-dynamic';

/** The post count (1–10) is checked by the service so it answers 422 ISSUE_POSTS_INVALID, not 400. */
const createBody = issueCreate.extend({ articleIds: z.array(z.uuid()).max(100) });

export const GET = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ issues: (d as IssueListResponse).total }) },
  async ({ auth, request }): Promise<IssueListResponse> => listIssues(auth.user.siteId, issueStatusQuery(request)),
);

export const POST = withApi(
  { auth: 'admin', body: createBody, summarizeInput: (b) => ({ posts: b.articleIds.length, introChars: b.introMd.length }) },
  async ({ auth, body, requestId }) => {
    const issue = await createIssue(
      auth.user.siteId,
      { origin: 'manual', title: body.title, introMd: body.introMd, articleIds: body.articleIds, createdBy: auth.user.id },
      { userId: auth.user.id, requestId },
    );
    return apiResult<IssueDetailResponse>({ issue }, { status: 201 });
  },
);
