// runJev overall deadline (keeps the worst case under the route's maxDuration = 120 s): no attempt
// starts without JEV_MIN_ATTEMPT_MS left, each attempt's timeout is capped at the time remaining,
// and a call that outlasts the deadline (e.g. adapter retries honouring Retry-After) yields LLM_TIMEOUT.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JEV_DEADLINE_MS, JEV_MIN_ATTEMPT_MS, runJev } from '@/server/jev/run';
import type { LlmClient, LlmJsonRequest, LlmJsonResponse } from '@/server/llm/types';
import { resetLoggerForTests } from '@/server/log';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';
import { makeInput, makeSentences, picksJson } from './stub';

const MODEL = 'stub/model';
const TIMEOUT_MESSAGE = "Jev couldn't reach the model — try again in a minute.";

/** Stub client whose n-th call takes durationsMs[n] of (fake) time before answering replies[n]. */
class SlowStubLlm implements LlmClient {
  readonly requests: LlmJsonRequest[] = [];

  constructor(
    private readonly replies: string[],
    private readonly durationsMs: number[],
    private readonly advance?: (ms: number) => void,
  ) {}

  async completeJson(req: LlmJsonRequest): Promise<LlmJsonResponse> {
    const i = this.requests.length;
    this.requests.push(structuredClone(req));
    const ms = this.durationsMs[i] ?? 0;
    if (this.advance) this.advance(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
    const content = this.replies[i];
    if (content === undefined) throw new Error('<stub:jev> no more replies');
    return {
      content,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.001 },
      providerGenerationId: `<stub:jev>-${i + 1}`,
      latencyMs: ms,
    };
  }
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
    expect(JEV_MIN_ATTEMPT_MS).toBeGreaterThan(0);
  });

  it('caps the repair attempt timeout at the time remaining before the deadline', async () => {
    let t = 0;
    const llm = new SlowStubLlm([picksJson([1]), picksJson([0, 2, 4, 8])], [80_000, 1_000], (ms) => (t += ms));

    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => t, timeoutMs: 45_000 });

    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(llm.requests[0].timeoutMs).toBe(45_000);
    expect(llm.requests[1].timeoutMs).toBe(30_000);
  });

  it('does not start the repair attempt when too little time remains, returning LLM_TIMEOUT', async () => {
    let t = 0;
    const firstMs = JEV_DEADLINE_MS - JEV_MIN_ATTEMPT_MS + 1;
    const llm = new SlowStubLlm([picksJson([1]), picksJson([0, 2, 4, 8])], [firstMs], (ms) => (t += ms));

    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => t });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ code: 'LLM_TIMEOUT', message: TIMEOUT_MESSAGE });
    expect(res.attempts).toBe(1);
    expect(llm.requests).toHaveLength(1);
    expect(res.rawOutputs).toEqual([picksJson([1])]);
    expect(res.usage.totalTokens).toBe(120);
    expect(logs.find('jev.run')[0]).toMatchObject({ outcome: 'error', err_code: 'LLM_TIMEOUT', attempts: 1 });
  });

  it('makes no call at all when the deadline is already shorter than the minimum attempt', async () => {
    const llm = new SlowStubLlm([picksJson([0, 2, 4, 8])], [0], () => {});

    const res = await runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => 0, deadlineMs: JEV_MIN_ATTEMPT_MS - 1 });

    expect(!res.ok && res.error.code).toBe('LLM_TIMEOUT');
    expect(res.attempts).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('abandons a call that outlasts the deadline (adapter retries included) with LLM_TIMEOUT at 110 s', async () => {
    vi.useFakeTimers({ now: 0 });
    // First answer invalid after 60 s; the repair call would take 3 × 45 s + retry waits — far past 120 s.
    const llm = new SlowStubLlm([picksJson([1]), picksJson([0, 2, 4, 8])], [60_000, 160_000]);

    const pending = runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => Date.now(), timeoutMs: 45_000 });
    await vi.advanceTimersByTimeAsync(JEV_DEADLINE_MS);
    const res = await pending;

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ code: 'LLM_TIMEOUT', message: TIMEOUT_MESSAGE });
    expect(res.attempts).toBe(2);
    expect(llm.requests[1].timeoutMs).toBe(45_000);
    expect(res.latencyMs).toBe(JEV_DEADLINE_MS);
    expect(res.latencyMs).toBeLessThan(120_000);
    expect(vi.getTimerCount()).toBe(1); // only the abandoned stub call's timer; the deadline timer was cleared
  });

  it('honours a custom deadline and clears its timer when the call answers in time', async () => {
    vi.useFakeTimers({ now: 0 });
    const llm = new SlowStubLlm([picksJson([0, 2, 4, 8])], [9_000]);

    const pending = runJev(makeInput(makeSentences(10)), { llm, model: MODEL, now: () => Date.now(), deadlineMs: 20_000 });
    await vi.advanceTimersByTimeAsync(9_000);
    const res = await pending;

    expect(res.ok).toBe(true);
    expect(llm.requests[0].timeoutMs).toBe(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
