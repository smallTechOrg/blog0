import { afterEach, describe, expect, it, vi } from 'vitest';

import { Secret } from '@/server/config';
import { ListmonkSender, TRACKING_CACHE_MS } from '@/server/newsletter/sender/listmonk';

// Stage A `trackingPublic` on the Listmonk adapter (spec/architecture.md §13.3): GET /api/settings
// (3 s, no retry) → app.root_url; any failure → BLOG0_LISTMONK_URL; cached 10 min; never throws.

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);

function sender(url = 'http://listmonk:9000') {
  return new ListmonkSender({ url, apiUser: 'blog0', apiToken: new Secret('tok-secret'), listId: 3 });
}

function settingsResponse(rootUrl: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: { 'app.root_url': rootUrl, 'app.site_name': 'x', smtp: [{ password: 'smtp-secret' }] } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ListmonkSender.trackingPublic', () => {
  it('a public app.root_url → true even when BLOG0_LISTMONK_URL is a compose name; one GET /api/settings with a 3 s signal', async () => {
    const fetchMock = vi.fn(async () => settingsResponse('https://lists.example.com'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await sender().trackingPublic(T0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://listmonk:9000/api/settings');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a localhost / private root URL → false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse('http://localhost:9000')));
    expect(await sender('https://lists.example.com').trackingPublic(T0)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse('http://192.168.1.20:9000')));
    expect(await sender('https://lists.example.com').trackingPublic(T0)).toBe(false);
  });

  it('settings unreadable (403 / network error / 500, no retry) → falls back to BLOG0_LISTMONK_URL', async () => {
    const forbidden = vi.fn(async () => new Response(JSON.stringify({ message: 'permission denied' }), { status: 403 }));
    vi.stubGlobal('fetch', forbidden);
    expect(await sender('https://lists.example.com').trackingPublic(T0)).toBe(true);
    expect(await sender('http://listmonk:9000').trackingPublic(T0)).toBe(false);

    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', down);
    expect(await sender('http://127.0.0.1:9000').trackingPublic(T0)).toBe(false);
    expect(down).toHaveBeenCalledTimes(1);

    const broken = vi.fn(async () => new Response('oops', { status: 500 }));
    vi.stubGlobal('fetch', broken);
    expect(await sender('https://lists.example.com').trackingPublic(T0)).toBe(true);
    expect(broken).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn(async () => settingsResponse(42)));
    expect(await sender('https://lists.example.com').trackingPublic(T0)).toBe(true);
  });

  it('caches the answer for 10 minutes per sender', async () => {
    const fetchMock = vi.fn(async () => settingsResponse('http://localhost:9001'));
    vi.stubGlobal('fetch', fetchMock);
    const s = sender();

    expect(await s.trackingPublic(T0)).toBe(false);
    expect(await s.trackingPublic(T0 + TRACKING_CACHE_MS - 1)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => settingsResponse('https://lists.example.com'));
    expect(await s.trackingPublic(T0 + TRACKING_CACHE_MS)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
