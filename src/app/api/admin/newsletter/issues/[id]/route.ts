import { z } from 'zod';

import type { IssueDeleteResponse, IssueDetailResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { issueIdOf } from '@/server/newsletter/issues/http';
import { deleteIssue, getIssue, updateIssue } from '@/server/newsletter/issues/service';
import { issueUpdate } from '@/server/newsletter/schemas';

// GET    /api/admin/newsletter/issues/:id — IssueDetailResponse (send log oldest first).
// PATCH  /api/admin/newsletter/issues/:id — title / intro / post order+subset; draft only
//        (ISSUE_NOT_DRAFT), ISSUE_POSTS_INVALID; event `updated`.
// DELETE /api/admin/newsletter/issues/:id — draft only (ISSUE_NOT_DRAFT); events cascade.

export const dynamic = 'force-dynamic';

/** The post count (1–10) is checked by the service so it answers 422 ISSUE_POSTS_INVALID, not 400. */
const updateBody = issueUpdate.extend({ articleIds: z.array(z.uuid()).max(100).optional() });

export const GET = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ status: (d as IssueDetailResponse).issue.status }) },
  async ({ auth, params }): Promise<IssueDetailResponse> => ({ issue: await getIssue(auth.user.siteId, issueIdOf(params)) }),
);

export const PATCH = withApi(
  { auth: 'admin', body: updateBody, summarizeInput: (b) => ({ fields: Object.keys(b), posts: b.articleIds?.length }) },
  async ({ auth, params, body, requestId }): Promise<IssueDetailResponse> => ({
    issue: await updateIssue(auth.user.siteId, issueIdOf(params), body, { userId: auth.user.id, requestId }),
  }),
);

export const DELETE = withApi({ auth: 'admin' }, async ({ auth, params, requestId }): Promise<IssueDeleteResponse> => {
  await deleteIssue(auth.user.siteId, issueIdOf(params), { userId: auth.user.id, requestId });
  return { deleted: true };
});
