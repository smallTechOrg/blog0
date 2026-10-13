import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ARTICLE_NOT_FOUND_PATH, config, errorCode, proxy, slugFromArticlePath } from '@/proxy';
import { getConfig } from '@/server/config';
import { addLogSink, resetLoggerForTests, type LogLine } from '@/server/log';
import { publishedSlugExists } from '@/server/public/articles';

vi.mock('@/server/public/articles', () => ({ publishedSlugExists: vi.fn() }));
vi.mock('@/server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/config')>()),
  getConfig: vi.fn(() => ({ publicBaseUrl: 'http://localhost:3410' })),
}));

const exists = vi.mocked(publishedSlugExists);
const config$ = vi.mocked(getConfig);

afterEach(() => {
  exists.mockReset();
  vi.unstubAllEnvs();
  config$.mockImplementation(() => ({ publicBaseUrl: 'http://localhost:3410' }) as ReturnType<typeof getConfig>);
  resetLoggerForTests();
});

/** The value of a request header the proxy forwarded to the page (x-middleware-request-<name>). */
function forwarded(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

describe('slugFromArticlePath', () => {
  it('extracts the slug from /p/<slug>', () => {
    expect(slugFromArticlePath('/p/measure-the-work')).toBe('measure-the-work');
  });

  it('extracts the slug from the /tldr share path', () => {
    expect(slugFromArticlePath('/p/measure-the-work/tldr')).toBe('measure-the-work');
  });

  it('extracts the slug from the /listen share path', () => {
    expect(slugFromArticlePath('/p/measure-the-work/listen')).toBe('measure-the-work');
    expect(slugFromArticlePath('/p/measure-the-work/listen/')).toBe('measure-the-work');
    expect(slugFromArticlePath('/p/a/listen/extra')).toBeNull();
  });

  it('accepts a trailing slash on both shapes', () => {
    expect(slugFromArticlePath('/p/measure-the-work/')).toBe('measure-the-work');
    expect(slugFromArticlePath('/p/measure-the-work/tldr/')).toBe('measure-the-work');
  });

  it('percent-decodes the slug, and keeps the raw segment when the encoding is malformed', () => {
    expect(slugFromArticlePath('/p/caf%C3%A9')).toBe('café');
    expect(slugFromArticlePath('/p/bad%E0%A4%A')).toBe('bad%E0%A4%A');
    expect(slugFromArticlePath('/p/%')).toBe('%');
  });

  it('returns null for nested or non-article paths', () => {
    expect(slugFromArticlePath('/p/a/b')).toBeNull();
    expect(slugFromArticlePath('/p/a/tldr/extra')).toBeNull();
    expect(slugFromArticlePath('/p/')).toBeNull();
    expect(slugFromArticlePath('/p')).toBeNull();
    expect(slugFromArticlePath('/archive')).toBeNull();
    expect(slugFromArticlePath('/x/p/slug')).toBeNull();
  });

  it('returns uppercase slugs unchanged (the published-only query then rejects them)', () => {
    expect(slugFromArticlePath('/p/Measure-The-Work')).toBe('Measure-The-Work');
    expect(slugFromArticlePath('/p/ABC/tldr')).toBe('ABC');
  });
});

describe('proxy config', () => {
  it('matches the article, TLDR and Listen share routes, plus every page that is not a prefetch', () => {
    expect(config.matcher.slice(0, 3)).toEqual(['/p/:slug', '/p/:slug/tldr', '/p/:slug/listen']);
    expect(config.matcher[3]).toEqual({
      source: '/((?!api/|_next/|media/|favicon.ico|robots.txt|sitemap.xml).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    });
  });

  it('the page matcher excludes API, Next assets, media and the crawler files', () => {
    const { source } = config.matcher[3] as { source: string };
    const re = new RegExp(`^${source}$`);
    for (const path of ['/', '/archive', '/admin/login', '/admin', '/p/x/listen', '/about']) expect(re.test(path)).toBe(true);
    for (const path of ['/api/health', '/_next/static/chunks/a.js', '/media/abc', '/favicon.ico', '/robots.txt', '/sitemap.xml']) {
      expect(re.test(path)).toBe(false);
    }
  });

  it('rewrites to an internal path no route matches', () => {
    expect(ARTICLE_NOT_FOUND_PATH.startsWith('/_')).toBe(true);
  });
});

describe('errorCode (proxy failure log field)', () => {
  it('uses the driver code when it is a short identifier', () => {
    expect(errorCode(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(errorCode({ code: '28P01' })).toBe('28P01');
  });

  it('falls back to the error class name, never the message text', () => {
    const err = new TypeError('password authentication failed for user "sai" at postgres://sai:secret@db');
    expect(errorCode(err)).toBe('TypeError');
    expect(errorCode(Object.assign(new Error('x'), { code: 'postgres://sai:secret@db:5432/blog0' }))).toBe('Error');
  });

  it('returns "unknown" for non-errors', () => {
    expect(errorCode('boom')).toBe('unknown');
    expect(errorCode(null)).toBe('unknown');
  });
});

describe('proxy', () => {
  it('passes a published slug through untouched', async () => {
    exists.mockResolvedValue(true);
    const res = await proxy(new NextRequest('http://localhost:3410/p/live-piece'));

    expect(exists).toHaveBeenCalledWith('live-piece');
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('rewrites an unknown slug to the internal not-found path', async () => {
    exists.mockResolvedValue(false);
    const res = await proxy(new NextRequest('http://localhost:3410/p/nope/tldr'));

    expect(res.headers.get('x-middleware-rewrite')).toBe(`http://localhost:3410${ARTICLE_NOT_FOUND_PATH}`);
  });

  it('logs a warning without the slug or error text and falls through when the DB check throws', async () => {
    const lines: LogLine[] = [];
    addLogSink((l) => lines.push(l));
    exists.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED postgres://sai:secret@db:5432'), { code: 'ECONNREFUSED' }));

    const res = await proxy(new NextRequest('http://localhost:3410/p/secret-draft-slug/tldr'));

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    const warn = lines.find((l) => l.event === 'proxy.slug_check_failed');
    expect(warn).toMatchObject({ level: 'warn', path: '/p/:slug/tldr', err_code: 'ECONNREFUSED' });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('secret-draft-slug');
    expect(text).not.toContain('ECONNREFUSED postgres');
    expect(text).not.toContain('secret@db');
  });
});

describe('proxy — CSP nonce (production only)', () => {
  it('sends no CSP outside production (dev / designer mode) and does not touch the request', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await proxy(new NextRequest('http://localhost:3410/'));

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect(forwarded(res, 'x-nonce')).toBeNull();
  });

  it('in production puts a fresh nonce on the request and the same CSP on request and response', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const a = await proxy(new NextRequest('http://localhost:3410/'));
    const b = await proxy(new NextRequest('http://localhost:3410/archive'));

    const csp = a.headers.get('content-security-policy')!;
    const nonce = forwarded(a, 'x-nonce')!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(forwarded(a, 'content-security-policy')).toBe(csp);
    expect(forwarded(b, 'x-nonce')).not.toBe(nonce);
    expect(a.headers.get('strict-transport-security')).toBeNull();
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(exists).not.toHaveBeenCalled();
  });

  it('adds HSTS and upgrade-insecure-requests when the public base URL is https', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    config$.mockImplementation(() => ({ publicBaseUrl: 'https://blog0.example' }) as ReturnType<typeof getConfig>);
    const res = await proxy(new NextRequest('https://blog0.example/'));

    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers.get('content-security-policy')).toMatch(/; upgrade-insecure-requests$/);
  });

  it('the article 404 rewrite carries the same nonce headers', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    exists.mockResolvedValue(false);
    const res = await proxy(new NextRequest('http://localhost:3410/p/nope'));

    expect(res.headers.get('x-middleware-rewrite')).toBe(`http://localhost:3410${ARTICLE_NOT_FOUND_PATH}`);
    const nonce = forwarded(res, 'x-nonce')!;
    expect(nonce).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
  });

  it('a published article passes through with the nonce headers', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    exists.mockResolvedValue(true);
    const res = await proxy(new NextRequest('http://localhost:3410/p/live-piece/listen'));

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain(`'nonce-${forwarded(res, 'x-nonce')}'`);
  });
});
