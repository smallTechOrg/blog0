import 'server-only';

import { getConfig } from '../config';
import { OpenRouterClient } from './openrouter';
import type { LlmClient } from './types';

export { OpenRouterClient } from './openrouter';
export { LlmError } from './types';
export type { ChatMessage, LlmClient, LlmErrorCode, LlmJsonRequest, LlmJsonResponse, LlmUsage } from './types';

let client: LlmClient | null = null;

/** Process-wide OpenRouter client built from config (BLOG0_OPENROUTER_*, BLOG0_PUBLIC_BASE_URL). */
export function getLlmClient(): LlmClient {
  if (client === null) {
    const config = getConfig();
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
