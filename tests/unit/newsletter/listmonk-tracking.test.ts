import { afterEach, describe, expect, it, vi } from 'vitest';

// Open + click tracking via Listmonk (newsletter-issues.md): content links in the campaign body sent to
// Listmonk become `{{ TrackLink "…" }}`; unsubscribe / privacy / mailto links never do; the blog0-issue
// template carries `{{ TrackView }}` and an existing template with a different body is updated.

vi.mock('@/server/log', () => {
  const noop = () => undefined;
  return { log: { debug: noop, info: noop, warn: noop, error: noop }, maskEmail: (e: string) => e };
});

const { Secret } = await import('@/server/config');
const { ListmonkSender, BLOG0_TEMPLATE_BODY, BLOG0_TEMPLATE_NAME, toListmonkCampaignBody, trackLinks } = await import('@/server/newsletter/sender');
const { UNSUBSCRIBE_PLACEHOLDER, CONSENT_PLACEHOLDER } = await import('@/server/newsletter/sender/types');

describe('trackLinks', () => {
  it('wraps http(s) content links in TrackLink, decoding HTML entities in the URL', () => {
    const html = '<a href="https://blog.test/p/one">One</a> <a class="x" href="http://blog.test/p/two?a=1&amp;b=2">Two</a>';
    expect(trackLinks(html)).toBe(
      '<a href="{{ TrackLink "https://blog.test/p/one" }}">One</a> <a class="x" href="{{ TrackLink "http://blog.test/p/two?a=1&b=2" }}">Two</a>',
    );
  });

  it('leaves unsubscribe, privacy, mailto, relative, anchor and template-expression links alone', () => {
    const html = [
      `<a href="${UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe</a>`,
      '<a href="{{ .Subscriber.Attribs.blog0_unsubscribe_url }}">Unsubscribe</a>',
      '<a href="https://blog.test/newsletter/unsubscribe?t=abc">Unsub page</a>',
      '<a href="https://blog.test/api/newsletter/unsubscribe?t=abc">One-click</a>',
      '<a href="https://blog.test/privacy">Privacy</a>',
      '<a href="https://blog.test/privacy/">Privacy</a>',
      '<a href="mailto:hi@blog.test">Mail</a>',
      '<a href="/p/relative">Rel</a>',
      '<a href="#top">Top</a>',
    ].join('\n');
    expect(trackLinks(html)).toBe(html);
  });

  it('is idempotent: no double tagging of TrackLink or @TrackLink hrefs', () => {
    const once = trackLinks('<a href="https://blog.test/p/one">One</a><a href="https://blog.test/p/two@TrackLink">Two</a>');
    expect(once).toBe('<a href="{{ TrackLink "https://blog.test/p/one" }}">One</a><a href="{{ TrackLink "https://blog.test/p/two" }}">Two</a>');
    expect(trackLinks(once)).toBe(once);
    expect(once.match(/TrackLink/g)).toHaveLength(2);
  });

  it('a URL with quotes or braces becomes a valid Go string literal', () => {
    expect(trackLinks('<a href="https://blog.test/s?q=&quot;x&quot;{{y}}">S</a>')).toBe('<a href="{{ TrackLink "https://blog.test/s?q=\\"x\\"{{y}}" }}">S</a>');
  });

  it('does not touch the text outside href attributes (a URL in prose stays as text)', () => {
    const html = '<p>See https://blog.test/p/x for more.</p>';
    expect(trackLinks(html)).toBe(html);
  });
});

describe('toListmonkCampaignBody', () => {
  it('escapes author braces, maps placeholders, and tracks only content links', () => {
    const html = `<h1>{{ x }}</h1><a href="https://blog.test/p/a">A</a> · <a href="${UNSUBSCRIBE_PLACEHOLDER}">Unsubscribe</a> · <a href="https://blog.test/privacy">Privacy</a><p>${CONSENT_PLACEHOLDER}</p>`;
    expect(toListmonkCampaignBody(html)).toBe(
      '<h1>{{ "{{" }} x {{ "}}" }}</h1><a href="{{ TrackLink "https://blog.test/p/a" }}">A</a> · <a href="{{ .Subscriber.Attribs.blog0_unsubscribe_url }}">Unsubscribe</a> · <a href="https://blog.test/privacy">Privacy</a><p>{{ .Subscriber.Attribs.blog0_consent_line }}</p>',
    );
  });
});

describe('ListmonkSender template ensure', () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  function stubFetch(templates: Array<{ id: number; name: string; type: string; body: string }>) {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method ?? 'GET', path, body });
      const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/templates' && init.method === 'GET') return json(templates);
      if (path === '/api/templates' && init.method === 'POST') return json({ id: 9, name: BLOG0_TEMPLATE_NAME, type: 'campaign' });
      if (path.startsWith('/api/templates/') && init.method === 'PUT') return json({ id: Number(path.split('/').pop()), name: BLOG0_TEMPLATE_NAME, type: 'campaign' });
      if (path === '/api/campaigns') return json({ id: 71 });
      return new Response('{}', { status: 404 });
    });
  }

  const sender = () => new ListmonkSender({ url: 'http://listmonk.test:9000', apiUser: 'blog0', apiToken: new Secret('tok'), listId: 3 });
  const issue = { issueId: 'i1', number: 1, subject: 'S', html: '<a href="https://blog.test/p/a">A</a>', text: 'Read: https://blog.test/p/a' };

  it('the template body carries the TrackView pixel after the content', () => {
    expect(BLOG0_TEMPLATE_BODY).toContain('{{ template "content" . }}');
    expect(BLOG0_TEMPLATE_BODY).toContain('{{ TrackView }}');
  });

  it('updates an existing blog0-issue template whose body differs (the pre-tracking body), then reuses it', async () => {
    stubFetch([{ id: 5, name: BLOG0_TEMPLATE_NAME, type: 'campaign', body: '{{ template "content" . }}' }]);
    const s = sender();
    await s.createIssue(issue);
    await s.createIssue(issue);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toEqual([{ method: 'PUT', path: '/api/templates/5', body: { name: BLOG0_TEMPLATE_NAME, type: 'campaign', body: BLOG0_TEMPLATE_BODY } }]);
    expect(calls.filter((c) => c.path === '/api/templates' && c.method === 'GET')).toHaveLength(1);
    const campaigns = calls.filter((c) => c.path === '/api/campaigns');
    expect(campaigns[0]!.body).toMatchObject({ template_id: 5, body: '<a href="{{ TrackLink "https://blog.test/p/a" }}">A</a>', altbody: 'Read: https://blog.test/p/a' });
  });

  it('leaves an up-to-date template alone (idempotent) and creates one when missing', async () => {
    stubFetch([{ id: 5, name: BLOG0_TEMPLATE_NAME, type: 'campaign', body: BLOG0_TEMPLATE_BODY }]);
    await sender().createIssue(issue);
    expect(calls.filter((c) => c.method === 'PUT' || (c.method === 'POST' && c.path === '/api/templates'))).toEqual([]);

    calls.length = 0;
    stubFetch([]);
    await sender().createIssue(issue);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/templates')!.body).toEqual({ name: BLOG0_TEMPLATE_NAME, type: 'campaign', body: BLOG0_TEMPLATE_BODY });
  });
});

describe('toListmonkCampaignBody — author text that looks like a TrackLink action', () => {
  it('is escaped like any other author braces (never executed)', () => {
    expect(toListmonkCampaignBody('<p>{{ TrackLink "https://x.test" }}</p>')).toBe('<p>{{ "{{" }} TrackLink "https://x.test" {{ "}}" }}</p>');
  });
});
