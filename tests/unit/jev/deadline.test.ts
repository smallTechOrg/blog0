// runJev overall deadline (keeps the worst case under the route's maxDuration = 120 s): no batch
// starts without JEV_MIN_ATTEMPT_MS left, each request's timeout is capped at the time remaining,
// and a request that outlasts the deadline (e.g. adapter retries honouring Retry-After) yields LLM_TIMEOUT.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildState } from '@/server/jev/build-input';
import { planBatches } from '@/server/jev/batches';
import { loadRankPrompt } from '@/server/jev/prompt';
import { JEV_DEADLINE_MS, JEV_MIN_ATTEMPT_MS, runJev } from '@/server/jev/run';
import { JEV_REQUEST_CHAR_BUDGET } from '@/server/jev/state';
import { resetLoggerForTests } from '@/server/log';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';
import { answerAll, makeInput, makeSentences, StubLlm } from './stub';

const MODEL = 'typesafe/jev-1.13';
const TIMEOUT_MESSAGE = "Jev couldn't reach the model — try again in a minute.";

function budgetFor(n: number, parts: number): number {
  const input = makeInput(makeSentences(n));
  const one = planBatches(input, buildState(input), loadRankPrompt(), MODEL, JEV_REQUEST_CHAR_BUDGET)[0].requestChars;
  return Math.ceil(one / parts) + 600;
}

describe('runJev deadline', () => {
  let logs: CapturedLogs;
  const savedLevel = process.env.BLOG0_LOG_LEVEL;

  beforeEach(() => {
    process.env.BLOG0_LOG_LEVEL = 'error';
    resetLoggerForTests();
    logs = captureLogs();
  });

  afterEach(() => {
    vi.useRealTimers();
    logs.stop();
    if (savedLevel === undefined) delete process.env.BLOG0_LOG_LEVEL;
    else process.env.BLOG0_LOG_LEVEL = savedLevel;
    resetLoggerForTests();
  });

  it('defaults to a 110 s deadline, under the route limit of 120 s', () => {
    expect(JEV_DEADLINE_MS).toBe(110_000);
    expect(JEV_MIN_ATTEMPT_MS).toBe(5_000);
  });

  it('caps a later batch request timeout at the time remaining before the deadline', async () => {
    let t = 0;
    // concurrency 1 → batches run one after another on the fake clock: 80 s, then the next starts with 30 s left.
    const llm = new StubLlm([], { fallback: (req) => ({ ...answerAll()(req), delayMs: req.batch.index === 1 ? 80_000 : 1_000 }), advance: (ms) => (t += ms) });

    const res = await runJev(makeInput(makeSentences(12)), {
      llm,
      model: MODEL,
      now: () => t,
      timeoutMs: 45_000,
      concurrency: 1,
      requestCharBudget: budgetFor(12, 2),
    });

    expect(res.ok).toBe(true);
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    expect(llm.requests[0].timeoutMs).toBe(45_000);
    expect(llm.requests[1].timeoutMs).toBe(30_000);
  });

  it('does not start a batch when too little time remains, returning LLM_TIMEOUT with the earlier usage', async () => {
    let t = 0;
    const firstMs = JEV_DEADLINE_MS - JEV_MIN_ATTEMPT_MS + 1;
    const llm = new StubLlm([], { fallback: (req) => ({ ...answerAll()(req), delayMs: firstMs }), advance: (ms) => (t += ms) });

    const res = await runJev(makeInput(makeSentences(12)), { llm, model: MODEL, now: () => t, concurrency: 1, requestCharBudget: budgetFor(12, 2) });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ code: 'LLM_TIMEOUT', message: TIMEOUT_MESSAGE });
    expect(res.batches).toBe(1);
    expect(llm.requests).toHaveLength(1);
    expect(res.usage.totalTokens).toBe(120);
    expect(res.rawOutputs).toHaveLength(1);
    expect(logs.find('jev.deadline')[0]).toMatchObject({ request_id: 'req-jev', article_id: 'art-1', batches: 1, deadline_ms: JEV_DEADLINE_MS });
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'error', err_code: 'LLM_TIMEOUT', batches: 1 });
  });

  it('makes no call at all when the deadline is already shorter than the minimum', async () => {
    const llm = new StubLlm([answerAll()]);
    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => 0, deadlineMs: JEV_MIN_ATTEMPT_MS - 1 });
    expect(!res.ok && res.error.code).toBe('LLM_TIMEOUT');
    expect(res.batches).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('abandons a request that outlasts the deadline with LLM_TIMEOUT at 110 s and clears its own timer', async () => {
    vi.useFakeTimers({ now: 0 });
    const llm = new StubLlm([(req) => ({ ...answerAll()(req), delayMs: 160_000 })]);

    const pending = runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => Date.now(), timeoutMs: 45_000 });
    await vi.advanceTimersByTimeAsync(JEV_DEADLINE_MS);
    const res = await pending;

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ code: 'LLM_TIMEOUT', message: TIMEOUT_MESSAGE });
    expect(res.batches).toBe(1);
    expect(llm.requests[0].timeoutMs).toBe(45_000);
    expect(res.latencyMs).toBe(JEV_DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(1); // only the abandoned stub call's timer; the deadline timer was cleared
  });

  it('parallel batches all race the same deadline: the run ends at 110 s even with 3 slow requests in flight', async () => {
    vi.useFakeTimers({ now: 0 });
    const llm = new StubLlm([], { fallback: (req) => ({ ...answerAll()(req), delayMs: 200_000 }) });

    const pending = runJev(makeInput(makeSentences(30)), { llm, model: MODEL, now: () => Date.now(), requestCharBudget: budgetFor(30, 5) });
    await vi.advanceTimersByTimeAsync(JEV_DEADLINE_MS);
    const res = await pending;

    expect(!res.ok && res.error.code).toBe('LLM_TIMEOUT');
    expect(llm.requests).toHaveLength(3);
    expect(res.latencyMs).toBe(JEV_DEADLINE_MS);
    expect(logs.find('jev.deadline')).toHaveLength(1);
  });

  it('honours a custom deadline and clears its timer when the request answers in time', async () => {
    vi.useFakeTimers({ now: 0 });
    const llm = new StubLlm([(req) => ({ ...answerAll()(req), delayMs: 9_000 })]);

    const pending = runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => Date.now(), deadlineMs: 20_000 });
    await vi.advanceTimersByTimeAsync(9_000);
    const res = await pending;

    expect(res.ok).toBe(true);
    expect(llm.requests[0].timeoutMs).toBe(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
