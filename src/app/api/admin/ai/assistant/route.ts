import type { AssistantPromptResponse } from '@/lib/api/dto';
import { assistantPromptBody, getAssistantPrompt, saveAssistantPrompt } from '@/server/ai/assistant';
import { withApi } from '@/server/http/api';

// GET /api/admin/ai/assistant — the writing assistant's instructions (SMA-43), the default included.
// PUT /api/admin/ai/assistant — { prompt: string | null } (null or blank → back to the default).

export const dynamic = 'force-dynamic';

export const GET = withApi(
  { auth: 'admin' },
  async ({ auth }): Promise<AssistantPromptResponse> => ({ assistant: await getAssistantPrompt(auth.user.siteId) }),
);

export const PUT = withApi(
  { auth: 'admin', body: assistantPromptBody, summarizeInput: (b) => ({ chars: b.prompt?.length ?? 0 }) },
  async ({ auth, body }): Promise<AssistantPromptResponse> => ({
    assistant: await saveAssistantPrompt(auth.user.siteId, body.prompt, auth.user.id),
  }),
);
