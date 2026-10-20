import type { IssueTestResponse } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { issueIdOf } from '@/server/newsletter/issues/http';
import { sendTest } from '@/server/newsletter/issues/service';

// POST /api/admin/newsletter/issues/:id/test — "[Test] <title>" to the signed-in admin through the
// transactional transport (SMTP, or the recording stub). Any status; the status never changes;
// event `test_sent`; MAIL_FAILED (502) when SMTP refuses. Never touches the provider or the list.

export const dynamic = 'force-dynamic';

export const POST = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ transport: (d as IssueTestResponse).transport }) },
  async ({ auth, params, requestId }): Promise<IssueTestResponse> =>
    sendTest(auth.user.siteId, issueIdOf(params), { id: auth.user.id, email: auth.user.email }, requestId),
);
