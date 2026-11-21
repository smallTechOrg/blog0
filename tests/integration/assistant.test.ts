// The writing assistant (SMA-43) against real blog0_test: the editable instructions (GET/PUT
// /api/admin/ai/assistant, default + reset), and POST /api/admin/assistant/review through the site's
// AI provider — a stub chat client here (setAiForTests): what is sent (instructions + the fixed
// output contract, the draft, the changed text), the cleaned comments, AI off, the per-writer
// limit, unreadable output, provider errors, and that the draft never reaches a log line.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as getPromptRoute, PUT as putPromptRoute } from '@/app/api/admin/ai/assistant/route';
import { POST as reviewRoute } from '@/app/api/admin/assistant/review/route';
import type { AssistantPromptResponse, AssistantReviewResponse } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { DEFAULT_ASSISTANT_PROMPT, resetAssistantLimitsForTests } from '@/server/ai/assistant';
import { setAiForTests } from '@/server/ai/provider';
import { LlmError, type ChatRequest, type ChatResponse, type LlmClient } from '@/server/llm/types';

import { ORIGIN } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call<T>(handler: Handler, method: 'GET' | 'PUT' | 'POST', path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = { host: 'localhost:3410', cookie };
  if (method !== 'GET') headers.origin = ORIGIN;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {
    params: Promise.resolve({}),
  });
  return { status: res.status, env: (await res.json()) as Envelope<T> };
}

class StubChat implements LlmClient {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly reply: (req: ChatRequest) => string | Error) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const r = this.reply(req);
    if (r instanceof Error) throw r;
    return { content: r, usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, providerGenerationId: null, provider: '<stub:assistant>', latencyMs: 1, rawBody: r };
  }
}

const CANARY = 'The marmalade lighthouse was built in 1887 by seven owls.';
const DRAFT = { title: 'Lighthouses', dek: 'A short history.', bodyMd: `Lighthouses guide ships.\n\n${CANARY}`, changed: CANARY, trigger: 'sentence' as const };

let admin: TestLogin;
let logs: CapturedLogs;

beforeEach(async () => {
  await resetDb();
  resetAssistantLimitsForTests();
  admin = await loginAs({ displayName: 'Writer With Help' });
  logs = captureLogs();
});

afterEach(() => {
  setAiForTests(null);
  logs.stop();
});

const review = (body: unknown = DRAFT) => call<AssistantReviewResponse>(reviewRoute, 'POST', '/api/admin/assistant/review', admin.cookie, body);

describe('the assistant’s instructions', () => {
  it('start as the default, save a custom text, and reset to the default', async () => {
    const first = await call<AssistantPromptResponse>(getPromptRoute, 'GET', '/api/admin/ai/assistant', admin.cookie);
    expect(first.env.ok && first.env.data.assistant).toEqual({ prompt: DEFAULT_ASSISTANT_PROMPT, isDefault: true, defaultPrompt: DEFAULT_ASSISTANT_PROMPT });

    const saved = await call<AssistantPromptResponse>(putPromptRoute, 'PUT', '/api/admin/ai/assistant', admin.cookie, { prompt: '  Be a fact-checker only.  ' });
    expect(saved.env.ok && saved.env.data.assistant).toMatchObject({ prompt: 'Be a fact-checker only.', isDefault: false });

    const reset = await call<AssistantPromptResponse>(putPromptRoute, 'PUT', '/api/admin/ai/assistant', admin.cookie, { prompt: null });
    expect(reset.env.ok && reset.env.data.assistant).toMatchObject({ prompt: DEFAULT_ASSISTANT_PROMPT, isDefault: true });
  });

  it('refuses instructions over 4000 characters', async () => {
    const { status } = await call(putPromptRoute, 'PUT', '/api/admin/ai/assistant', admin.cookie, { prompt: 'x'.repeat(4001) });
    expect(status).toBe(400);
  });
});

