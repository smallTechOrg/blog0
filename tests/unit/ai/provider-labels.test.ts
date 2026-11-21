import { describe, expect, it } from 'vitest';

import { statusLine, testResultLine } from '@/components/admin/site/AiProviderSettings';
import type { AiProviderDto } from '@/lib/api/dto';

// Admin → Site → AI provider copy (SMA-44).

const NOW = new Date('2026-11-21T12:00:00Z');
const base: AiProviderDto = {
  configured: true,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  keySet: true,
  keyHint: 'abcd',
  keyUnreadable: false,
  status: { failing: false, lastOkAt: null, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null },
};

describe('statusLine', () => {
  it('says AI is off until set up, and asks for the key again when it cannot be read', () => {
    expect(statusLine({ ...base, configured: false, keySet: false }, 'UTC', NOW)).toEqual({ tone: 'muted', text: 'Not set up — AI features are off.' });
    expect(statusLine({ ...base, configured: false, keyUnreadable: true }, 'UTC', NOW).tone).toBe('error');
  });

  it('shows a failing provider with its last error, else when it last worked', () => {
    const failing = { ...base, status: { ...base.status, failing: true, lastErrorAt: '2026-11-21T11:55:00Z', lastErrorCode: 'LLM_UNAVAILABLE', lastErrorMessage: "Couldn't reach the AI provider" } };
    expect(statusLine(failing, 'UTC', NOW)).toEqual({ tone: 'error', text: "Failing since 5 min ago: Couldn't reach the AI provider" });
    expect(statusLine({ ...base, status: { ...base.status, lastOkAt: '2026-11-21T09:00:00Z' } }, 'UTC', NOW)).toEqual({ tone: 'ok', text: 'Working — last call 3 h ago.' });
    expect(statusLine(base, 'UTC', NOW).text).toBe('Set up — no calls yet. Use Test to check it.');
  });
});

describe('testResultLine', () => {
  it('reports success with latency, a non-JSON model, and a failure message', () => {
    expect(testResultLine({ ok: true, latencyMs: 820, model: 'gpt-4.1-mini', jsonOk: true })).toEqual({ tone: 'ok', text: 'Works — gpt-4.1-mini answered in 0.8 s.' });
    expect(testResultLine({ ok: true, latencyMs: 1500, model: 'x', jsonOk: false }).tone).toBe('error');
    expect(testResultLine({ ok: false, code: 'LLM_AUTH', message: 'Rejected.' })).toEqual({ tone: 'error', text: 'Rejected.' });
  });
});
