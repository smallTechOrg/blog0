// Structured logging on the admin API (spec/architecture.md §7): one `api.request` line per request
// with the required fields and the x-request-id; summaries hold counts/ids only (never article
// text, tokens, keys or full emails); a Generate failure emits `llm.call` + `jev.run` +
// `api.request` with the error code; lines reach BLOG0_LOG_FILE when it is set.
// The Generate path here uses a fake transport that returns a provider ERROR (HTTP 401) — this is
// an error-path test, never a stand-in for the real-key Generate (see tldr-flow.test.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as createRoute } from '@/app/api/admin/articles/route';
import { PATCH as patchRoute } from '@/app/api/admin/articles/[id]/route';
import { POST as generateRoute } from '@/app/api/admin/articles/[id]/tldr/generate/route';
import { POST as previewRoute } from '@/app/api/admin/preview/route';
import type { ArticleResponse } from '@/lib/api/dto';
import { resetJevDepsForTests, setJevDepsForTests } from '@/server/articles/tldr';
import { resetConfigForTests, Secret } from '@/server/config';
import { resetLoggerForTests } from '@/server/log';
import { OpenRouterClient } from '@/server/llm/openrouter';

import { actAs, call, ORIGIN } from '../helpers/api';
import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs, type TestLogin } from '../helpers/session';

const CANARY_TITLE = 'Canary Title Zebra Quokka';
const CANARY_SENTENCE = 'The marmalade lighthouse hums seven secret songs tonight.';
const BODY = [
  CANARY_SENTENCE,
  '',
  'Writers pick the lines by hand when the model is unavailable. That keeps publishing moving on a bad day.',
  '',
  'Readers can open the deck from any article page. The published deck keeps serving until the next publish.',
].join('\n');
const FAKE_KEY = 'fake-transport-key-sk-or-v1-0000';

let writer: TestLogin;
let logs: CapturedLogs;

beforeEach(async () => {
  await resetDb();
  resetJevDepsForTests();
  writer = actAs(await loginAs({ email: 'asha.writer@smalltech.in', displayName: 'Asha Writer' }));
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  resetJevDepsForTests();
});

describe('api.request lines', () => {
  it('emits one api.request line per request with the required fields and the response x-request-id', async () => {
    const { res, env } = await call<ArticleResponse>(createRoute, 'POST', '/api/admin/articles', { body: { title: CANARY_TITLE, bodyMd: BODY } });
    const created = env.ok ? env.data.article : null;

    const lines = logs.find('api.request');
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatchObject({
      level: 'info',
      method: 'POST',
      path: '/api/admin/articles',
      status: 201,
      user_id: writer.user.id,
      request_id: res.headers.get('x-request-id'),
      input_summary: { titleChars: CANARY_TITLE.length, bodyChars: BODY.length, hasTopic: false },
      output_summary: { article_id: created!.id, revision: 1, status: 'draft' },
    });
    expect(typeof line.latency_ms).toBe('number');
    expect(typeof line.ts).toBe('string');
    expect(line.err_code).toBeUndefined();
  });

  it('honours an incoming x-request-id and records err_code on failures', async () => {
    const { res } = await call(patchRoute, 'PATCH', '/api/admin/articles/00000000-0000-4000-8000-000000000000', {
      id: '00000000-0000-4000-8000-000000000000',
      body: { baseRevisionId: 'x', title: 'y' },
      headers: { 'x-request-id': 'itest-request-0001' },
    });
    const unauth = await call(listRoute, 'GET', '/api/admin/articles', { cookie: null });

    expect(res.headers.get('x-request-id')).toBe('itest-request-0001');
    const [notFound, unauthenticated] = logs.find('api.request');
    expect(notFound).toMatchObject({ request_id: 'itest-request-0001', status: 404, err_code: 'NOT_FOUND', method: 'PATCH' });
    expect(unauthenticated).toMatchObject({ status: 401, err_code: 'UNAUTHENTICATED' });
    expect(unauthenticated.user_id).toBeUndefined();
    expect(unauth.res.headers.get('x-request-id')).toBe(unauthenticated.request_id);
  });

  it('never logs article text, session tokens or full emails across create, save, preview and list', async () => {
    const { env } = await call<ArticleResponse>(createRoute, 'POST', '/api/admin/articles', { body: { title: CANARY_TITLE, bodyMd: BODY } });
    const created = env.ok ? env.data.article : null;
    await call(patchRoute, 'PATCH', `/api/admin/articles/${created!.id}`, {
      id: created!.id,
      body: { baseRevisionId: created!.currentRevision.id, bodyMd: `${BODY}\n\nAnother canary: ${CANARY_SENTENCE}`, dek: 'Secret dek words' },
    });
    await call(previewRoute, 'POST', '/api/admin/preview', { body: { title: CANARY_TITLE, dek: 'Secret dek words', bodyMd: BODY } });
    await call(listRoute, 'GET', '/api/admin/articles');

    const text = logs.lines.map((l) => JSON.stringify(l)).join('\n');
    expect(logs.find('api.request')).toHaveLength(4);
    expect(text).not.toContain('marmalade');
    expect(text).not.toContain('Zebra');
    expect(text).not.toContain('Secret dek');
    expect(text).not.toContain(writer.token);
    expect(text).not.toContain('asha.writer@smalltech.in');
  });
});

