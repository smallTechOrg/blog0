import type { AiProviderTestResult } from '@/lib/api/dto';
import { aiProviderTestBody, testAiProvider } from '@/server/ai/provider';
import { withApi } from '@/server/http/api';

// POST /api/admin/ai/test — one tiny real chat call with the form's values over the saved ones
// (Admin → Site → AI provider → Test; SMA-44). Answers 200 with { ok: false, code, message } when the
// provider fails — the failure is the result, not an API error.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const POST = withApi(
  {
    auth: 'admin',
    body: aiProviderTestBody,
    summarizeInput: (b) => ({ fields: Object.keys(b).filter((k) => k !== 'apiKey'), key: b.apiKey ? 'form' : 'saved' }),
    summarizeOutput: (d) => {
      const r = d as AiProviderTestResult;
      return r.ok ? { ok: true, latency_ms: r.latencyMs, json_ok: r.jsonOk } : { ok: false, code: r.code };
    },
  },
  async ({ auth, body, requestId }): Promise<AiProviderTestResult> => testAiProvider(auth.user.siteId, body, requestId),
);
