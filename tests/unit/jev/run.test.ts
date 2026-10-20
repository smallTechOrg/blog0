// runJev with a stub decisions client (responses carry provider '<stub:jev>'): ranking, top-k,
// batching, concurrency, validation failures (no retry), usage summing, error mapping, logs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildState } from '@/server/jev/build-input';
import { loadRankPrompt } from '@/server/jev/prompt';
import { runJev } from '@/server/jev/run';
import { planBatches } from '@/server/jev/batches';
import { JEV_BATCH_CONCURRENCY, JEV_REQUEST_CHAR_BUDGET } from '@/server/jev/state';
import { LlmError, type LlmErrorCode } from '@/server/llm/types';
import { resetLoggerForTests } from '@/server/log';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';
import { answerAll, answersFor, makeInput, makeSentences, StubLlm } from './stub';

function clock(step = 10) {
  let t = 1000;
  return () => (t += step);
}

const MODEL = 'typesafe/jev-1.13';

/** Fixed relevance per sentence index (from the sid p-<n>-s<k> → index 2n+k). */
const indexOf = (sid: string) => {
  const m = /^p-(\d+)-s(\d)$/.exec(sid)!;
  return Number(m[1]) * 2 + Number(m[2]);
};

/** A budget that splits `n` sentences into about `parts` batches. */
function budgetFor(n: number, parts: number): number {
  const input = makeInput(makeSentences(n));
  const one = planBatches(input, buildState(input), loadRankPrompt(), MODEL, JEV_REQUEST_CHAR_BUDGET)[0].requestChars;
  return Math.ceil(one / parts) + 600;
}

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

  it('scores every sentence in one request and selects the top k in document order', async () => {
    const input = makeInput(makeSentences(10));
    const rel = [0.1, 0.9, 0.2, 0.8, 0.3, 0.95, 0.05, 0.7, 0.4, 0.6];
    const llm = new StubLlm([answerAll((sid) => rel[indexOf(sid)])]);

    const res = await runJev(input, { llm, model: MODEL, now: clock(), timeoutMs: 1234 });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.k).toBe(4);
    expect(res.bounds).toEqual({ min: 4, max: 5, target: 4 });
    expect(res.scores).toEqual(input.sentences.map((s, i) => ({ index: i, sid: s.sid, relevance: rel[i] })));
    expect(res.selected.map((p) => p.index)).toEqual([1, 3, 5, 7]);
    expect(res).toMatchObject({ model: MODEL, promptVersion: 'jev-rank-v1', batches: 1 });
    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.0001,
      providerGenerationIds: ['<stub:jev>-1'],
    });
    expect(res.latencyMs).toBeGreaterThan(0);

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0];
    expect(req).toMatchObject({ model: MODEL, requestId: 'req-jev', promptVersion: 'jev-rank-v1', timeoutMs: 1234, batch: { index: 1, count: 1 } });
    expect(req.state).toEqual(buildState(input));
    expect(Object.keys(req.questions)).toEqual(input.sentences.map((s) => s.sid));
    expect(Object.values(req.questions).every((q) => q.type === 'noul' && q.criteria.true !== '' && q.criteria.false !== '')).toBe(true);

    const run = logs.find('jev.run');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      request_id: 'req-jev',
      article_id: 'art-1',
      revision_id: 'rev-1',
      sentence_count: 10,
      k: 4,
      batches: 1,
      model: MODEL,
      prompt_version: 'jev-rank-v1',
      outcome: 'ok',
      top_relevance: 0.95,
      kth_relevance: 0.7,
    });
    expect(JSON.stringify(run[0])).not.toContain('Sentence 1 word');
  });

  it('ties rank the earlier sentence first', async () => {
    const input = makeInput(makeSentences(6));
    const llm = new StubLlm([answerAll(() => 0.5)]);
    const res = await runJev(input, { llm, model: MODEL, now: clock() });
    expect(res.ok && res.selected.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it('selects all N when the article has fewer than four eligible sentences', async () => {
    const llm = new StubLlm([answerAll()]);
    const res = await runJev(makeInput(makeSentences(3)), { llm, model: MODEL, now: clock() });
    expect(res.ok && res.selected.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(res.k).toBe(3);
  });

  it('ignores extra answer ids and logs the count', async () => {
    const input = makeInput(makeSentences(4));
    const llm = new StubLlm([
      (req) => ({ answers: { ...answerAll()(req).answers, 'p-99-s0': { type: 'noul', noul: 1 }, junk: 'x' } }),
    ]);
    const res = await runJev(input, { llm, model: MODEL, now: clock() });
    expect(res.ok).toBe(true);
    expect(res.ok && res.scores.map((s) => s.sid)).toEqual(input.sentences.map((s) => s.sid));
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'ok', extra_answers: 2 });
  });

  it('a missing answer fails with LLM_INVALID_OUTPUT after exactly one request — no retry — and keeps the raw body', async () => {
    const input = makeInput(makeSentences(10));
    const llm = new StubLlm([
      (req) => {
        const answers = answerAll()(req).answers;
        delete answers['p-2-s1'];
        return { answers };
      },
    ]);

    const res = await runJev(input, { llm, model: MODEL, now: clock() });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({
      code: 'LLM_INVALID_OUTPUT',
      message: "Jev didn't score every sentence (1 of 10 missing or invalid) — try again, or pick lines yourself.",
    });
    expect(llm.requests).toHaveLength(1);
    expect(res.batches).toBe(1);
    expect(res.rawOutputs).toHaveLength(1);
    expect(JSON.parse(res.rawOutputs[0])).toMatchObject({ provider: '<stub:jev>' });
    expect(res.usage.totalTokens).toBe(120);
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'error', err_code: 'LLM_INVALID_OUTPUT', missing_answers: 1, batches: 1 });
  });

  it.each([1.2, -0.1, Number.NaN, '0.7'])('a noul of %s fails the run with LLM_INVALID_OUTPUT (no imputed score)', async (bad) => {
    const llm = new StubLlm([answerAll((sid) => (sid === 'p-0-s0' ? bad : 0.5))]);
    const res = await runJev(makeInput(makeSentences(8)), { llm, model: MODEL, now: clock() });
    expect(!res.ok && res.error.code).toBe('LLM_INVALID_OUTPUT');
    expect(!res.ok && res.error.message).toContain('(1 of 8 missing or invalid)');
    expect(llm.requests).toHaveLength(1);
    expect(logs.find('jev.run')[0]).toMatchObject({ invalid_answers: 1 });
  });

  it('makes no call when the article has no eligible sentences', async () => {
    const llm = new StubLlm([]);
    const res = await runJev(makeInput([]), { llm, model: MODEL, now: clock() });
    expect(!res.ok && res.error.code).toBe('JEV_NO_SENTENCES');
    expect(res.batches).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('makes no call when the input is too long (> 400 sentences)', async () => {
    const llm = new StubLlm([]);
    const res = await runJev(makeInput(makeSentences(401, 5)), { llm, model: MODEL, now: clock() });
    expect(!res.ok && res.error.code).toBe('JEV_INPUT_TOO_LONG');
    expect(llm.requests).toHaveLength(0);
  });

  it.each<[LlmErrorCode]>([
    ['LLM_AUTH'],
    ['LLM_INSUFFICIENT_CREDITS'],
    ['LLM_MODEL_NOT_FOUND'],
    ['LLM_RATE_LIMITED'],
    ['LLM_TIMEOUT'],
    ['LLM_UNAVAILABLE'],
  ])('maps adapter error %s 1:1 without another request', async (code) => {
    const llm = new StubLlm([new LlmError(code, `writer message for ${code}`, 500)]);
    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: clock() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ code, message: `writer message for ${code}` });
    expect(res.batches).toBe(1);
    expect(res.usage.totalTokens).toBeNull();
    expect(res.usage.costUsd).toBeNull();
    expect(llm.requests).toHaveLength(1);
  });

  it('rethrows unexpected (non-LLM) errors after logging them', async () => {
    const llm = new StubLlm([new Error('bug')]);
    await expect(runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: clock() })).rejects.toThrow('bug');
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'error', err_code: 'INTERNAL' });
  });

  it('keeps cost null when no response reported one', async () => {
    const llm = new StubLlm([(req) => ({ ...answerAll()(req), usage: { costUsd: null } })]);
    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: clock() });
    expect(res.ok).toBe(true);
    expect(res.usage.costUsd).toBeNull();
  });
});

