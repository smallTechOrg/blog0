import { describe, expect, it } from 'vitest';

import { ChatClient, LlmError, parseJsonReply } from '@/server/llm';
import { evalAiProvider, EVAL_AI_DEFAULTS, openRouterKeyStatus, PENDING_KEY_REASON } from '@/server/llm/key';

describe('@/server/llm', () => {
  it('exports the one chat client (SMA-44: no env-built singleton — the provider comes from the site)', async () => {
    const mod = await import('@/server/llm');
    expect(ChatClient).toBeTypeOf('function');
    expect(LlmError).toBeTypeOf('function');
    expect(parseJsonReply).toBeTypeOf('function');
    expect(Object.keys(mod)).not.toContain('getLlmClient');
    expect(Object.keys(mod)).not.toContain('OpenRouterDecisionsClient');
  });
});

describe('openRouterKeyStatus', () => {
  it('flags absent and placeholder keys so real-key tests report PENDING KEY', () => {
    expect(openRouterKeyStatus(undefined)).toBe('missing');
    expect(openRouterKeyStatus('  ')).toBe('missing');
    expect(openRouterKeyStatus('replace-with-your-openrouter-key')).toBe('placeholder');
    expect(openRouterKeyStatus('pending-placeholder')).toBe('placeholder');
    expect(openRouterKeyStatus('sk-or-v1-0123456789abcdef')).toBe('real');
    expect(PENDING_KEY_REASON).toBe('PENDING KEY: BLOG0_OPENROUTER_API_KEY not set');
  });
});

describe('evalAiProvider', () => {
  it('is OpenRouter’s OpenAI-compatible endpoint with a small chat model by default; env overrides', () => {
    expect(evalAiProvider({ BLOG0_OPENROUTER_API_KEY: ' k ' })).toEqual({ ...EVAL_AI_DEFAULTS, apiKey: 'k' });
    expect(evalAiProvider({ BLOG0_EVAL_AI_BASE_URL: 'https://x.test/v1', BLOG0_EVAL_AI_MODEL: 'm' })).toEqual({ baseUrl: 'https://x.test/v1', model: 'm', apiKey: '' });
  });
});
