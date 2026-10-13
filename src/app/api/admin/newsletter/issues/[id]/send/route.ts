import type { IssueDetailResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { issueIdOf } from '@/server/newsletter/issues/http';
import { sendIssue } from '@/server/newsletter/issues/send';
import { confirmTrueBody } from '@/server/newsletter/schemas';

// POST /api/admin/newsletter/issues/:id/send { confirm: true } — the one-click send (the UI's inline
// confirmation names the recipient count). `draft`/`failed` only (ISSUE_NOT_DRAFT); NO_RECIPIENTS;
// SENDER_UNAVAILABLE (503, listmonk down — nothing changes); a provider step failing → the issue is
// `failed` and the answer is 502 SENDER_FAILED with the issue in `error.details.issue`.

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export const POST = withApi(
  {
    auth: 'admin',
    body: confirmTrueBody,
    summarizeOutput: (d) => ({ status: (d as IssueDetailResponse).issue.status, recipients: (d as IssueDetailResponse).issue.recipientCount }),
  },
  async ({ auth, params, requestId }): Promise<IssueDetailResponse> => ({
    issue: await sendIssue(auth.user.siteId, issueIdOf(params), { userId: auth.user.id, requestId }),
  }),
);
