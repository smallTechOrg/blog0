import type { IssuePreviewDto } from '@/lib/api/dto';
import { withApi } from '@/server/http/api';
import { issueIdOf } from '@/server/newsletter/issues/http';
import { previewIssue } from '@/server/newsletter/issues/service';

// GET /api/admin/newsletter/issues/:id/preview — IssuePreviewDto: the HTML + text exactly as they
// will be sent, with sample values (the signed-in admin) for the unsubscribe link and consent line.
// A draft is re-snapshotted from its articles' current published revisions first (persisted).

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'admin', summarizeOutput: (d) => ({ htmlChars: (d as IssuePreviewDto).html.length, textChars: (d as IssuePreviewDto).text.length }) },
  async ({ auth, params }): Promise<IssuePreviewDto> => previewIssue(auth.user.siteId, issueIdOf(params), { email: auth.user.email }),
);
