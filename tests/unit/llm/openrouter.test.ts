import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Secret } from '@/server/config';
import { classifyHttpError, OpenRouterDecisionsClient, parseRetryAfter } from '@/server/llm/openrouter';
import { LlmError, type DecisionsRequest } from '@/server/llm/types';
import { resetLoggerForTests } from '@/server/log';

import { captureLogs, type CapturedLogs } from '../../helpers/logs';

const KEY = 'unit-test-key-0123456789-not-real';
const URL = 'https://openrouter.test/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';

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

/** The verified response shape (2026-10-13). */
function okBody(answers: Record<string, unknown> = { 'p-1-s0': { type: 'noul', noul: 0.82 } }, usage: Record<string, unknown> | null = { input_tokens: 394, output_tokens: 60, cost: 0.000016548 }) {
  return { model: 'typesafe/jev-1.13-20260917', answers, ...(usage ? { usage } : {}), id: 'gen-dec-1', provider: 'TypeSafe' };
}

function makeClient(replies: Reply[]) {
  const { fetch, calls } = fakeFetch(replies);
  const sleeps: number[] = [];
  let t = 0;
  const client = new OpenRouterDecisionsClient({
    apiKey: new Secret(KEY),
    decisionsUrl: `${URL}/`,
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

const REQ: DecisionsRequest = {
  model: MODEL,
  state: { title: 'T', dek: '', article: 'The sky is blue.' },
  questions: {
    'p-1-s0': {
      type: 'noul',
      instructions: 'Is this sentence about colour? Sentence: "The sky is blue."',
      criteria: { true: 'It names a colour.', false: 'It does not name a colour.' },
    },
  },
  requestId: 'req-1',
  promptVersion: 'jev-rank-v1',
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

describe('OpenRouterDecisionsClient', () => {
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

  it('POSTs { model, state, questions } to the decisions URL with the bearer key, referer and title headers', async () => {
    const { client, calls } = makeClient([{ status: 200, body: okBody() }]);

    await client.decide(REQ);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBe('http://localhost:3410');
    expect(headers['X-Title']).toBe('blog0');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: MODEL, state: REQ.state, questions: REQ.questions });
  });

  it('returns answers, usage (cost from usage.cost), generation id, provider and the raw body', async () => {
    const body = okBody();
    const { client } = makeClient([{ status: 200, body }]);

    const res = await client.decide(REQ);

    expect(res.answers).toEqual({ 'p-1-s0': { type: 'noul', noul: 0.82 } });
    expect(res.usage).toEqual({ inputTokens: 394, outputTokens: 60, costUsd: 0.000016548 });
    expect(res.providerGenerationId).toBe('gen-dec-1');
    expect(res.provider).toBe('TypeSafe');
    expect(res.rawBody).toBe(JSON.stringify(body));
    expect(res.latencyMs).toBeGreaterThan(0);
    const call = logs.find('llm.call');
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({
      request_id: 'req-1',
      model: MODEL,
      prompt_version: 'jev-rank-v1',
      batch: 2,
      batches: 3,
      questions: 1,
      attempt: 1,
      input_tokens: 394,
      output_tokens: 60,
      cost_usd: 0.000016548,
      provider_generation_id: 'gen-dec-1',
      provider: 'TypeSafe',
      outcome: 'ok',
      http_status: 200,
    });
    expect(typeof call[0].latency_ms).toBe('number');
    expect(JSON.stringify(call[0])).not.toContain('sky is blue');
    expect(logs.find('llm.cost_missing')).toHaveLength(0);
  });

  it('returns costUsd null and warns llm.cost_missing when the provider omits cost', async () => {
    const { client } = makeClient([{ status: 200, body: okBody(undefined, { input_tokens: 10, output_tokens: 2 }) }]);

    const res = await client.decide(REQ);

    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: null });
    const warn = logs.find('llm.cost_missing');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ level: 'warn', request_id: 'req-1', model: MODEL, provider_generation_id: 'gen-dec-1' });
  });

  it('returns all-null usage when the provider sends no usage block', async () => {
    const { client } = makeClient([{ status: 200, body: okBody(undefined, null) }]);
    const res = await client.decide(REQ);
    expect(res.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  it('passes answers through unvalidated (Jev validates them)', async () => {
    const { client } = makeClient([{ status: 200, body: okBody({ 'p-1-s0': { type: 'noul', noul: 7 }, other: 'x' }) }]);
    const res = await client.decide(REQ);
    expect(res.answers).toEqual({ 'p-1-s0': { type: 'noul', noul: 7 }, other: 'x' });
  });

  it.each([
    [401, 'LLM_AUTH', 'OpenRouter rejected the API key — check BLOG0_OPENROUTER_API_KEY in .env.'],
    [403, 'LLM_AUTH', 'OpenRouter rejected the API key — check BLOG0_OPENROUTER_API_KEY in .env.'],
    [402, 'LLM_INSUFFICIENT_CREDITS', 'OpenRouter account is out of credits.'],
    [404, 'LLM_MODEL_NOT_FOUND', "Model 'typesafe/jev-1.13' isn't available as a decisions model — set BLOG0_JEV_MODEL (default typesafe/jev-1.13)."],
  ])('maps HTTP %i to %s without retrying', async (status, code, message) => {
    const { client, calls, sleeps } = makeClient([{ status, body: { error: { code: status, message: 'nope' } } }]);

    const err = await expectLlmError(client.decide(REQ));

    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
    expect(err.httpStatus).toBe(status);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(logs.find('llm.call')[0]).toMatchObject({ outcome: 'http_error', http_status: status, err_message: 'nope' });
  });

  it('maps the observed wrong-slug 400 body to LLM_MODEL_NOT_FOUND (slugs with dots included)', async () => {
    // Observed 2026-10-13 for typesafe/does-not-exist and for a chat slug (google/gemini-2.5-flash).
    const { client } = makeClient([{ status: 400, body: { error: { code: 400, message: 'Model typesafe/jev-9.99 does not exist' } } }]);
    const err = await expectLlmError(client.decide({ ...REQ, model: 'typesafe/jev-9.99' }));
    expect(err.code).toBe('LLM_MODEL_NOT_FOUND');
    expect(err.message).toBe("Model 'typesafe/jev-9.99' isn't available as a decisions model — set BLOG0_JEV_MODEL (default typesafe/jev-1.13).");
  });

  it('maps a 400 validation body (e.g. bad criteria) to LLM_UNAVAILABLE without retrying', async () => {
    const { client, calls } = makeClient([{ status: 400, body: { error: { code: 400, message: '[{"code":"invalid_union","path":[]}]' } } }]);
    const err = await expectLlmError(client.decide(REQ));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 with 1 s then 3 s backoff plus jitter and succeeds on the third attempt', async () => {
    const r429 = { status: 429, body: { error: { code: 429, message: 'slow down' } } };
    const { client, calls, sleeps } = makeClient([r429, r429, { status: 200, body: okBody() }]);

    const res = await client.decide(REQ);

    expect(res.answers).toHaveProperty('p-1-s0');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1125, 3125]);
    expect(logs.find('llm.call').map((l) => l.attempt)).toEqual([1, 2, 3]);
  });

  it('maps 429 after the retries to LLM_RATE_LIMITED', async () => {
    const r429 = { status: 429, body: { error: { code: 429, message: 'slow down' } } };
    const { client, calls } = makeClient([r429, r429, r429]);

    const err = await expectLlmError(client.decide(REQ));

    expect(err.code).toBe('LLM_RATE_LIMITED');
    expect(err.message).toBe("Jev couldn't reach the model — try again in a minute.");
    expect(calls).toHaveLength(3);
  });

  it('honours Retry-After capped at 10 s', async () => {
    const { client, sleeps } = makeClient([
      { status: 503, body: 'busy', headers: { 'retry-after': '2' } },
      { status: 503, body: 'busy', headers: { 'retry-after': '120' } },
      { status: 200, body: okBody() },
    ]);
    await client.decide(REQ);
    expect(sleeps).toEqual([2000, 10_000]);
  });

  it.each([500, 502, 503, 504])('maps HTTP %i after the retries to LLM_UNAVAILABLE', async (status) => {
    const reply = { status, body: { error: { code: status, message: 'upstream' } } };
    const { client, calls } = makeClient([reply, reply, reply]);
    const err = await expectLlmError(client.decide(REQ));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.httpStatus).toBe(status);
    expect(calls).toHaveLength(3);
  });

  it('retries network errors and maps exhaustion to LLM_UNAVAILABLE', async () => {
    const { client, calls } = makeClient([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const err = await expectLlmError(client.decide(REQ));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(err.httpStatus).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('recovers when a network error is followed by a success', async () => {
    const { client, calls } = makeClient([new TypeError('fetch failed'), { status: 200, body: okBody() }]);
    const res = await client.decide(REQ);
    expect(res.provider).toBe('TypeSafe');
    expect(calls).toHaveLength(2);
  });

  it('maps a timeout to LLM_TIMEOUT without retrying and logs outcome timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { client, calls } = makeClient([timeout]);
    const err = await expectLlmError(client.decide(REQ));
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(calls).toHaveLength(1);
    expect(logs.find('llm.call')[0].outcome).toBe('timeout');
  });

  it('passes the request timeout as an abort signal', async () => {
    const { client, calls } = makeClient([{ status: 200, body: okBody() }]);
    await client.decide(REQ);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a non-JSON body', '<html>bad gateway</html>'],
    ['a body without answers', { model: MODEL, usage: {} }],
    ['answers that are not an object', { answers: [1, 2] }],
  ])('treats a 200 with %s as a retryable gateway glitch (outcome invalid_body)', async (_label, bad) => {
    const { client, calls } = makeClient([{ status: 200, body: bad }, { status: 200, body: okBody() }]);
    const res = await client.decide(REQ);
    expect(res.provider).toBe('TypeSafe');
    expect(calls).toHaveLength(2);
    expect(logs.find('llm.call').map((l) => l.outcome)).toEqual(['invalid_body', 'ok']);
  });

  it('maps a persistent invalid 200 body to LLM_UNAVAILABLE after the retries', async () => {
    const bad = { status: 200, body: 'not json' };
    const { client, calls } = makeClient([bad, bad, bad]);
    const err = await expectLlmError(client.decide(REQ));
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(calls).toHaveLength(3);
  });

  it('maps an error object embedded in a 200 body by its code', async () => {
    const { client } = makeClient([{ status: 200, body: { error: { code: 402, message: 'Insufficient credits' } } }]);
    const err = await expectLlmError(client.decide(REQ));
    expect(err.code).toBe('LLM_INSUFFICIENT_CREDITS');
  });

  it('never writes the API key into a log line', async () => {
    const { client } = makeClient([{ status: 401, body: { error: { code: 401, message: 'No auth credentials found' } } }]);
    await expectLlmError(client.decide(REQ));
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
    expect(classifyHttpError(400, 'Model typesafe/does-not-exist does not exist')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'Model typesafe/jev-1.12 does not exist')).toBe('LLM_MODEL_NOT_FOUND');
    expect(classifyHttpError(400, 'google/gemini-2.5-flash is not a decisions model')).toBe('LLM_MODEL_NOT_FOUND');
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
