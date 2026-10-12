import { afterEach, describe, expect, it } from 'vitest';

import { resetConfigForTests } from '@/server/config';
import { getLlmClient, OpenRouterClient, resetLlmClientForTests } from '@/server/llm';
import { openRouterKeyStatus, PENDING_KEY_REASON } from '@/server/llm/key';

const ENV_KEYS = ['BLOG0_DATABASE_URL', 'BLOG0_SESSION_SECRET', 'BLOG0_OPENROUTER_API_KEY'] as const;

describe('getLlmClient', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigForTests();
    resetLlmClientForTests();
  });

  it('builds one OpenRouter client from config and resets for tests', () => {
    process.env.BLOG0_DATABASE_URL = 'postgres://sai@localhost:5432/blog0_dev';
    process.env.BLOG0_SESSION_SECRET = 'unit-test-session-secret-that-is-long-enough-1234';
    process.env.BLOG0_OPENROUTER_API_KEY = 'unit-test-key';
    resetConfigForTests();

    const a = getLlmClient();
    const b = getLlmClient();
    resetLlmClientForTests();
    const c = getLlmClient();

    expect(a).toBeInstanceOf(OpenRouterClient);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
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
