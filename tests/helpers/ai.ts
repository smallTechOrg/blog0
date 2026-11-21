// The site's AI provider in integration/e2e tests (SMA-44). Real-key tests point the site at the eval
// provider (OpenRouter's OpenAI-compatible endpoint + a small chat model, BLOG0_OPENROUTER_API_KEY);
// everything else runs with no provider (AI off) or a stub client (setJevDepsForTests).
import { eq } from 'drizzle-orm';

import { saveAiProvider } from '@/server/ai/provider';
import { getDb } from '@/server/db/client';
import { aiProvider } from '@/server/db/schema';
import { evalAiProvider } from '@/server/llm/key';

/** Saves the eval provider (real key from env) as the site's AI provider. */
export async function useEvalAiProvider(siteId: string, apiKey?: string): Promise<{ model: string }> {
  const p = evalAiProvider(process.env);
  await saveAiProvider(siteId, { baseUrl: p.baseUrl, model: p.model, apiKey: apiKey ?? p.apiKey }, null);
  return { model: p.model };
}

/** Removes the site's AI provider (AI off). */
export async function clearAiProvider(siteId: string): Promise<void> {
  await getDb().delete(aiProvider).where(eq(aiProvider.siteId, siteId));
}
