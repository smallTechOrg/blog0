import 'server-only';

import { getConfig } from '../config';
import { ApiError } from '../http/api';
import { OpenRouterClient } from './openrouter';
import type { LlmClient } from './types';

export { OpenRouterClient } from './openrouter';
export { LlmError } from './types';
export type { ChatMessage, LlmClient, LlmErrorCode, LlmJsonRequest, LlmJsonResponse, LlmUsage } from './types';

let client: LlmClient | null = null;

export const LLM_NOT_CONFIGURED_MESSAGE =
  'No OpenRouter key configured — add BLOG0_OPENROUTER_API_KEY to .env to generate with Jev.';

/** False only in designer mode (pglite) with no real OpenRouter key (spec/architecture.md §11.1). */
export function isLlmConfigured(): boolean {
  return getConfig().openrouterApiKey !== null;
}

/**
 * Process-wide OpenRouter client built from config (BLOG0_OPENROUTER_*, BLOG0_PUBLIC_BASE_URL).
 * Throws ApiError LLM_NOT_CONFIGURED (503) when no key is configured (designer mode only).
 */
export function getLlmClient(): LlmClient {
  if (client === null) {
    const config = getConfig();
    if (config.openrouterApiKey === null) throw new ApiError('LLM_NOT_CONFIGURED', 503, LLM_NOT_CONFIGURED_MESSAGE);
    client = new OpenRouterClient({
      apiKey: config.openrouterApiKey,
      baseUrl: config.openrouterBaseUrl,
      referer: config.publicBaseUrl,
    });
  }
  return client;
}

export function resetLlmClientForTests(): void {
  client = null;
}
