import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Envelope } from '@/lib/api/envelope';
import { ApiError, apiResult, withApi } from '@/server/http/api';

import { resetDb } from '../helpers/db';
import { captureLogs, type CapturedLogs } from '../helpers/logs';
import { loginAs } from '../helpers/session';

const ctx = { params: Promise.resolve({ id: 'abc' }) };
const ORIGIN = 'http://localhost:3410';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/admin/things`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3410', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const createThing = withApi(
  {
    auth: 'none',
    body: z.object({ title: z.string().min(1).max(20) }),
    summarizeInput: (body) => ({ titleChars: body.title.length }),
    summarizeOutput: () => ({ created: 1 }),
  },
  async ({ body, params }) => apiResult({ title: body.title, id: params.id }, { status: 201 }),
);

describe('withApi', () => {
  let logs: CapturedLogs;

  beforeEach(async () => {
    await resetDb();
    logs = captureLogs();
  });

  afterEach(() => {
    logs.stop();
  });

  it('parses the body, passes awaited params and returns the ok envelope with a custom status', async () => {
    const response = await createThing(post({ title: 'Hello' }), ctx);
    const body = (await response.json()) as Envelope<{ title: string; id: string }>;

    expect(response.status).toBe(201);
    expect(body).toEqual({ ok: true, data: { title: 'Hello', id: 'abc' } });
    expect(logs.find('api.request')[0]).toMatchObject({
      method: 'POST',
      status: 201,
      input_summary: { titleChars: 5 },
      output_summary: { created: 1 },
    });
  });

  it('rejects a mutation without a same-origin Origin header with 403 FORBIDDEN_ORIGIN', async () => {
    const crossSite = await createThing(post({ title: 'x' }, { origin: 'https://evil.example' }), ctx);
    const noOrigin = await createThing(
      new Request(`${ORIGIN}/api/admin/things`, { method: 'POST', body: '{"title":"x"}' }),
      ctx,
    );
    const hostMatch = await createThing(
      post({ title: 'x' }, { origin: 'http://127.0.0.1:3411', host: '127.0.0.1:3411' }),
      ctx,
    );

    expect(crossSite.status).toBe(403);
    expect(((await crossSite.json()) as Envelope<unknown>).ok).toBe(false);
    expect(noOrigin.status).toBe(403);
    expect(hostMatch.status).toBe(201);
  });

  it('answers 400 VALIDATION_FAILED with flattened issues for invalid or malformed bodies', async () => {
    const invalid = await createThing(post({ title: '' }), ctx);
    const malformed = await createThing(post('{not json'), ctx);

    const invalidBody = (await invalid.json()) as Envelope<unknown>;
    const malformedBody = (await malformed.json()) as Envelope<unknown>;
    expect(invalid.status).toBe(400);
    expect(malformed.status).toBe(400);
    if (invalidBody.ok || malformedBody.ok) throw new Error('expected errors');
    expect(invalidBody.error.code).toBe('VALIDATION_FAILED');
    expect(invalidBody.error.details).toMatchObject({ fieldErrors: { title: expect.any(Array) } });
    expect(malformedBody.error.message).toMatch(/not valid JSON/);
  });

  it('maps ApiError to its status and an unexpected throw to 500 INTERNAL without leaking the message', async () => {
    const expected = withApi({ auth: 'none' }, async () => {
      throw new ApiError('NOT_FOUND', 404, 'Article 3f2c not found', undefined, { 'retry-after': '5' });
    });
    const unexpected = withApi({ auth: 'none' }, async () => {
      throw new Error('secret internal detail');
    });

    const notFound = await expected(new Request(`${ORIGIN}/api/x`), ctx);
    const boom = await unexpected(new Request(`${ORIGIN}/api/y`), ctx);

    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('retry-after')).toBe('5');
    expect(boom.status).toBe(500);
    const boomBody = (await boom.json()) as Envelope<unknown>;
    if (boomBody.ok) throw new Error('expected error');
    expect(boomBody.error.code).toBe('INTERNAL');
    expect(JSON.stringify(boomBody)).not.toContain('secret internal detail');
    expect(logs.find('error')[0]).toMatchObject({ err_message: 'secret internal detail', request_id: boomBody.error.requestId });
  });

  it('guards admin routes: 401 without a session, the user in context and the log with one', async () => {
    const me = withApi({ auth: 'admin' }, async ({ auth }) => ({ name: auth.user.displayName }));
    const login = await loginAs({ displayName: 'Writer One' });

    const anonymous = await me(new Request(`${ORIGIN}/api/auth/me`), ctx);
    const signedIn = await me(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: login.cookie } }), ctx);

    expect(anonymous.status).toBe(401);
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ ok: true, data: { name: 'Writer One' } });
    expect(logs.find('api.request').map((l) => l.user_id)).toEqual([undefined, login.user.id]);
  });
});