describe('runJev batching', () => {
  const savedLevel = process.env.BLOG0_LOG_LEVEL;
  let logs: CapturedLogs;

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

  it('a forced small budget sends ≥ 2 requests, each with the identical state; every sid scored once; usage summed', async () => {
    const input = makeInput(makeSentences(24));
    const llm = new StubLlm([], {
      fallback: (req) => ({ ...answerAll((sid) => indexOf(sid) / 100)(req), usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.00002 } }),
    });

    const res = await runJev(input, { llm, model: MODEL, now: clock(), requestCharBudget: budgetFor(24, 4) });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const n = llm.requests.length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(res.batches).toBe(n);
    const state = buildState(input);
    for (const [i, r] of llm.requests.entries()) {
      expect(r.state).toEqual(state);
      expect(r.batch).toEqual({ index: i + 1, count: n });
    }
    const asked = llm.requests.flatMap((r) => Object.keys(r.questions));
    expect([...asked].sort()).toEqual(input.sentences.map((s) => s.sid).sort());
    expect(new Set(asked).size).toBe(24);
    expect(res.scores.map((s) => s.sid)).toEqual(input.sentences.map((s) => s.sid));
    expect(res.scores.map((s) => s.relevance)).toEqual(input.sentences.map((_, i) => i / 100));
    // top k = the last k sentences (highest i/100), document order
    expect(res.selected.map((p) => p.index)).toEqual(Array.from({ length: res.k }, (_, j) => 24 - res.k + j));
    expect(res.usage).toMatchObject({ inputTokens: 50 * n, outputTokens: 5 * n, totalTokens: 55 * n });
    expect(res.usage.costUsd).toBeCloseTo(0.00002 * n, 10);
    expect(res.usage.providerGenerationIds).toHaveLength(n);
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'ok', batches: n });
  });

  it('cost is null only when no batch reported one; otherwise the reported ones are summed', async () => {
    const input = makeInput(makeSentences(12));
    let i = 0;
    const llm = new StubLlm([], { fallback: (req) => ({ ...answerAll()(req), usage: { costUsd: i++ === 0 ? 0.0003 : null } }) });
    const res = await runJev(input, { llm, model: MODEL, now: clock(), requestCharBudget: budgetFor(12, 3) });
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(res.usage.costUsd).toBe(0.0003);
  });

  it('never has more than 3 requests in flight', async () => {
    const input = makeInput(makeSentences(40));
    const llm = new StubLlm([], { fallback: (req) => ({ ...answerAll()(req), delayMs: 5 }) });

    const res = await runJev(input, { llm, model: MODEL, now: () => performance.now(), requestCharBudget: budgetFor(40, 8) });

    expect(res.ok).toBe(true);
    expect(JEV_BATCH_CONCURRENCY).toBe(3);
    expect(llm.requests.length).toBeGreaterThanOrEqual(6);
    expect(llm.maxInFlight).toBe(3);
  });

  it('a missing answer in a later batch fails the whole run (no retry of that batch)', async () => {
    const input = makeInput(makeSentences(20));
    const llm = new StubLlm([], {
      fallback: (req) => {
        const answers = answerAll()(req).answers;
        if (req.batch.index === req.batch.count) delete answers[Object.keys(answers)[0]];
        return { answers };
      },
    });
    const res = await runJev(input, { llm, model: MODEL, now: clock(), requestCharBudget: budgetFor(20, 3) });
    expect(!res.ok && res.error.code).toBe('LLM_INVALID_OUTPUT');
    expect(llm.requests).toHaveLength(res.batches);
    expect(!res.ok && res.rawOutputs).toHaveLength(res.batches);
  });

  it('the first failing batch (in batch order) decides the error; no new batch starts after it; in-flight usage is kept', async () => {
    const input = makeInput(makeSentences(40));
    const budget = budgetFor(40, 8);
    // Batch 1 succeeds slowly, batch 2 fails fast (auth), batch 3 fails (unavailable).
    const llm = new StubLlm([
      (req) => ({ ...answerAll()(req), delayMs: 20 }),
      new LlmError('LLM_AUTH', 'auth broke', 401),
      new LlmError('LLM_UNAVAILABLE', 'down', 503),
    ], { fallback: (req) => answerAll()(req) });

    const res = await runJev(input, { llm, model: MODEL, now: () => performance.now(), requestCharBudget: budget });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ code: 'LLM_AUTH', message: 'auth broke' });
    expect(llm.requests).toHaveLength(3); // the 3 initial workers; nothing launched after the failures
    expect(res.batches).toBe(3);
    expect(res.usage.costUsd).toBe(0.0001); // batch 1 (in flight when batch 2 failed) is still recorded
    expect(res.rawOutputs).toHaveLength(1);
  });

  it('a later batch failing first in time still loses to an earlier batch failure in batch order', async () => {
    const input = makeInput(makeSentences(30));
    const llm = new StubLlm([
      (req) => ({ ...answerAll()(req), delayMs: 1 }),
      { error: new LlmError('LLM_RATE_LIMITED', 'slow down', 429), delayMs: 30 },
      { error: new LlmError('LLM_TIMEOUT', 'timeout', null), delayMs: 1 },
    ], { fallback: (req) => answerAll()(req) });
    const res = await runJev(input, { llm, model: MODEL, now: () => performance.now(), requestCharBudget: budgetFor(30, 4), concurrency: 3 });
    expect(!res.ok && res.error.code).toBe('LLM_RATE_LIMITED');
  });

  it('answers keyed to a batch are validated per batch (an answer in the wrong batch is extra, the sid is missing)', async () => {
    const input = makeInput(makeSentences(12));
    const llm = new StubLlm([], {
      fallback: (req) => (req.batch.index === 1 ? answerAll()(req) : answersFor({ 'p-0-s0': 0.5 })),
    });
    const res = await runJev(input, { llm, model: MODEL, now: clock(), requestCharBudget: budgetFor(12, 2) });
    expect(!res.ok && res.error.code).toBe('LLM_INVALID_OUTPUT');
    expect(logs.find('jev.run')[0]).toMatchObject({ extra_answers: expect.any(Number), missing_answers: expect.any(Number) });
  });
});
