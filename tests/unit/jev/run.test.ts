import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runJev } from '@/server/jev/run';
import { LlmError, type LlmErrorCode } from '@/server/llm/types';
import { resetLoggerForTests } from '@/server/log';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';
import { makeInput, makeSentences, picksJson, StubLlm } from './stub';

function clock(step = 10) {
  let t = 1000;
  return () => (t += step);
}

const MODEL = 'stub/model';

describe('runJev', () => {
  let logs: CapturedLogs;
  const savedLevel = process.env.BLOG0_LOG_LEVEL;

  beforeEach(() => {
    process.env.BLOG0_LOG_LEVEL = 'error';
    resetLoggerForTests();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.stop();
    if (savedLevel === undefined) delete process.env.BLOG0_LOG_LEVEL;
    else process.env.BLOG0_LOG_LEVEL = savedLevel;
    resetLoggerForTests();
  });

  it('returns sorted picks with server text after one valid call', async () => {
    const input = makeInput(makeSentences(10));
    const llm = new StubLlm([picksJson([8, 0, 4, 2])]);

    const res = await runJev(input, { llm, model: MODEL, now: clock(), timeoutMs: 1234 });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.picks.map((p) => p.index)).toEqual([0, 2, 4, 8]);
    expect(res.picks.every((p) => p.text === input.sentences[p.index].text && p.sid === input.sentences[p.index].sid)).toBe(true);
    expect(res).toMatchObject({ model: MODEL, promptVersion: 'jev-select-v1', attempts: 1, bounds: { min: 4, max: 5, target: 4 } });
    expect(res.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.001,
      providerGenerationIds: ['<stub:jev>-1'],
    });
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(llm.requests[0]).toMatchObject({
      model: MODEL,
      schemaName: 'jev_selection',
      temperature: 0,
      maxTokens: 1200,
      requestId: 'req-jev',
      promptVersion: 'jev-select-v1',
      timeoutMs: 1234,
    });
    expect(llm.requests[0].messages).toHaveLength(2);
    const run = logs.find('jev.run');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      request_id: 'req-jev',
      article_id: 'art-1',
      revision_id: 'rev-1',
      sentence_count: 10,
      picks: 4,
      attempts: 1,
      outcome: 'ok',
    });
  });

  it('repairs an invalid first answer and succeeds on the second attempt, summing usage', async () => {
    const input = makeInput(makeSentences(10));
    const llm = new StubLlm([
      { content: 'Here you go: 1, 2, 3', usage: { costUsd: null } },
      { content: picksJson([1, 3, 5, 7]), usage: { costUsd: 0.002 } },
    ]);

    const res = await runJev(input, { llm, model: MODEL, now: clock() });

    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.usage).toMatchObject({
      promptTokens: 200,
      completionTokens: 40,
      totalTokens: 240,
      costUsd: 0.002,
      providerGenerationIds: ['<stub:jev>-1', '<stub:jev>-2'],
    });
    const second = llm.requests[1].messages;
    expect(second).toHaveLength(4);
    expect(second[2]).toEqual({ role: 'assistant', content: 'Here you go: 1, 2, 3' });
    expect(second[3].content).toBe(
      'Your previous answer was invalid: the output was not valid JSON. Return only corrected JSON that follows the schema, choosing between 4 and 5 indices from 0 to 9.',
    );
  });

  it('repairs an out-of-range selection by naming the bad index', async () => {
    const input = makeInput(makeSentences(10));
    const llm = new StubLlm([picksJson([0, 2, 4, 12]), picksJson([0, 2, 4, 9])]);

    const res = await runJev(input, { llm, model: MODEL, now: clock() });

    expect(res.ok && res.picks.map((p) => p.index)).toEqual([0, 2, 4, 9]);
    expect(llm.requests[1].messages[3].content).toContain('picks[3].index 12 is out of range 0..9');
  });

  it('fails with LLM_INVALID_OUTPUT after two invalid answers and keeps the raw outputs', async () => {
    const input = makeInput(makeSentences(10));
    const llm = new StubLlm([picksJson([1]), '{"picks": "nope"}']);

    const res = await runJev(input, { llm, model: MODEL, now: clock() });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({
      code: 'LLM_INVALID_OUTPUT',
      message: 'Jev returned an invalid selection twice. Try again, or pick lines yourself.',
    });
    expect(res.attempts).toBe(2);
    expect(res.rawOutputs).toEqual([picksJson([1]), '{"picks": "nope"}']);
    expect(res.usage.totalTokens).toBe(240);
    expect(llm.requests).toHaveLength(2);
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'error', err_code: 'LLM_INVALID_OUTPUT', attempts: 2 });
  });

  it('makes no model call when the article has no eligible sentences', async () => {
    const llm = new StubLlm([]);

    const res = await runJev(makeInput([]), { llm, model: MODEL, now: clock() });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('JEV_NO_SENTENCES');
    expect(res.attempts).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('makes no model call when the input is too long', async () => {
    const llm = new StubLlm([]);

    const res = await runJev(makeInput(makeSentences(401, 5)), { llm, model: MODEL, now: clock() });

    expect(!res.ok && res.error.code).toBe('JEV_INPUT_TOO_LONG');
    expect(llm.requests).toHaveLength(0);
  });

  it('picks exactly N when the article has fewer than four eligible sentences', async () => {
    const input = makeInput(makeSentences(3));
    const llm = new StubLlm([picksJson([2, 0, 1])]);

    const res = await runJev(input, { llm, model: MODEL, now: clock() });

    expect(res.ok && res.picks.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(res.bounds).toEqual({ min: 3, max: 3, target: 3 });
  });

  it.each<[LlmErrorCode]>([
    ['LLM_AUTH'],
    ['LLM_INSUFFICIENT_CREDITS'],
    ['LLM_MODEL_NOT_FOUND'],
    ['LLM_RATE_LIMITED'],
    ['LLM_TIMEOUT'],
    ['LLM_UNAVAILABLE'],
  ])('maps adapter error %s 1:1 without a second attempt', async (code) => {
    const llm = new StubLlm([new LlmError(code, `writer message for ${code}`, 500)]);

    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: clock() });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ code, message: `writer message for ${code}` });
    expect(res.attempts).toBe(1);
    expect(res.usage.totalTokens).toBeNull();
    expect(llm.requests).toHaveLength(1);
  });

  it('maps an adapter error on the repair attempt and keeps first-attempt usage', async () => {
    const llm = new StubLlm([picksJson([1]), new LlmError('LLM_TIMEOUT', 'slow', null)]);

    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: clock() });

    expect(!res.ok && res.error.code).toBe('LLM_TIMEOUT');
    expect(res.attempts).toBe(2);
    expect(res.usage.totalTokens).toBe(120);
    expect(!res.ok && res.rawOutputs).toEqual([picksJson([1])]);
  });

  it('rethrows unexpected (non-LLM) errors after logging them', async () => {
    const llm = new StubLlm([new Error('bug')]);

    await expect(runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: clock() })).rejects.toThrow('bug');
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'error', err_code: 'INTERNAL' });
  });

  it('keeps cost null when no attempt reported one', async () => {
    const llm = new StubLlm([{ content: picksJson([0, 1, 2, 3]), usage: { costUsd: null } }]);

    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: clock() });

    expect(res.ok).toBe(true);
    expect(res.usage.costUsd).toBeNull();
  });
});
