import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Secret } from '@/server/config';
import { chatCompletionsUrl, ChatClient, classifyHttpError, parseJsonReply, parseRetryAfter } from '@/server/llm/chat';
import { LlmError, type ChatRequest } from '@/server/llm/types';
import { resetLoggerForTests } from '@/server/log';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';

// The OpenAI-compatible chat adapter (SMA-44): request shape, JSON mode (and dropping it for a
// provider that refuses it), retries, error mapping, writer messages, logs without the key.

const KEY = 'unit-test-key-0123456789-not-real';
const BASE = 'https://llm.test/v1';
const URL = 'https://llm.test/v1/chat/completions';
const MODEL = 'acme/chat-mini';

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

/** An OpenAI-shaped chat completion (OpenRouter adds `provider` and `usage.cost`). */
function okBody(content: unknown = '{"scores":{"p-1-s0":0.82}}', usage: Record<string, unknown> | null = { prompt_tokens: 394, completion_tokens: 60, cost: 0.000016548 }) {
  return { id: 'gen-1', model: MODEL, provider: 'Acme', choices: [{ index: 0, message: { role: 'assistant', content } }], ...(usage ? { usage } : {}) };
}

function makeClient(replies: Reply[]) {
  const { fetch, calls } = fakeFetch(replies);
  const sleeps: number[] = [];
  let t = 0;
  const client = new ChatClient({
    apiKey: new Secret(KEY),
    baseUrl: `${BASE}/`,
    referer: 'http://localhost:3410',
    fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => (t += 5),
  });
  return { client, calls, sleeps };
}

const REQ: ChatRequest = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'Score sentences.' },
    { role: 'user', content: 'p-1-s0: The sky is blue.' },
  ],
  purpose: 'tldr.rank',
  json: true,
  requestId: 'req-1',
  promptVersion: 'tldr-rank-v2',
  timeoutMs: 45_000,
  batch: { index: 2, count: 3 },
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