describe('Generate failure logging (fake transport: HTTP 401)', () => {
  it('emits llm.call, jev.run and api.request lines with the error code and without the key or article text', async () => {
    setJevDepsForTests({
      llm: new OpenRouterClient({
        apiKey: new Secret(FAKE_KEY),
        baseUrl: 'https://openrouter.invalid/api/v1',
        referer: ORIGIN,
        retryDelaysMs: [],
        sleep: async () => {},
        fetch: (async () =>
          new Response(JSON.stringify({ error: { code: 401, message: 'User not found.' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      }),
    });
    const { env } = await call<ArticleResponse>(createRoute, 'POST', '/api/admin/articles', { body: { title: CANARY_TITLE, bodyMd: BODY } });
    const created = env.ok ? env.data.article : null;
    logs.lines.length = 0;

    const { res } = await call(generateRoute, 'POST', `/api/admin/articles/${created!.id}/tldr/generate`, {
      id: created!.id,
      body: { revisionId: created!.currentRevision.id },
    });

    const requestId = res.headers.get('x-request-id');
    const [llm] = logs.find('llm.call');
    const [jev] = logs.find('jev.run');
    const [api] = logs.find('api.request');
    expect(llm).toMatchObject({ request_id: requestId, prompt_version: 'jev-select-v1', attempt: 1, outcome: 'http_error', http_status: 401 });
    expect(typeof llm.model).toBe('string');
    expect(typeof llm.latency_ms).toBe('number');
    expect(jev).toMatchObject({
      request_id: requestId,
      article_id: created!.id,
      revision_id: created!.currentRevision.id,
      sentence_count: 5,
      attempts: 1,
      outcome: 'error',
      err_code: 'LLM_AUTH',
    });
    expect(api).toMatchObject({
      request_id: requestId,
      path: `/api/admin/articles/${created!.id}/tldr/generate`,
      method: 'POST',
      status: 502,
      err_code: 'LLM_AUTH',
      input_summary: { revisionId: created!.currentRevision.id },
    });
    const text = logs.lines.map((l) => JSON.stringify(l)).join('\n');
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('marmalade');
  });
});

describe('BLOG0_LOG_FILE', () => {
  it('appends the api.request JSON line to the configured log file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blog0-logging-'));
    const file = path.join(dir, 'nested', 'server.log');
    const saved = { file: process.env.BLOG0_LOG_FILE, level: process.env.BLOG0_LOG_LEVEL };
    process.env.BLOG0_LOG_FILE = file;
    process.env.BLOG0_LOG_LEVEL = 'info';
    resetConfigForTests();
    resetLoggerForTests();
    try {
      const { res } = await call(listRoute, 'GET', '/api/admin/articles');

      const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      const api = lines.find((l) => l.event === 'api.request' && l.request_id === res.headers.get('x-request-id'));
      expect(api).toMatchObject({ method: 'GET', path: '/api/admin/articles', status: 200, output_summary: { articles: 0 } });
    } finally {
      if (saved.file === undefined) delete process.env.BLOG0_LOG_FILE;
      else process.env.BLOG0_LOG_FILE = saved.file;
      if (saved.level === undefined) delete process.env.BLOG0_LOG_LEVEL;
      else process.env.BLOG0_LOG_LEVEL = saved.level;
      resetConfigForTests();
      resetLoggerForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
