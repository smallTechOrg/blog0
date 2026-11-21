import type { AiProviderResponse } from '@/lib/api/dto';
import { aiProviderBody, getAiProvider, saveAiProvider } from '@/server/ai/provider';
import { withApi } from '@/server/http/api';

// GET /api/admin/ai — the site's AI provider (Admin → Site → AI provider; SMA-44). Never the key:
//   only whether one is saved and its last 4 characters.
// PUT /api/admin/ai — { baseUrl, model, apiKey? } (apiKey omitted keeps the saved key; null removes it).

export const dynamic = 'force-dynamic';

export const GET = withApi({ auth: 'admin' }, async ({ auth }): Promise<AiProviderResponse> => ({ ai: await getAiProvider(auth.user.siteId) }));

export const PUT = withApi(
  {
    auth: 'admin',
    body: aiProviderBody,
    // Never the key — only whether it changed.
    summarizeInput: (b) => ({ host: safeHost(b.baseUrl), model: b.model, key: b.apiKey === undefined ? 'kept' : b.apiKey === null ? 'removed' : 'replaced' }),
  },
  async ({ auth, body }): Promise<AiProviderResponse> => ({ ai: await saveAiProvider(auth.user.siteId, body, auth.user.id) }),
);

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