describe('ChatClient', () => {
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

  it('POSTs { model, messages, response_format, temperature } to {base}/chat/completions with the bearer key', async () => {
    const { client, calls } = makeClient([{ status: 200, body: okBody() }]);

    await client.chat({ ...REQ, maxTokens: 50 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('http://localhost:3410');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: MODEL,
      messages: REQ.messages,
      response_format: { type: 'json_object' },
      max_tokens: 50,
      temperature: 0,
    });
  });

  it('sends no response_format when JSON mode is not asked', async () => {
    const { client, calls } = makeClient([{ status: 200, body: okBody('hi') }]);
    await client.chat({ ...REQ, json: false });
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('response_format');
  });

  it('returns the assistant content, usage (cost when reported), generation id, provider and the raw body', async () => {
    const body = okBody();
    const { client } = makeClient([{ status: 200, body }]);

    const res = await client.chat(REQ);

    expect(res.content).toBe('{"scores":{"p-1-s0":0.82}}');
    expect(res.usage).toEqual({ inputTokens: 394, outputTokens: 60, costUsd: 0.000016548 });
    expect(res.providerGenerationId).toBe('gen-1');
    expect(res.provider).toBe('Acme');
    expect(res.rawBody).toBe(JSON.stringify(body));
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(logs.find('llm.call')).toEqual([expect.objectContaining({ outcome: 'ok', purpose: 'tldr.rank', batch: 2, batches: 3, input_tokens: 394 })]);
  });

  it('reads array content parts and leaves cost null when the provider does not report it', async () => {
    const { client } = makeClient([{ status: 200, body: okBody([{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], { prompt_tokens: 1, completion_tokens: 2 }) }]);
    const res = await client.chat(REQ);
    expect(res.content).toBe('{"a":1}');
    expect(res.usage.costUsd).toBeNull();
  });

  it('asks once more without response_format when the provider refuses JSON mode (not counted as a retry)', async () => {
    const { client, calls, sleeps } = makeClient([
      { status: 400, body: { error: { message: "response_format 'json_object' is not supported by this model" } } },
      { status: 200, body: okBody() },
    ]);
    const res = await client.chat(REQ);
    expect(res.content).toContain('scores');
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(0);
    expect(JSON.parse(String(calls[1].init.body))).not.toHaveProperty('response_format');
  });

  it.each([
    [401, 'LLM_AUTH', 'The AI provider rejected the API key — check it in Admin → Site → AI provider.'],
    [403, 'LLM_AUTH', 'The AI provider rejected the API key — check it in Admin → Site → AI provider.'],
    [402, 'LLM_INSUFFICIENT_CREDITS', 'The AI provider account is out of credits.'],
    [404, 'LLM_MODEL_NOT_FOUND', "The AI provider doesn't offer the model 'acme/chat-mini' — check the model in Admin → Site → AI provider."],
  ])('maps HTTP %i to %s without retrying', async (status, code, message) => {
    const { client, calls, sleeps } = makeClient([{ status, body: { error: { code: status, message: 'nope' } } }]);

    const err = await expectLlmError(client.chat(REQ));

    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
    expect(err.httpStatus).toBe(status);
    expect(err.detail).toBe('nope');
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(logs.find('llm.call')[0]).toMatchObject({ outcome: 'http_error', http_status: status, err_message: 'nope', purpose: 'tldr.rank' });
  });

  it('maps a wrong-model 400 to LLM_MODEL_NOT_FOUND', async () => {
    const { client } = makeClient([{ status: 400, body: { error: { message: 'acme/chat-9 is not a valid model ID' } } }]);
    const err = await expectLlmError(client.chat({ ...REQ, model: 'acme/chat-9' }));
    expect(err.code).toBe('LLM_MODEL_NOT_FOUND');
  });

  it('maps another 400 to LLM_UNAVAILABLE without retrying', async () => {
    const { client, calls } = makeClient([{ status: 400, body: { error: { message: 'messages: required' } } }]);
    const err = await expectLlmError(client.chat(REQ));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 with 1 s then 3 s backoff plus jitter and succeeds on the third attempt', async () => {
    const r429 = { status: 429, body: { error: { code: 429, message: 'slow down' } } };
    const { client, calls, sleeps } = makeClient([r429, r429, { status: 200, body: okBody() }]);
    await client.chat(REQ);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1125, 3125]);
    expect(logs.find('llm.call').map((l) => l.attempt)).toEqual([1, 2, 3]);
  });

  it('maps 429 after the retries to LLM_RATE_LIMITED', async () => {
    const r429 = { status: 429, body: { error: { code: 429, message: 'slow down' } } };
    const { client, calls } = makeClient([r429, r429, r429]);
    const err = await expectLlmError(client.chat(REQ));
    expect(err.code).toBe('LLM_RATE_LIMITED');
    expect(err.message).toBe('The AI provider is rate-limiting requests — try again in a minute.');
    expect(calls).toHaveLength(3);
  });

  it('honours Retry-After capped at 10 s', async () => {
    const { client, sleeps } = makeClient([
      { status: 503, body: 'busy', headers: { 'retry-after': '2' } },
      { status: 503, body: 'busy', headers: { 'retry-after': '120' } },
      { status: 200, body: okBody() },
    ]);
    await client.chat(REQ);
    expect(sleeps).toEqual([2000, 10_000]);
  });

  it.each([500, 502, 503, 504])('maps HTTP %i after the retries to LLM_UNAVAILABLE ("may be down")', async (status) => {
    const reply = { status, body: { error: { code: status, message: 'upstream' } } };
    const { client, calls } = makeClient([reply, reply, reply]);
    const err = await expectLlmError(client.chat(REQ));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.message).toBe("Couldn't reach the AI provider — it may be down. Try again in a minute.");
    expect(err.httpStatus).toBe(status);
    expect(calls).toHaveLength(3);
  });

  it('retries network errors and maps exhaustion to LLM_UNAVAILABLE', async () => {
    const { client, calls } = makeClient([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const err = await expectLlmError(client.chat(REQ));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.httpStatus).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('maps a timeout to LLM_TIMEOUT without retrying and logs outcome timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { client, calls } = makeClient([timeout]);
    const err = await expectLlmError(client.chat(REQ));
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(calls).toHaveLength(1);
    expect(logs.find('llm.call')[0].outcome).toBe('timeout');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a non-JSON body', '<html>bad gateway</html>'],
    ['a body without choices', { id: 'x', usage: {} }],
    ['a choice without content', { choices: [{ message: { role: 'assistant' } }] }],
  ])('treats a 200 with %s as a retryable gateway glitch (outcome invalid_body)', async (_label, bad) => {
    const { client, calls } = makeClient([{ status: 200, body: bad }, { status: 200, body: okBody() }]);
    const res = await client.chat(REQ);
    expect(res.provider).toBe('Acme');
    expect(calls).toHaveLength(2);
    expect(logs.find('llm.call').map((l) => l.outcome)).toEqual(['invalid_body', 'ok']);
  });

  it('maps an error object embedded in a 200 body by its code', async () => {
    const { client } = makeClient([{ status: 200, body: { error: { code: 402, message: 'Insufficient credits' } } }]);
    const err = await expectLlmError(client.chat(REQ));
    expect(err.code).toBe('LLM_INSUFFICIENT_CREDITS');
  });

  it('never writes the API key or the prompt into a log line', async () => {
    const { client } = makeClient([{ status: 401, body: { error: { code: 401, message: 'No auth credentials found' } } }]);
    await expectLlmError(client.chat(REQ));
    expect(JSON.stringify(logs.lines)).not.toContain(KEY);
    expect(JSON.stringify(logs.lines)).not.toContain('The sky is blue');
  });
});

describe('chat helpers', () => {
  it('builds the completions URL from a base with or without a trailing slash or the path itself', () => {
    expect(chatCompletionsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatCompletionsUrl('https://openrouter.ai/api/v1/ ')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(chatCompletionsUrl('http://localhost:11434/v1/chat/completions')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('parses a JSON reply plain, fenced, or wrapped in prose; null otherwise', () => {
    expect(parseJsonReply('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonReply('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(parseJsonReply('Sure: {"ok":true}.')).toEqual({ ok: true });
    expect(parseJsonReply('nope')).toBeNull();
  });
});

describe('adapter helpers', () => {
  it('classifies statuses per spec/agent.md §2 error handler', () => {
    expect(classifyHttpError(401, '')).toBe('LLM_AUTH');
    expect(classifyHttpError(403, '')).toBe('LLM_AUTH');
    expect(classifyHttpError(402, '')).toBe('LLM_INSUFFICIENT_CREDITS');
    expect(classifyHttpError(404, '')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'Model foo/bar not found')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'Model typesafe/does-not-exist does not exist')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'Model typesafe/jev-1.12 does not exist')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'No endpoints found for acme/x.')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'blog0/nope is not a valid model ID')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'questions: required')).toBe('LLM_UNAVAILABLE');
    expect(classifyHttpError(408, '')).toBe('LLM_TIMEOUT');
    expect(classifyHttpError(429, '')).toBe('LLM_RATE_LIMITED');
    expect(classifyHttpError(502, '')).toBe('LLM_UNAVAILABLE');
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
