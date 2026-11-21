// pnpm check:openrouter — proves an OpenAI-compatible AI endpoint and model answer, with one tiny real
// chat call (SMA-44). Uses the same provider as the real-key tests and `pnpm eval:jev`:
// BLOG0_OPENROUTER_API_KEY against BLOG0_EVAL_AI_BASE_URL (default OpenRouter) with BLOG0_EVAL_AI_MODEL.
// The site itself is configured in Admin → Site → AI provider, where "Test" does the same check.
// Prints only booleans/numbers — never the key. Exit 1 on any failure.
import './lib/allow-server-only';

import { loadEnvConfig } from '@next/env';

import { Secret } from '../src/server/config';
import { ChatClient, parseJsonReply } from '../src/server/llm/chat';
import { evalAiProvider } from '../src/server/llm/key';
import { LlmError } from '../src/server/llm/types';

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  process.env.BLOG0_LOG_LEVEL = 'error';
  const provider = evalAiProvider(process.env);
  console.log(`key present: ${provider.apiKey !== ''}`);
  if (provider.apiKey === '') {
    console.error('BLOG0_OPENROUTER_API_KEY is not set — add it to .env at the repo root (see .env.example).');
    process.exit(1);
  }
  console.log(`endpoint: ${new URL(provider.baseUrl).host} · model: ${provider.model}`);
  const client = new ChatClient({ apiKey: new Secret(provider.apiKey), baseUrl: provider.baseUrl, referer: 'http://localhost:3410', retryDelaysMs: [] });
  const started = performance.now();
  try {
    const res = await client.chat({
      model: provider.model,
      purpose: 'ai.check',
      promptVersion: 'ai-test-v1',
      requestId: 'check-openrouter',
      timeoutMs: 60_000,
      json: true,
      maxTokens: 20,
      messages: [
        { role: 'system', content: 'You are a connectivity check. Answer with JSON only.' },
        { role: 'user', content: 'Reply with exactly {"ok":true}' },
      ],
    });
    const reply = parseJsonReply(res.content) as { ok?: unknown } | null;
    console.log(`model answered: true (${Math.round(performance.now() - started)} ms)`);
    console.log(`json reply ok: ${reply?.ok === true}`);
    console.log(`cost usd: ${res.usage.costUsd ?? 'not reported'}`);
  } catch (error) {
    if (error instanceof LlmError) {
      console.error(`model answered: false — ${error.code}: ${error.message}${error.detail ? ` (${error.detail})` : ''}`);
      process.exit(1);
    }
    throw error;
  }
}

void main();
