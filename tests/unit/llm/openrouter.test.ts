import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Secret } from '@/server/config';
import {
  classifyHttpError,
  OpenRouterClient,
  parseRetryAfter,
  stripJsonFence,
} from '@/server/llm/openrouter';
import { LlmError, type LlmJsonRequest } from '@/server/llm/types';
import { resetLoggerForTests } from '@/server/log';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';

const KEY = 'unit-test-key-0123456789-not-real';

interface Call {
  url: string;
  init: RequestInit;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error('fakeFetch: no more replies');
    if (next instanceof Error) throw next;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: next.headers });
  };
  return { fetch: impl as typeof fetch, calls };
}

function okBody(content: string, usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00042 }) {
  return { id: 'gen-abc', choices: [{ message: { role: 'assistant', content } }], usage };
}

function makeClient(replies: Reply[]) {
  const { fetch, calls } = fakeFetch(replies);
  const sleeps: number[] = [];
  let t = 0;
  const client = new OpenRouterClient({
    apiKey: new Secret(KEY),
    baseUrl: 'https://openrouter.test/api/v1/',
    referer: 'http://localhost:3410',
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => (t += 5),
  });
  return { client, calls, sleeps };
}

const REQ: LlmJsonRequest = {
  model: 'google/gemini-2.5-flash',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' },
  ],
  schemaName: 'jev_selection',
  schema: { type: 'object' },
  temperature: 0,
  maxTokens: 1200,
  requestId: 'req-1',
  promptVersion: 'jev-select-v1',
  timeoutMs: 45_000,
};

async function expectLlmError(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }
  throw new Error('expected an LlmError');
}