describe('POST /api/admin/assistant/review', () => {
  it('sends the instructions + the output contract, the draft and the changed text; returns cleaned comments', async () => {
    await call(putPromptRoute, 'PUT', '/api/admin/ai/assistant', admin.cookie, { prompt: 'Check dates carefully.' });
    const stub = new StubChat(() =>
      JSON.stringify({
        comments: [
          { kind: 'accuracy', quote: 'built in 1887', text: 'Check the year — sources disagree.' },
          { kind: 'missing', quote: '', text: 'Say where the lighthouse is.' },
        ],
      }),
    );
    setAiForTests({ client: stub, model: 'stub/assistant' });

    const { status, env } = await review();

    expect(status).toBe(200);
    expect(env.ok && env.data).toMatchObject({
      model: 'stub/assistant',
      comments: [
        { kind: 'accuracy', quote: 'built in 1887', text: 'Check the year — sources disagree.' },
        { kind: 'missing', quote: null, text: 'Say where the lighthouse is.' },
      ],
    });
    const [req] = stub.requests;
    expect(req).toMatchObject({ purpose: 'assistant.review', promptVersion: 'assistant-v1', json: true, model: 'stub/assistant' });
    expect(req.messages[0].content.startsWith('Check dates carefully.')).toBe(true);
    expect(req.messages[0].content).toContain('{"comments":[{"kind":"accuracy|missing|clarity|question|note"');
    expect(req.messages[1].content).toContain('Title: Lighthouses');
    expect(req.messages[1].content).toContain(`<changed>\n${CANARY}\n</changed>`);
    // Sizes and counts only in the logs — never the draft.
    expect(JSON.stringify(logs.lines)).not.toContain('marmalade');
    expect(logs.find('assistant.review')[0]).toMatchObject({ outcome: 'ok', comments: 2, trigger: 'sentence' });
  });

  it('is LLM_NOT_CONFIGURED (503) when no AI provider is set up', async () => {
    const { status, env } = await review();
    expect(status).toBe(503);
    expect(!env.ok && env.error.code).toBe('LLM_NOT_CONFIGURED');
  });

  it('makes no call for an empty draft', async () => {
    const stub = new StubChat(() => '{"comments":[]}');
    setAiForTests({ client: stub });
    const { env } = await review({ ...DRAFT, bodyMd: '   ' });
    expect(env.ok && env.data.comments).toEqual([]);
    expect(stub.requests).toHaveLength(0);
  });

  it('answers 502 LLM_INVALID_OUTPUT when the model does not answer in the asked shape', async () => {
    setAiForTests({ client: new StubChat(() => 'Looks lovely, keep going!') });
    const { status, env } = await review();
    expect(status).toBe(502);
    expect(!env.ok && env.error.code).toBe('LLM_INVALID_OUTPUT');
  });

  it('passes provider errors through in plain words (503 for a provider that is down)', async () => {
    setAiForTests({ client: new StubChat(() => new LlmError('LLM_UNAVAILABLE', "Couldn't reach the AI provider — it may be down. Try again in a minute.", 503)) });
    const { status, env } = await review();
    expect(status).toBe(503);
    expect(!env.ok && env.error).toMatchObject({ code: 'LLM_UNAVAILABLE', message: expect.stringMatching(/may be down/) });
  });

  it('limits a writer to 8 reads a minute (429 RATE_LIMITED with Retry-After)', async () => {
    setAiForTests({ client: new StubChat(() => '{"comments":[]}') });
    for (let i = 0; i < 8; i++) expect((await review()).status).toBe(200);
    const { status, env } = await review();
    expect(status).toBe(429);
    expect(!env.ok && env.error.code).toBe('RATE_LIMITED');
  });

  it('refuses a body that is not a draft (validation)', async () => {
    const { status } = await review({ bodyMd: 'x', trigger: 'sometimes' });
    expect(status).toBe(400);
  });
});
