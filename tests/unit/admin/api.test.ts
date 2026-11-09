import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRequest, articleApi, toApiResult, UNEXPECTED_MESSAGE } from '@/components/admin/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('apiRequest', () => {
  it('returns the envelope data on success and sends JSON with same-origin credentials', async () => {
    const fetchMock = respond(200, { ok: true, data: { deleted: true } });
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiRequest<{ deleted: true }>('/api/admin/articles/1', { method: 'PATCH', body: { a: 1 } });

    expect(result).toEqual({ ok: true, status: 200, data: { deleted: true } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/articles/1');
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('returns the server error code, message and details on an error envelope', async () => {
    vi.stubGlobal('fetch', respond(422, { ok: false, error: { code: 'PUBLISH_BLOCKED', message: 'No', details: { reasons: [] }, requestId: 'r' } }));

    const result = await apiRequest('/api/admin/articles/1/publish', { method: 'POST', body: {} });

    expect(result).toEqual({ ok: false, status: 422, error: { code: 'PUBLISH_BLOCKED', message: 'No', details: { reasons: [] } } });
  });

  it('maps a network failure and a non-JSON body to readable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const offline = await apiRequest('/api/admin/articles');
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.error.code).toBe('NETWORK');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 502 })));
    const garbled = await apiRequest('/api/admin/articles');
    expect(garbled.ok).toBe(false);
    if (!garbled.ok) expect(garbled.error).toMatchObject({ code: 'INTERNAL' });
  });

  it('reports an aborted request as ABORTED so callers can ignore it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }));

    const result = await apiRequest('/api/admin/preview', { method: 'POST', body: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ABORTED');
  });
});

describe('toApiResult', () => {
  it('unwraps data, keeps error details, hides INTERNAL messages and treats a missing envelope as INTERNAL', () => {
    expect(toApiResult(200, { ok: true, data: { a: 1 } })).toEqual({ ok: true, status: 200, data: { a: 1 } });
    expect(toApiResult(409, { ok: false, error: { code: 'CONFLICT', message: 'Newer', details: { n: 2 }, requestId: 'r' } })).toEqual({
      ok: false,
      status: 409,
      error: { code: 'CONFLICT', message: 'Newer', details: { n: 2 } },
    });
    expect(toApiResult(500, { ok: false, error: { code: 'INTERNAL', message: 'stack trace', requestId: 'r' } })).toEqual({
      ok: false,
      status: 500,
      error: { code: 'INTERNAL', message: UNEXPECTED_MESSAGE },
    });
    expect(toApiResult(502, null)).toEqual({ ok: false, status: 502, error: { code: 'INTERNAL', message: UNEXPECTED_MESSAGE } });
  });
});

describe('articleApi', () => {
  it('builds an article route, encoding the id', () => {
    expect(articleApi('a1')).toBe('/api/admin/articles/a1');
    expect(articleApi('a1', 'tldr/generate')).toBe('/api/admin/articles/a1/tldr/generate');
    expect(articleApi('a/b')).toBe('/api/admin/articles/a%2Fb');
  });
});