describe('OpenRouterClient', () => {
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

  it('posts the spec request shape with the bearer key, referer and title headers', async () => {
    const { client, calls } = makeClient([{ status: 200, body: okBody('{"picks":[]}') }]);

    await client.completeJson(REQ);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.test/api/v1/chat/completions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['HTTP-Referer']).toBe('http://localhost:3410');
    expect(headers['X-Title']).toBe('blog0');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      model: 'google/gemini-2.5-flash',
      messages: REQ.messages,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: 'json_schema', json_schema: { name: 'jev_selection', strict: true, schema: { type: 'object' } } },
      provider: { require_parameters: true },
      usage: { include: true },
    });
  });

  it('returns content, usage with cost, and the provider generation id', async () => {
    const { client } = makeClient([{ status: 200, body: okBody('{"picks":[{"index":0,"reason":"x"}]}') }]);

    const res = await client.completeJson(REQ);

    expect(res.content).toBe('{"picks":[{"index":0,"reason":"x"}]}');
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.00042 });
    expect(res.providerGenerationId).toBe('gen-abc');
    expect(res.latencyMs).toBeGreaterThan(0);
    const call = logs.find('llm.call');
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({
      request_id: 'req-1',
      model: 'google/gemini-2.5-flash',
      prompt_version: 'jev-select-v1',
      attempt: 1,
      prompt_tokens: 100,
      completion_tokens: 20,
      cost_usd: 0.00042,
      provider_generation_id: 'gen-abc',
      outcome: 'ok',
      http_status: 200,
    });
    expect(typeof call[0].latency_ms).toBe('number');
    expect(logs.find('llm.cost_missing')).toHaveLength(0);
  });

  it('returns costUsd null and warns llm.cost_missing when the provider omits cost', async () => {
    const { client } = makeClient([
      { status: 200, body: okBody('{"picks":[]}', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) },
    ]);

    const res = await client.completeJson(REQ);

    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12, costUsd: null });
    const warn = logs.find('llm.cost_missing');
    expect(warn).toHaveLength(1);
    expect(warn[0].level).toBe('warn');
  });

  it('returns all-null usage when the provider sends no usage block', async () => {
    const { client } = makeClient([{ status: 200, body: { id: 'g', choices: [{ message: { content: '{}' } }] } }]);

    const res = await client.completeJson(REQ);

    expect(res.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null });
  });

  it('strips one surrounding ```json fence from the content', async () => {
    const { client } = makeClient([{ status: 200, body: okBody('```json\n{"picks":[]}\n```') }]);

    const res = await client.completeJson(REQ);

    expect(res.content).toBe('{"picks":[]}');
  });

  it('returns non-JSON content unparsed and logs outcome invalid_json (Jev repairs it)', async () => {
    const { client } = makeClient([{ status: 200, body: okBody('Sure! Here are the picks: 1, 4, 7') }]);

    const res = await client.completeJson(REQ);

    expect(res.content).toBe('Sure! Here are the picks: 1, 4, 7');
    expect(logs.find('llm.call')[0].outcome).toBe('invalid_json');
  });

  it.each([
    [401, 'LLM_AUTH', 'OpenRouter rejected the API key — check BLOG0_OPENROUTER_API_KEY in .env.'],
    [403, 'LLM_AUTH', 'OpenRouter rejected the API key — check BLOG0_OPENROUTER_API_KEY in .env.'],
    [402, 'LLM_INSUFFICIENT_CREDITS', 'OpenRouter account is out of credits.'],
    [404, 'LLM_MODEL_NOT_FOUND', "Model 'google/gemini-2.5-flash' isn't available — set BLOG0_JEV_MODEL."],
  ])('maps HTTP %i to %s without retrying', async (status, code, message) => {
    const { client, calls, sleeps } = makeClient([{ status, body: { error: { code: status, message: 'nope' } } }]);

    const err = await expectLlmError(client.completeJson(REQ));

    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
    expect(err.httpStatus).toBe(status);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(logs.find('llm.call')[0]).toMatchObject({ outcome: 'http_error', http_status: status });
  });

  it('maps a 400 "not a valid model ID" body to LLM_MODEL_NOT_FOUND', async () => {
    const { client } = makeClient([
      { status: 400, body: { error: { code: 400, message: 'blog0/nope is not a valid model ID' } } },
    ]);

    const err = await expectLlmError(client.completeJson(REQ));

    expect(err.code).toBe('LLM_MODEL_NOT_FOUND');
  });

  it('retries a 429 with 1 s then 3 s backoff plus jitter and succeeds on the third attempt', async () => {
    const { client, calls, sleeps } = makeClient([
      { status: 429, body: { error: { code: 429, message: 'slow down' } } },
      { status: 429, body: { error: { code: 429, message: 'slow down' } } },
      { status: 200, body: okBody('{"picks":[]}') },
    ]);

    const res = await client.completeJson(REQ);

    expect(res.content).toBe('{"picks":[]}');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1125, 3125]);
    expect(logs.find('llm.call').map((l) => l.attempt)).toEqual([1, 2, 3]);
  });

  it('maps 429 after the retries to LLM_RATE_LIMITED', async () => {
    const r429 = { status: 429, body: { error: { code: 429, message: 'slow down' } } };
    const { client, calls } = makeClient([r429, r429, r429]);

    const err = await expectLlmError(client.completeJson(REQ));

    expect(err.code).toBe('LLM_RATE_LIMITED');
    expect(err.message).toBe("Jev couldn't reach the model — try again in a minute.");
    expect(calls).toHaveLength(3);
  });

  it('honours Retry-After capped at 10 s', async () => {
    const { client, sleeps } = makeClient([
      { status: 503, body: 'busy', headers: { 'retry-after': '2' } },
      { status: 503, body: 'busy', headers: { 'retry-after': '120' } },
      { status: 200, body: okBody('{}') },
    ]);

    await client.completeJson(REQ);

    expect(sleeps).toEqual([2000, 10_000]);
  });

  it.each([500, 502, 503, 504])('maps HTTP %i after the retries to LLM_UNAVAILABLE', async (status) => {
    const reply = { status, body: { error: { code: status, message: 'upstream' } } };
    const { client, calls } = makeClient([reply, reply, reply]);

    const err = await expectLlmError(client.completeJson(REQ));

    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.httpStatus).toBe(status);
    expect(calls).toHaveLength(3);
  });

  it('retries network errors and maps exhaustion to LLM_UNAVAILABLE', async () => {
    const { client, calls } = makeClient([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);

    const err = await expectLlmError(client.completeJson(REQ));

    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.httpStatus).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('recovers when a network error is followed by a success', async () => {
    const { client, calls } = makeClient([new TypeError('fetch failed'), { status: 200, body: okBody('{}') }]);

    const res = await client.completeJson(REQ);

    expect(res.content).toBe('{}');
    expect(calls).toHaveLength(2);
  });

  it('maps a timeout to LLM_TIMEOUT without retrying and logs outcome timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { client, calls } = makeClient([timeout]);

    const err = await expectLlmError(client.completeJson(REQ));

    expect(err.code).toBe('LLM_TIMEOUT');
    expect(calls).toHaveLength(1);
    expect(logs.find('llm.call')[0].outcome).toBe('timeout');
  });

  it('treats a 200 whose body is not JSON as a retryable gateway failure', async () => {
    const { client, calls } = makeClient([
      { status: 200, body: '<html>bad gateway</html>' },
      { status: 200, body: okBody('{}') },
    ]);

    const res = await client.completeJson(REQ);

    expect(res.content).toBe('{}');
    expect(calls).toHaveLength(2);
  });

  it('maps an error object embedded in a 200 body by its code', async () => {
    const { client } = makeClient([{ status: 200, body: { error: { code: 402, message: 'Insufficient credits' } } }]);

    const err = await expectLlmError(client.completeJson(REQ));

    expect(err.code).toBe('LLM_INSUFFICIENT_CREDITS');
  });

  it('never writes the API key into a log line', async () => {
    const { client } = makeClient([{ status: 401, body: { error: { code: 401, message: 'No auth credentials found' } } }]);

    await expectLlmError(client.completeJson(REQ));

    expect(JSON.stringify(logs.lines)).not.toContain(KEY);
  });
});

describe('adapter helpers', () => {
  it('classifies statuses per spec/agent.md §2 error handler', () => {
    expect(classifyHttpError(401, '')).toBe('LLM_AUTH');
    expect(classifyHttpError(403, '')).toBe('LLM_AUTH');
    expect(classifyHttpError(402, '')).toBe('LLM_INSUFFICIENT_CREDITS');
    expect(classifyHttpError(404, '')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'Model foo/bar not found')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'messages: required')).toBe('LLM_UNAVAILABLE');
    expect(classifyHttpError(408, '')).toBe('LLM_TIMEOUT');
    expect(classifyHttpError(429, '')).toBe('LLM_RATE_LIMITED');
    expect(classifyHttpError(502, '')).toBe('LLM_UNAVAILABLE');
  });

  it('strips only a surrounding fence', () => {
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('  {"a":"```"}  ')).toBe('{"a":"```"}');
  });

  it('parses Retry-After seconds and dates, capped at 10 s', () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('1.5', 0)).toBe(1500);
    expect(parseRetryAfter('99', 0)).toBe(10_000);
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(parseRetryAfter('Mon, 12 Oct 2026 10:00:04 GMT', now)).toBe(4000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
  });
});
