import type { IssueDetailResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { issueIdOf } from '@/server/newsletter/issues/http';
import { refreshStats } from '@/server/newsletter/issues/send';

// POST /api/admin/newsletter/issues/:id/stats — fresh stats from the sender (the stub counts its own
// rows); event `stats_fetched`; ISSUE_NOT_DRAFT for a draft; SENDER_FAILED on a provider error
// (status unchanged).

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ sent: (d as IssueDetailResponse).issue.stats?.sent ?? null }) },
  async ({ auth, params, requestId }): Promise<IssueDetailResponse> => ({
    issue: await refreshStats(auth.user.siteId, issueIdOf(params), { userId: auth.user.id, requestId }),
  }),
);
