// The site's AI provider (SMA-44) against real blog0_test: GET/PUT /api/admin/ai and POST
// /api/admin/ai/test, the sealed key (never in a DTO, a log or the row in plain text), keep/replace/
// remove semantics, validation, the outcome status a failing provider shows the admin, and the
// unreadable-key case after a secret change. Provider HTTP is a fake fetch (error paths + a stub
// success shape); the real call is covered by the real-key suites.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as getRoute, PUT as putRoute } from '@/app/api/admin/ai/route';
import { POST as testRoute } from '@/app/api/admin/ai/test/route';
import type { AiProviderResponse, AiProviderTestResult } from '@/lib/api/dto';
import type { Envelope } from '@/lib/api/envelope';
import { getAi, getAiProvider, isAiConfigured, resolveAi } from '@/server/ai/provider';
import { seal } from '@/server/ai/secret-box';
import { Secret } from '@/server/config';
import { getDb } from '@/server/db/client';
import { aiProvider } from '@/server/db/schema';
import { LlmError } from '@/server/llm/types';

import { ORIGIN } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const KEY = 'sk-test-ai-provider-key-0123456789-WXYZ';
const BASE = 'https://llm.example.test/v1';

async function call<T>(handler: Handler, method: 'GET' | 'PUT' | 'POST', path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: 'localhost:3410' };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== 'GET') headers.origin = ORIGIN;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers, body }), { params: Promise.resolve({}) });
  return { status: res.status, env: (await res.json()) as Envelope<T> };
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const okChat = (content: string) => ({ id: 'gen-1', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 9, completion_tokens: 3 } });

let admin: TestLogin;
let logs: CapturedLogs;

beforeEach(async () => {
  await resetDb();
  admin = await loginAs({ displayName: 'AI Admin' });
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  vi.unstubAllGlobals();
});

const put = (body: unknown) => call<AiProviderResponse>(putRoute, 'PUT', '/api/admin/ai', { cookie: admin.cookie, body });

describe('GET/PUT /api/admin/ai', () => {
  it('starts with nothing set up: AI is off', async () => {
    const { status, env } = await call<AiProviderResponse>(getRoute, 'GET', '/api/admin/ai', { cookie: admin.cookie });
    expect(status).toBe(200);
    expect(env.ok && env.data.ai).toEqual({
      configured: false,
      baseUrl: '',
      model: '',
      keySet: false,
      keyHint: null,
      keyUnreadable: false,
      status: { failing: false, lastOkAt: null, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null },
    });
    expect(await isAiConfigured(admin.user.siteId)).toBe(false);
    await expect(getAi(admin.user.siteId)).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED', status: 503 });
  });

  it('saves endpoint, model and key; the key is sealed at rest and never returned or logged', async () => {
    const { status, env } = await put({ baseUrl: ` ${BASE} `, model: ' acme/chat-mini ', apiKey: KEY });

    expect(status).toBe(200);
    expect(env.ok && env.data.ai).toMatchObject({ configured: true, baseUrl: BASE, model: 'acme/chat-mini', keySet: true, keyHint: 'WXYZ' });
    expect(JSON.stringify(env)).not.toContain(KEY);
    const [row] = await getDb().select().from(aiProvider).where(eq(aiProvider.siteId, admin.user.siteId));
    expect(row.apiKeySealed).toMatch(/^v1\./);
    expect(row.apiKeySealed).not.toContain(KEY);
    expect(row.updatedBy).toBe(admin.user.id);
    expect(JSON.stringify(logs.lines)).not.toContain(KEY);
    expect(logs.find('ai.provider_saved')[0]).toMatchObject({ host: 'llm.example.test', model: 'acme/chat-mini', key: 'replaced' });

    const ai = await resolveAi(admin.user.siteId);
    expect(ai?.model).toBe('acme/chat-mini');
  });

  it('keeps the saved key when apiKey is omitted, and null removes it (AI off)', async () => {
    await put({ baseUrl: BASE, model: 'acme/chat-mini', apiKey: KEY });
    const kept = await put({ baseUrl: BASE, model: 'acme/chat-large' });
    expect(kept.env.ok && kept.env.data.ai).toMatchObject({ configured: true, model: 'acme/chat-large', keySet: true, keyHint: 'WXYZ' });

    const removed = await put({ baseUrl: BASE, model: 'acme/chat-large', apiKey: null });
    expect(removed.env.ok && removed.env.data.ai).toMatchObject({ configured: false, keySet: false, keyHint: null });
    expect(await resolveAi(admin.user.siteId)).toBeNull();
  });

  it.each([
    [{ baseUrl: 'ftp://x.test', model: 'm', apiKey: 'k' }, /http\(s\) URL/],
    [{ baseUrl: 'not a url', model: 'm', apiKey: 'k' }, /http\(s\) URL/],
    [{ baseUrl: BASE, model: '  ', apiKey: 'k' }, /model can’t be empty/],
    [{ baseUrl: BASE, model: 'm', apiKey: '' }, /API key can’t be empty/],
    [{ baseUrl: BASE, model: 'm', extra: 1 }, /./],
  ])('rejects %j with VALIDATION_FAILED', async (body, message) => {
    const { status, env } = await put(body);
    expect(status).toBe(400);
    expect(!env.ok && env.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(env)).toMatch(message);
  });

  it('needs a signed-in admin', async () => {
    const { status } = await call(getRoute, 'GET', '/api/admin/ai');
    expect(status).toBe(401);
  });
});

