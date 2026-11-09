import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B1 regression (PII): a failing Listmonk call must never put the subscriber's address — which rides
// in `GET /api/subscribers?query=subscribers.email='…'` — into a SenderError message (those reach
// logs, `newsletter_issue.last_error` and stderr) or into a `newsletter.provider` log line.

const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
vi.mock('@/server/log', () => {
  const push = (event: string, fields: Record<string, unknown> = {}) => lines.push({ event, fields });
  return {
    log: { debug: push, info: push, warn: push, error: push },
    maskEmail: (email: string) => {
      const at = email.indexOf('@');
      return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
    },
  };
});

const { Secret } = await import('@/server/config');
const { ListmonkSender, SenderError, redactEmails, safePath } = await import('@/server/newsletter/sender');

const EMAIL = 'Private.Reader+news@example.org';

function sender() {
  return new ListmonkSender({ url: 'http://listmonk.test:9000', apiUser: 'blog0', apiToken: new Secret('tok-secret'), listId: 3 });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function assertNoAddress(text: string): void {
  expect(text).not.toContain('@');
  expect(text.toLowerCase()).not.toContain('%40');
  expect(text.toLowerCase()).not.toContain('private.reader');
  expect(text).not.toContain('example.org');
}

async function caught(p: Promise<unknown>): Promise<InstanceType<typeof SenderError>> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SenderError);
    return err as InstanceType<typeof SenderError>;
  }
  throw new Error('expected a SenderError');
}

beforeEach(() => {
  lines.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ListmonkSender error messages carry no subscriber address', () => {
  it('a 5xx on findByEmail (after its one retry) → HTTP SenderError naming the path without the query', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { message: `query failed for subscribers.email='${EMAIL.toLowerCase()}'` }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await caught(sender().removeSubscriber(EMAIL));

    expect(fetchMock).toHaveBeenCalledTimes(2); // one retry on 5xx
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('query='); // the request itself still filters by address
    expect(err.code).toBe('HTTP');
    expect(err.httpStatus).toBe(503);
    expect(err.message).toMatch(/^Listmonk GET \/api\/subscribers → 503: /);
    assertNoAddress(err.message);
    for (const l of lines) assertNoAddress(JSON.stringify(l.fields));
    expect(lines.filter((l) => l.event === 'newsletter.provider').map((l) => l.fields.path)).toEqual(['/api/subscribers', '/api/subscribers']);
  });

  it('a non-JSON answer and a network failure on findByEmail stay address-free too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 400 })));
    const invalid = await caught(sender().removeSubscriber(EMAIL));
    expect(invalid.code).toBe('INVALID');
    assertNoAddress(invalid.message);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        throw new TypeError(`fetch failed for ${url}`);
      }),
    );
    const down = await caught(sender().removeSubscriber(EMAIL));
    expect(down.code).toBe('UNAVAILABLE');
    assertNoAddress(down.message);
    for (const l of lines) assertNoAddress(JSON.stringify(l.fields));
  });

  it('safePath / redactEmails (edge cases: encoded addresses, no query)', () => {
    expect(safePath("/api/subscribers?query=subscribers.email%3D'a%40b.c'&per_page=1")).toBe('/api/subscribers');
    expect(safePath('/api/campaigns/12')).toBe('/api/campaigns/12');
    expect(redactEmails('no such subscriber a.b@c.example (id 4)')).toBe('no such subscriber [email] (id 4)');
    expect(redactEmails("email%3D'x%40y.z'")).not.toMatch(/%40|@/);
    expect(redactEmails('plain text')).toBe('plain text');
  });
});

describe('ListmonkSender.deleteSubscriber (erasure): a 404 from Listmonk counts as done', () => {
  const record = { id: 41, email: EMAIL.toLowerCase(), name: 'R', status: 'enabled', attribs: { blog0_subscriber_id: 'gone-id' }, lists: [], updated_at: '2026-10-01T00:00:00Z' };

  it('the record vanishes between the lookup and the DELETE (404) → not_found, no throw', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${new URL(url).pathname}`);
        return init.method === 'DELETE' ? jsonResponse(404, { message: 'not found' }) : jsonResponse(200, { data: record });
      }),
    );
    expect(await sender().deleteSubscriber({ providerId: '41', email: EMAIL })).toEqual({ outcome: 'not_found', providerId: '41' });
    expect(calls).toEqual(['GET /api/subscribers/41', 'DELETE /api/subscribers/41']);
  });

  it('a retry by id that Listmonk no longer knows (404 or v5.1.0’s 400 "not found") → not_found without a DELETE', async () => {
    for (const status of [404, 400]) {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push(`${init.method} ${new URL(url).pathname}`);
          return jsonResponse(status, { message: 'Subscriber (41: ) not found' });
        }),
      );
      expect(await sender().deleteSubscriber({ providerId: '41', email: null })).toEqual({ outcome: 'not_found', providerId: '41' });
      expect(calls).toEqual(['GET /api/subscribers/41']);
    }
  });

  it('a 5xx on the DELETE (after its retry) throws a SenderError without the address — the caller records `failed`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => (init.method === 'DELETE' ? jsonResponse(503, { message: `cannot delete ${EMAIL}` }) : jsonResponse(200, { data: record }))),
    );
    const e = await caught(sender().deleteSubscriber({ providerId: '41', email: EMAIL }));
    expect(e.httpStatus).toBe(503);
    assertNoAddress(e.message);
    for (const l of lines) assertNoAddress(JSON.stringify(l.fields));
  });
});
