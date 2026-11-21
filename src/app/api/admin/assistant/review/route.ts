import type { AssistantReviewResponse } from '@/lib/api/dto';
import { assistantReviewBody, reviewDraft } from '@/server/ai/assistant';
import { withApi } from '@/server/http/api';

// POST /api/admin/assistant/review — the writing assistant (SMA-43): one chat call through the site's
// AI provider, a few short comments on the draft. Never writes the article; nothing is stored.
// Errors: LLM_NOT_CONFIGURED (503), RATE_LIMITED (429), LLM_* (502/503), LLM_INVALID_OUTPUT (502).

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = withApi(
  {
    auth: 'admin',
    body: assistantReviewBody,
    // Sizes only — never the draft.
    summarizeInput: (b) => ({ trigger: b.trigger, body_chars: b.bodyMd.length, changed_chars: b.changed.length }),
    summarizeOutput: (d) => ({ comments: (d as AssistantReviewResponse).comments.length }),
  },
  async ({ auth, body, requestId }): Promise<AssistantReviewResponse> =>
    reviewDraft({ siteId: auth.user.siteId, userId: auth.user.id }, body, requestId),
);