describe('POST /api/admin/ai/test', () => {
  const test = (body: unknown = {}) => call<AiProviderTestResult>(testRoute, 'POST', '/api/admin/ai/test', { cookie: admin.cookie, body });

  it('tests the form values (key not saved yet) with one tiny JSON chat call to {base}/chat/completions', async () => {
    const fetchMock = vi.fn(async () => reply(200, okChat('{"ok":true}')));
    vi.stubGlobal('fetch', fetchMock);

    const { status, env } = await test({ baseUrl: BASE, model: 'acme/chat-mini', apiKey: KEY });

    expect(status).toBe(200);
    expect(env.ok && env.data).toMatchObject({ ok: true, model: 'acme/chat-mini', jsonOk: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'acme/chat-mini', response_format: { type: 'json_object' } });
    expect(JSON.stringify(logs.lines)).not.toContain(KEY);
  });

  it('reports a model that answers but not in JSON as reached-but-not-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, okChat('Sure, here you go: ok'))));
    const { env } = await test({ baseUrl: BASE, model: 'm', apiKey: KEY });
    expect(env.ok && env.data).toMatchObject({ ok: true, jsonOk: false });
  });

  it('returns the provider failure as the result (200), in plain words, and records it on the saved provider', async () => {
    await put({ baseUrl: BASE, model: 'acme/chat-mini', apiKey: KEY });
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: { message: 'Invalid API key provided' } })));

    const { status, env } = await test();

    expect(status).toBe(200);
    expect(env.ok && env.data).toEqual({
      ok: false,
      code: 'LLM_AUTH',
      message: 'The AI provider rejected the API key — check it in Admin → Site → AI provider. (Invalid API key provided)',
    });
    expect((await getAiProvider(admin.user.siteId)).status).toMatchObject({ failing: true, lastErrorCode: 'LLM_AUTH' });
  });

  it('asks for the missing pieces without calling anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await test({ baseUrl: BASE, model: 'm' })).env).toMatchObject({ ok: true, data: { ok: false, message: 'Enter an API key first.' } });
    expect((await test({ apiKey: KEY })).env).toMatchObject({ ok: true, data: { ok: false, message: 'Enter an http(s) endpoint first.' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('call outcomes (the failing-provider banner)', () => {
  it('a failed call marks the provider failing; the next success clears it; a changed provider starts clean', async () => {
    await put({ baseUrl: BASE, model: 'acme/chat-mini', apiKey: KEY });
    const ai = (await resolveAi(admin.user.siteId))!;
    const req = { model: ai.model, messages: [{ role: 'user' as const, content: 'hi' }], purpose: 'test', promptVersion: 'v', requestId: 'r', timeoutMs: 5000 };

    // A 401 is not retried (a 5xx would wait out the real backoff).
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: { message: 'revoked' } })));
    await expect(ai.client.chat(req)).rejects.toBeInstanceOf(LlmError);
    const failing = await getAiProvider(admin.user.siteId);
    expect(failing.status).toMatchObject({ failing: true, lastErrorCode: 'LLM_AUTH' });
    expect(failing.status.lastErrorMessage).toMatch(/rejected the API key/);

    vi.stubGlobal('fetch', vi.fn(async () => reply(200, okChat('{"ok":true}'))));
    await ai.client.chat(req);
    expect((await getAiProvider(admin.user.siteId)).status).toMatchObject({ failing: false });

    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: { message: 'revoked' } })));
    await expect(ai.client.chat(req)).rejects.toBeInstanceOf(LlmError);
    await put({ baseUrl: BASE, model: 'acme/other' });
    expect((await getAiProvider(admin.user.siteId)).status).toEqual({ failing: false, lastOkAt: null, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null });
  });

  it('a key sealed under another server secret is unreadable: AI is off and the admin is told to re-enter it', async () => {
    await getDb()
      .insert(aiProvider)
      .values({ siteId: admin.user.siteId, baseUrl: BASE, model: 'm', apiKeySealed: seal(KEY, new Secret('a-different-session-secret-0123456789-abcdef')), apiKeyHint: 'WXYZ' });

    const dto = await getAiProvider(admin.user.siteId);
    expect(dto).toMatchObject({ configured: false, keySet: true, keyUnreadable: true });
    await expect(getAi(admin.user.siteId)).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED', message: expect.stringMatching(/can't be read/) });
  });
});
